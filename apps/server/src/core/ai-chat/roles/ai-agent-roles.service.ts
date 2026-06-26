import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { AiAgentRoleRepo } from '@docmost/db/repos/ai-agent-roles/ai-agent-roles.repo';
import { AiAgentRole } from '@docmost/db/types/entity.types';
import { CreateAgentRoleDto, UpdateAgentRoleDto } from './dto/agent-role.dto';
import { ImportFromCatalogDto, UpdateFromCatalogDto } from './dto/agent-role-catalog.dto';
import { RoleModelConfig } from './role-model-config';
import { AiAgentRolesCatalogProvider } from './catalog/ai-agent-roles-catalog.provider';
import { CatalogBundleMeta } from './catalog/catalog-types';

/** The `source` jsonb shape that links an imported role to its catalog origin. */
interface RoleSource {
  slug: string;
  language: string;
  version: number;
}

/**
 * Full (admin) view of an agent role. There are no secret columns on this table
 * (the model creds live in ai_provider_credentials, keyed by driver), so the
 * whole row is safe to return — but only to admins, who need `instructions` /
 * `modelConfig` to edit roles on the settings page.
 */
export interface AgentRoleView {
  id: string;
  name: string;
  emoji: string | null;
  description: string | null;
  instructions: string;
  modelConfig: RoleModelConfig | null;
  enabled: boolean;
  autoStart: boolean;
  launchMessage: string | null;
  // Catalog origin of an imported role, or null for a manually-created one. The
  // admin UI uses `version` to offer an UPDATE when the catalog ships a newer
  // revision. Admin-only (deliberately absent from AgentRolePickerView).
  source: { slug: string; language: string; version: number } | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Picker view returned to ordinary (non-admin) members. Only the fields the chat
 * role picker needs — deliberately WITHOUT `instructions`, `modelConfig`,
 * creator or timestamps, so non-admins never receive the admin-authored prompt
 * or the model override.
 *
 * `autoStart` / `launchMessage` ARE included (unlike instructions/modelConfig):
 * the client needs them to decide whether and what to auto-send when a role card
 * is picked. `launchMessage` is sent verbatim as a normal user message — it is
 * not a secret, so exposing it to members is intentional.
 */
export interface AgentRolePickerView {
  id: string;
  name: string;
  emoji: string | null;
  description: string | null;
  enabled: boolean;
  autoStart: boolean;
  launchMessage: string | null;
}

/**
 * Admin business logic for agent roles: workspace-scoped CRUD with validation.
 * A role only shapes the system-prompt persona + an optional model override; it
 * never changes the toolset or the CASL boundary.
 */
@Injectable()
export class AiAgentRolesService {
  constructor(
    private readonly repo: AiAgentRoleRepo,
    private readonly catalog: AiAgentRolesCatalogProvider,
  ) {}

  /**
   * List the workspace's roles. Admins get the full view (the settings page needs
   * `instructions` / `modelConfig`); ordinary members get only the picker fields,
   * so the admin-authored prompt and model override never leak to non-admins.
   */
  async list(
    workspaceId: string,
    isAdmin: boolean,
  ): Promise<AgentRoleView[] | AgentRolePickerView[]> {
    const rows = await this.repo.listByWorkspace(workspaceId);
    return isAdmin
      ? rows.map((r) => this.toView(r))
      : rows.map((r) => this.toPickerView(r));
  }

  async create(
    workspaceId: string,
    creatorId: string,
    dto: CreateAgentRoleDto,
  ): Promise<AgentRoleView> {
    const name = (dto.name ?? '').trim();
    const instructions = (dto.instructions ?? '').trim();
    if (!name) throw new BadRequestException('Role name is required');
    if (!instructions) {
      throw new BadRequestException('Role instructions are required');
    }
    const modelConfig = normalizeModelConfig(dto.modelConfig);

    try {
      const row = await this.repo.insert({
        workspaceId,
        creatorId,
        name,
        emoji: emptyToNull(dto.emoji),
        description: emptyToNull(dto.description),
        instructions,
        modelConfig: modelConfig as Record<string, unknown> | null,
        enabled: dto.enabled ?? true,
        autoStart: dto.autoStart ?? true,
        // Empty/whitespace-only => null (client default launch message).
        launchMessage: emptyToNull(dto.launchMessage),
      });
      return this.toView(row);
    } catch (err) {
      throw rethrowDuplicateName(err, name);
    }
  }

