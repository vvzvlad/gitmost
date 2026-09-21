import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB, KyselyTransaction } from '../../types/kysely.types';
import { dbOrTx, jsonbBind, parseJsonbValue } from '../../utils';
import { AiMcpServer } from '@docmost/db/types/entity.types';

const logger = new Logger('AiMcpServerRepo');

/**
 * Repository for external MCP servers the agent may use (§5.4).
 *
 * Two ownership scopes share this one table (#686), distinguished by `user_id`:
 *   - `user_id IS NULL`  => an ADMIN / workspace-managed server.
 *   - `user_id = <uuid>` => a PERSONAL server owned by that member.
 *
 * THE REPO IS THE ISOLATION BARRIER. The admin service's `remove` has no
 * pre-check, so every ADMIN method below is scoped `user_id IS NULL` — an admin
 * can never read, update or delete a personal row through the admin path. The
 * personal methods are symmetrically scoped to a single `user_id`. Only the
 * agent-union read (`listEnabledForAgent`) and the scope-agnostic recovery
 * re-read (`findByIdRaw`) intentionally cross the boundary.
 *
 * SECURITY (§8.10): rows hold the encrypted auth-header blob (`headersEnc`).
 * That column must NEVER be returned to a non-admin path nor logged; the
 * controllers project an explicit allowlist of columns and the connect path
 * decrypts only server-side. All lookups are workspace-scoped.
 */
