import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { AiAgentRoleRepo } from '@docmost/db/repos/ai-agent-roles/ai-agent-roles.repo';
import { AiAgentRole } from '@docmost/db/types/entity.types';
import { CreateAgentRoleDto, UpdateAgentRoleDto } from './dto/agent-role.dto';
import { RoleModelConfig } from './role-model-config';

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
  constructor(private readonly repo: AiAgentRoleRepo) {}

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

/** '' / whitespace-only / undefined => null; otherwise the trimmed value. */
function emptyToNull(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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