  async update(
    workspaceId: string,
    id: string,
    dto: UpdateAgentRoleDto,
  ): Promise<AgentRoleView> {
    const existing = await this.repo.findById(id, workspaceId);
    if (!existing) throw new BadRequestException('Role not found');

    // Validate non-empty only when the field is actually being changed.
    if (dto.name !== undefined && dto.name.trim().length === 0) {
      throw new BadRequestException('Role name cannot be empty');
    }
    if (dto.instructions !== undefined && dto.instructions.trim().length === 0) {
      throw new BadRequestException('Role instructions cannot be empty');
    }

    try {
      await this.repo.update(id, workspaceId, {
        name: dto.name?.trim(),
        // undefined => unchanged; '' => clear to null.
        emoji: dto.emoji === undefined ? undefined : emptyToNull(dto.emoji),
        description:
          dto.description === undefined
            ? undefined
            : emptyToNull(dto.description),
        instructions: dto.instructions?.trim(),
        // undefined => unchanged; null => clear; object => normalize + set.
        modelConfig:
          dto.modelConfig === undefined
            ? undefined
            : (normalizeModelConfig(dto.modelConfig) as
                | Record<string, unknown>
                | null),
        enabled: dto.enabled,
        autoStart: dto.autoStart,
        // undefined => unchanged; '' => clear to null.
        launchMessage:
          dto.launchMessage === undefined
            ? undefined
            : emptyToNull(dto.launchMessage),
      });
    } catch (err) {
      throw rethrowDuplicateName(err, dto.name?.trim() || existing.name);
    }

    const updated = await this.repo.findById(id, workspaceId);
    // The role may be soft-deleted concurrently between the UPDATE and this
    // re-fetch; fail with a clear 400 instead of dereferencing undefined.
    if (!updated) throw new BadRequestException('Role not found');
    return this.toView(updated);
  }

  async remove(workspaceId: string, id: string): Promise<{ success: true }> {
    const existing = await this.repo.findById(id, workspaceId);
    if (!existing) throw new BadRequestException('Role not found');
    await this.repo.softDelete(id, workspaceId);
    return { success: true };
  }

  // -------------------------------------------------------------------------
  // Catalog (admin-only). The catalog is curated, untrusted JSON fetched +
  // validated by AiAgentRolesCatalogProvider; this layer resolves localized
  // text and reconciles a bundle against the workspace's existing roles.
  // -------------------------------------------------------------------------

  /**
   * Browse the catalog. Returns the union of every bundle's languages (sorted)
   * plus per-bundle metadata with `name` / `description` resolved to the
   * requested `language` (fallback: 'en', then the first available locale).
   */
  async getCatalog(language?: string): Promise<{
    languages: string[];
    bundles: {
      id: string;
      name: string;
      description: string | null;
      languages: string[];
      roles: { slug: string; version: number }[];
    }[];
  }> {
    const index = await this.catalog.fetchIndex();
    const languages = Array.from(
      new Set(index.bundles.flatMap((b) => b.languages)),
    ).sort();
    const bundles = index.bundles.map((b) => ({
      id: b.id,
      name: localized(b.name, language) ?? b.id,
      description: b.description ? localized(b.description, language) : null,
      languages: b.languages,
      roles: b.roles.map((r) => ({ slug: r.slug, version: r.version })),
    }));
    return { languages, bundles };
  }