@Injectable()
export class AiMcpServerRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  // --- Admin scope (user_id IS NULL) -----------------------------------------

  async findById(
    id: string,
    workspaceId: string,
  ): Promise<AiMcpServer | undefined> {
    const row = await this.db
      .selectFrom('aiMcpServers')
      .selectAll('aiMcpServers')
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      // ISOLATION (#686): admin path never touches a personal row.
      .where('userId', 'is', null)
      .executeTakeFirst();
    return row ? normalizeRow(row) : row;
  }

  async listByWorkspace(workspaceId: string): Promise<AiMcpServer[]> {
    const rows = await this.db
      .selectFrom('aiMcpServers')
      .selectAll('aiMcpServers')
      .where('workspaceId', '=', workspaceId)
      // ISOLATION (#686): admin list shows workspace-managed servers only.
      .where('userId', 'is', null)
      .orderBy('createdAt', 'asc')
      .execute();
    return rows.map(normalizeRow);
  }

  /**
   * Enabled ADMIN servers only. Retained for the admin-only paths; the agent
   * loop builds its toolset from `listEnabledForAgent` (admin ∪ personal).
   */
  async listEnabled(workspaceId: string): Promise<AiMcpServer[]> {
    const rows = await this.db
      .selectFrom('aiMcpServers')
      .selectAll('aiMcpServers')
      .where('workspaceId', '=', workspaceId)
      .where('enabled', '=', true)
      // ISOLATION (#686): admin scope only.
      .where('userId', 'is', null)
      .orderBy('createdAt', 'asc')
      .execute();
    return rows.map(normalizeRow);
  }

  /**
   * The agent-union read (#686): every ENABLED server the run's user may use —
   * the workspace's admin servers PLUS the calling user's own personal servers.
   *
   * Ordering is ADMIN-FIRST and deterministic: `(user_id IS NOT NULL) ASC`
   * places admin rows (false) ahead of personal rows (true); within each scope,
   * `created_at ASC` then `id ASC` (a stable tiebreaker for equal timestamps)
   * so tool-name disambiguation is reproducible across calls.
   */
  async listEnabledForAgent(
    workspaceId: string,
    userId: string,
  ): Promise<AiMcpServer[]> {
    const rows = await this.db
      .selectFrom('aiMcpServers')
      .selectAll('aiMcpServers')
      .where('workspaceId', '=', workspaceId)
      .where('enabled', '=', true)
      .where((eb) =>
        eb.or([eb('userId', 'is', null), eb('userId', '=', userId)]),
      )
      // Admin-first: NULL owner (false) sorts before a personal owner (true).
      .orderBy(sql`("user_id" is not null)`, 'asc')
      .orderBy('createdAt', 'asc')
      .orderBy('id', 'asc')
      .execute();
    return rows.map(normalizeRow);
  }

  /**
   * Scope-agnostic single-row read (#686) — NO workspace/user filter. Used ONLY
   * by the Phase-3 cache recovery re-read to re-validate a cached client against
   * the live row (still present? still enabled? updatedAt unchanged?). Do NOT
   * use it on any admin/personal management path — those must stay scoped.
   */
  async findByIdRaw(id: string): Promise<AiMcpServer | undefined> {
    const row = await this.db
      .selectFrom('aiMcpServers')
      .selectAll('aiMcpServers')
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? normalizeRow(row) : row;
  }

  async insert(
    values: {
      workspaceId: string;
      // #686: owner of a personal server; omit / null for an admin server.
      userId?: string | null;
      name: string;
      transport: string;
      url: string;
      headersEnc?: string | null;
      toolAllowlist?: string[] | null;
      // Admin-authored prompt guidance; blank/whitespace normalizes to null.
      instructions?: string | null;
      enabled?: boolean;
    },
    trx?: KyselyTransaction,
  ): Promise<AiMcpServer> {
    const db = dbOrTx(this.db, trx);
    return db
      .insertInto('aiMcpServers')
      .values({
        workspaceId: values.workspaceId,
        userId: values.userId ?? null,
        name: values.name,
        transport: values.transport,
        url: values.url,
        headersEnc: values.headersEnc ?? null,
        // jsonb column: the postgres driver would otherwise encode a JS array as
        // a Postgres array literal. Bind the JSON text and cast it to jsonb.
        // preserveEmpty (#476): `[]` is a real value here (deny-all), distinct
        // from null ("no restriction") — it must round-trip as `[]`, not null.
        toolAllowlist: jsonbBind(values.toolAllowlist, { preserveEmpty: true }),
        // Plain text column: blank/whitespace-only guidance is stored as null.
        instructions: blankToNull(values.instructions),
        enabled: values.enabled ?? true,
      })
      .returningAll()
      .executeTakeFirst();
  }

  async update(
    id: string,
    workspaceId: string,
    patch: McpServerPatch,
    trx?: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    await db
      .updateTable('aiMcpServers')
      .set(buildUpdateSet(patch))
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      // ISOLATION (#686): admin update can never mutate a personal row.
      .where('userId', 'is', null)
      .execute();
  }

  async delete(
    id: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    await db
      .deleteFrom('aiMcpServers')
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      // ISOLATION (#686): admin delete can never remove a personal row.
      .where('userId', 'is', null)
      .execute();
  }

  // --- Personal scope (user_id = <owner>) ------------------------------------

  /** A single personal server owned by `userId` in this workspace. */
  async findByIdForUser(
    id: string,
    workspaceId: string,
    userId: string,
  ): Promise<AiMcpServer | undefined> {
    const row = await this.db
      .selectFrom('aiMcpServers')
      .selectAll('aiMcpServers')
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('userId', '=', userId)
      .executeTakeFirst();
    return row ? normalizeRow(row) : row;
  }

  /** All of a user's personal servers in this workspace (enabled or not). */
  async listByUser(
    workspaceId: string,
    userId: string,
  ): Promise<AiMcpServer[]> {
    const rows = await this.db
      .selectFrom('aiMcpServers')
      .selectAll('aiMcpServers')
      .where('workspaceId', '=', workspaceId)
      .where('userId', '=', userId)
      .orderBy('createdAt', 'asc')
      .execute();
    return rows.map(normalizeRow);
  }

  async updateForUser(
    id: string,
    workspaceId: string,
    userId: string,
    patch: McpServerPatch,
    trx?: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    await db
      .updateTable('aiMcpServers')
      .set(buildUpdateSet(patch))
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      // Scope to the owner: a user can only mutate their OWN personal rows.
      .where('userId', '=', userId)
      .execute();
  }

  async deleteForUser(
    id: string,
    workspaceId: string,
    userId: string,
    trx?: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    await db
      .deleteFrom('aiMcpServers')
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      // Scope to the owner: a user can only delete their OWN personal rows.
      .where('userId', '=', userId)
      .execute();
  }

  /**
   * Count a user's personal servers (#686 per-user cap enforcement). A user
   * belongs to exactly one workspace, so `user_id` alone scopes the count. Pass
   * the create transaction so the count runs under the row lock taken by
   * `lockUserRow` (a consistent count-then-insert against the cap).
   */
  async countByUser(userId: string, trx?: KyselyTransaction): Promise<number> {
    const db = dbOrTx(this.db, trx);
    const row = await db
      .selectFrom('aiMcpServers')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('userId', '=', userId)
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  /**
   * Serialize concurrent personal-create transactions for a user (#686). Takes
   * `FOR NO KEY UPDATE` on the user's OWN row in `users` — a single, always-
   * present parent row — so two concurrent creates cannot both read a count
   * below the cap and both insert (locking the ai_mcp_servers rows themselves
   * would not close that gap at count 0). Must run inside the create's
   * transaction, BEFORE `countByUser`.
   */
  async lockUserRow(userId: string, trx: KyselyTransaction): Promise<void> {
    await trx
      .selectFrom('users')
      .select('id')
      .where('id', '=', userId)
      .forNoKeyUpdate()
      .executeTakeFirst();
  }
}