  /**
   * Open one bundle in a language: returns each role's content plus the version
   * taken from the index (so the client can compare against an imported role's
   * source.version). A missing bundle/language => BadGateway (catalog issue).
   */
  async getCatalogBundle(
    bundleId: string,
    language: string,
  ): Promise<{
    bundleId: string;
    language: string;
    roles: {
      slug: string;
      emoji: string | null;
      name: string;
      description: string | null;
      instructions: string;
      autoStart: boolean;
      launchMessage: string | null;
      version: number;
    }[];
  }> {
    const index = await this.catalog.fetchIndex();
    const meta = index.bundles.find((b) => b.id === bundleId);
    if (!meta) {
      throw new BadGatewayException('Catalog bundle not found');
    }
    const file = await this.catalog.fetchBundle(bundleId, language);
    const versions = versionMap(meta);
    return {
      bundleId,
      language,
      roles: file.roles.map((r) => ({
        slug: r.slug,
        emoji: r.emoji ?? null,
        name: r.name,
        description: r.description ?? null,
        instructions: r.instructions,
        autoStart: r.autoStart ?? true,
        launchMessage: r.launchMessage ?? null,
        version: versions.get(r.slug) ?? 1,
      })),
    };
  }

  /**
   * Import a bundle's roles into the workspace. Roles whose `source.slug` is
   * already installed are skipped (updates are a separate action). A name
   * collision with an existing role is either skipped or imported under a free
   * " (N)" name, per `dto.conflict`. Inserts run sequentially (the repo exposes
   * no batch insert and the volume is tiny); a unique-name race still surfaces
   * as an error entry rather than aborting the whole import.
   */
  async importFromCatalog(
    workspaceId: string,
    creatorId: string,
    dto: ImportFromCatalogDto,
  ): Promise<{
    created: number;
    skipped: number;
    renamed: number;
    errors: { slug: string; message: string }[];
  }> {
    const index = await this.catalog.fetchIndex();
    const meta = index.bundles.find((b) => b.id === dto.bundleId);
    if (!meta) {
      throw new BadGatewayException('Catalog bundle not found');
    }
    const file = await this.catalog.fetchBundle(dto.bundleId, dto.language);
    const versions = versionMap(meta);

    const errors: { slug: string; message: string }[] = [];

    // Resolve the selected catalog roles (honor dto.slugs; flag unknown ones).
    let selected = file.roles;
    if (dto.slugs && dto.slugs.length > 0) {
      const wanted = new Set(dto.slugs);
      const present = new Set(file.roles.map((r) => r.slug));
      for (const slug of dto.slugs) {
        if (!present.has(slug)) {
          errors.push({ slug, message: 'Role not found in catalog bundle' });
        }
      }
      selected = file.roles.filter((r) => wanted.has(r.slug));
    }

    const existingRoles = await this.repo.listByWorkspace(workspaceId);
    // Catalog roles already installed in this workspace, keyed by slug+language
    // (skip; never duplicate). The key MUST match the client install-state and
    // updateFromCatalog (both match by source.slug AND source.language): the
    // `ru` variant of a slug already installed as `en` is a separate install.
    const installedKeys = new Set(
      existingRoles
        .map((r) => roleSource(r))
        .filter((s): s is RoleSource => s !== null)
        .map((s) => `${s.slug}:${s.language}`),
    );
    // Live role names (lowercased) for collision detection. Mutated as we
    // insert so two imported roles cannot both grab the same name.
    const takenNames = new Set(
      existingRoles.map((r) => r.name.trim().toLowerCase()),
    );

    let created = 0;
    let skipped = 0;
    let renamed = 0;

    for (const role of selected) {
      // Already installed from the catalog in THIS language => skip (use
      // update-from-catalog). A different language of the same slug still imports.
      const installKey = `${role.slug}:${dto.language}`;
      if (installedKeys.has(installKey)) {
        skipped++;
        continue;
      }

      let name = role.name.trim();
      let didRename = false;
      if (takenNames.has(name.toLowerCase())) {
        if (dto.conflict === 'skip') {
          skipped++;
          continue;
        }
        // conflict === 'rename': find a free " (N)" suffix.
        name = freeName(name, takenNames);
        didRename = true;
      }

      const version = versions.get(role.slug) ?? 1;
      try {
        await this.repo.insert({
          workspaceId,
          creatorId,
          name,
          emoji: emptyToNull(role.emoji),
          description: emptyToNull(role.description),
          instructions: role.instructions,
          modelConfig: normalizeModelConfig(role.modelConfig) as
            | Record<string, unknown>
            | null,
          enabled: true,
          autoStart: role.autoStart ?? true,
          launchMessage: emptyToNull(role.launchMessage ?? undefined),
          source: { slug: role.slug, language: dto.language, version },
        });
        created++;
        if (didRename) renamed++;
        takenNames.add(name.toLowerCase());
        installedKeys.add(installKey);
      } catch (err) {
        errors.push({ slug: role.slug, message: importErrorMessage(err) });
      }
    }

    return { created, skipped, renamed, errors };
  }

  /**
   * Update an already-imported role from its catalog source when the catalog
   * ships a newer version. Returns a discriminated result so the UI can explain
   * a no-op (up-to-date / removed from catalog / language no longer offered).
   * Never touches `enabled`; keeps the current name if the catalog's new name
   * would collide with another role (avoiding the unique-name 409).
   */
  async updateFromCatalog(
    workspaceId: string,
    dto: UpdateFromCatalogDto,
  ): Promise<
    | { updated: false; reason: 'not-in-catalog' | 'up-to-date' | 'language-unavailable' }
    | { updated: true; fromVersion: number; toVersion: number; role: AgentRoleView }
  > {
    const role = await this.repo.findById(dto.id, workspaceId);
    if (!role) throw new BadRequestException('Role not found');

    const source = roleSource(role);
    if (!source || !source.slug) {
      throw new BadRequestException('Role was not imported from the catalog');
    }

    const index = await this.catalog.fetchIndex();
    // Find the bundle whose meta lists this slug, and its catalog version.
    let meta: CatalogBundleMeta | undefined;
    let currentVersion: number | undefined;
    for (const b of index.bundles) {
      const m = b.roles.find((r) => r.slug === source.slug);
      if (m) {
        meta = b;
        currentVersion = m.version;
        break;
      }
    }
    if (!meta || currentVersion === undefined) {
      return { updated: false, reason: 'not-in-catalog' };
    }
    if (currentVersion <= source.version) {
      return { updated: false, reason: 'up-to-date' };
    }
    if (!meta.languages.includes(source.language)) {
      return { updated: false, reason: 'language-unavailable' };
    }

    const file = await this.catalog.fetchBundle(meta.id, source.language);
    const fresh = file.roles.find((r) => r.slug === source.slug);
    if (!fresh) {
      return { updated: false, reason: 'not-in-catalog' };
    }

    // Keep the current name when the catalog's new name would collide with
    // another live role (avoids the unique-name 409). Same-name (case-insensitive)
    // means "no rename needed".
    const newName = fresh.name.trim();
    let name = newName;
    if (newName.toLowerCase() !== role.name.trim().toLowerCase()) {
      const others = await this.repo.listByWorkspace(workspaceId);
      const collision = others.some(
        (r) =>
          r.id !== role.id &&
          r.name.trim().toLowerCase() === newName.toLowerCase(),
      );
      if (collision) name = role.name;
    }

    await this.repo.update(dto.id, workspaceId, {
      name,
      emoji: emptyToNull(fresh.emoji),
      description: emptyToNull(fresh.description),
      instructions: fresh.instructions,
      modelConfig: normalizeModelConfig(fresh.modelConfig) as
        | Record<string, unknown>
        | null,
      autoStart: fresh.autoStart ?? true,
      launchMessage: emptyToNull(fresh.launchMessage ?? undefined),
      // enabled is deliberately NOT changed.
      source: {
        slug: source.slug,
        language: source.language,
        version: currentVersion,
      },
    });

    const updated = await this.repo.findById(dto.id, workspaceId);
    if (!updated) throw new BadRequestException('Role not found');
    return {
      updated: true,
      fromVersion: source.version,
      toVersion: currentVersion,
      role: this.toView(updated),
    };
  }