/** Patch shape shared by the admin `update` and the personal `updateForUser`. */
interface McpServerPatch {
  name?: string;
  transport?: string;
  url?: string;
  // undefined => leave unchanged; null => clear; string => set.
  headersEnc?: string | null;
  // undefined => leave unchanged; null => clear; string[] => set.
  toolAllowlist?: string[] | null;
  // undefined => leave unchanged; null/blank => clear; string => set.
  instructions?: string | null;
  enabled?: boolean;
}

/**
 * Build the `SET` map for an update from a partial patch (shared by admin and
 * personal updates so the null-vs-undefined and jsonb/blank normalization rules
 * stay identical on both paths). Always bumps `updatedAt`.
 */
function buildUpdateSet(patch: McpServerPatch): Record<string, unknown> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.transport !== undefined) set.transport = patch.transport;
  if (patch.url !== undefined) set.url = patch.url;
  if (patch.headersEnc !== undefined) set.headersEnc = patch.headersEnc;
  if (patch.toolAllowlist !== undefined) {
    // preserveEmpty (#476): see insert — `[]` (deny-all) must not become null.
    set.toolAllowlist = jsonbBind(patch.toolAllowlist, {
      preserveEmpty: true,
    });
  }
  if (patch.instructions !== undefined) {
    // Blank/whitespace-only guidance clears the column (stored as null).
    set.instructions = blankToNull(patch.instructions);
  }
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  return set;
}

/**
 * Normalize an optional free-text field to a stored value: a missing/blank/
 * whitespace-only string becomes null (so an "empty" guide is never persisted),
 * any other string is trimmed. Returns null for null/undefined input.
 */
export function blankToNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Parse the `toolAllowlist` value read from the DB into the `string[] | null`
 * the entity type promises. The jsonb column historically round-trips as a JSON
 * STRING (rows written by the old double-encoding bind before the `::text::jsonb`
 * fix), so the driver hands back a string like `'["a","b"]'` rather than an
 * array. Be tolerant: normalize a JSON string to its value, then accept it only
 * if it is an array of strings; null / a non-array / unparseable value / an
 * array with a non-string element all become null. NOTE: null here only means
 * "could not parse" — the null-vs-deny-all policy decision lives in
 * normalizeRow (#476: present-but-corrupt fails CLOSED to `[]`).
 */
export function parseToolAllowlist(value: unknown): string[] | null {
  // Shape guard only; the legacy double-encoding self-heal lives in
  // parseJsonbValue (database/utils.ts).
  return parseJsonbValue(
    value,
    (v): v is string[] =>
      Array.isArray(v) && v.every((x) => typeof x === 'string'),
  );
}

/**
 * Normalize a DB row so `toolAllowlist` is always `string[] | null`.
 *
 * FAIL-CLOSED (#476): a stored value that is PRESENT but cannot be parsed into
 * a string[] (corrupt JSON, a non-array, non-string elements) degrades to `[]`
 * = deny-all, so a corrupted allowlist can never silently widen to "the agent
 * gets ALL of the server's tools" (the old fail-open null). An error line is
 * logged (server id only, never the contents) so the admin can repair the row.
 * A column that is truly NULL/absent stays `null` = "no restriction".
 */
function normalizeRow(row: AiMcpServer): AiMcpServer {
  const parsed = parseToolAllowlist(row.toolAllowlist);
  if (parsed === null && row.toolAllowlist != null) {
    logger.error(
      `Corrupt tool_allowlist for MCP server ${row.id}; failing closed (NO tools allowed) — re-save the server's allowlist to repair it`,
    );
    return { ...row, toolAllowlist: [] };
  }
  return { ...row, toolAllowlist: parsed };
}