  private toView(row: AiAgentRole): AgentRoleView {
    return {
      id: row.id,
      name: row.name,
      emoji: row.emoji ?? null,
      description: row.description ?? null,
      instructions: row.instructions,
      modelConfig: (row.modelConfig ?? null) as RoleModelConfig | null,
      enabled: row.enabled,
      autoStart: row.autoStart,
      launchMessage: row.launchMessage ?? null,
      source: (row.source ?? null) as AgentRoleView['source'],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Non-admin picker view: id/name/emoji/description/enabled plus the auto-start
   * fields the client needs to decide whether/what to send on role pick. Still
   * WITHOUT instructions/modelConfig (admin-only).
   */
  private toPickerView(row: AiAgentRole): AgentRolePickerView {
    return {
      id: row.id,
      name: row.name,
      emoji: row.emoji ?? null,
      description: row.description ?? null,
      enabled: row.enabled,
      autoStart: row.autoStart,
      launchMessage: row.launchMessage ?? null,
    };
  }
}

/**
 * Map a Postgres unique-violation (the partial `(workspace_id, name)` index) to a
 * friendly 409 ConflictException. Any other error is re-thrown untouched so real
 * failures keep surfacing as 500s.
 */
function rethrowDuplicateName(err: unknown, name: string): never {
  if (
    err &&
    typeof err === 'object' &&
    (err as { code?: unknown }).code === '23505'
  ) {
    throw new ConflictException(
      `A role named "${name}" already exists in this workspace.`,
    );
  }
  throw err;
}

/** '' / whitespace-only / undefined / null => null; otherwise the trimmed value. */
function emptyToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Read + shape-check a role's `source` jsonb into a RoleSource, or null. */
function roleSource(role: AiAgentRole): RoleSource | null {
  const s = role.source as unknown;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  const obj = s as Record<string, unknown>;
  if (typeof obj.slug !== 'string') return null;
  if (typeof obj.language !== 'string') return null;
  if (typeof obj.version !== 'number') return null;
  return { slug: obj.slug, language: obj.language, version: obj.version };
}

/** slug -> version map from a bundle's index metadata. */
function versionMap(meta: CatalogBundleMeta): Map<string, number> {
  return new Map(meta.roles.map((r) => [r.slug, r.version]));
}

/**
 * Resolve a localized value `{ en, ru, ... }` to `language`, falling back to
 * 'en', then the first available locale. Returns null only for an empty map.
 */
function localized(
  map: Record<string, string>,
  language?: string,
): string | null {
  if (language && typeof map[language] === 'string') return map[language];
  if (typeof map.en === 'string') return map.en;
  const first = Object.values(map)[0];
  return typeof first === 'string' ? first : null;
}

/**
 * Find a free display name by appending " (2)", " (3)", ... when `base` is
 * already taken (case-insensitive against `taken`). Caller adds the result to
 * `taken` after a successful insert.
 */
function freeName(base: string, taken: Set<string>): string {
  let n = 2;
  // Cap the search defensively; the loop always terminates well before this.
  while (n < 1000) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
    n++;
  }
  return `${base} (${Date.now()})`;
}

/** A short, safe message for an import insert failure (409 vs other). */
function importErrorMessage(err: unknown): string {
  if (
    err &&
    typeof err === 'object' &&
    (err as { code?: unknown }).code === '23505'
  ) {
    return 'A role with this name already exists';
  }
  return 'Failed to import role';
}

/**
 * Normalize an incoming modelConfig DTO to the persisted shape, or null when
 * there is no usable override (no driver and no chatModel). The DTO's @IsIn
 * already restricts `driver` to a supported value.
 */
function normalizeModelConfig(
  cfg: { driver?: string; chatModel?: string } | null | undefined,
): RoleModelConfig | null {
  if (!cfg) return null;
  const driver = cfg.driver;
  const chatModel =
    typeof cfg.chatModel === 'string' && cfg.chatModel.trim().length > 0
      ? cfg.chatModel.trim()
      : undefined;
  if (!driver && !chatModel) return null;
  const out: RoleModelConfig = {};
  if (driver) out.driver = driver as RoleModelConfig['driver'];
  if (chatModel) out.chatModel = chatModel;
  return out;
}
