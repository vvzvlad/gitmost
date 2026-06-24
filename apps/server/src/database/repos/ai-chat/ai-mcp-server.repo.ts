import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB, KyselyTransaction } from '../../types/kysely.types';
import { dbOrTx } from '../../utils';
import { AiMcpServer } from '@docmost/db/types/entity.types';

/**
 * Repository for per-workspace external MCP servers the agent may use (§5.4).
 *
 * SECURITY (§8.10): rows hold the encrypted auth-header blob (`headersEnc`).
 * That column must NEVER be returned to a non-admin path nor logged; the admin
 * controller projects an explicit allowlist of columns and the connect path
 * decrypts only server-side. All lookups are workspace-scoped.
 */
@Injectable()
export class AiMcpServerRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async findById(
    id: string,
    workspaceId: string,
  ): Promise<AiMcpServer | undefined> {
    const row = await this.db
      .selectFrom('aiMcpServers')
      .selectAll('aiMcpServers')
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
    return row ? normalizeRow(row) : row;
  }

  async listByWorkspace(workspaceId: string): Promise<AiMcpServer[]> {
    const rows = await this.db
      .selectFrom('aiMcpServers')
      .selectAll('aiMcpServers')
      .where('workspaceId', '=', workspaceId)
      .orderBy('createdAt', 'asc')
      .execute();
    return rows.map(normalizeRow);
  }

  /** Enabled servers only — used by the agent loop to build the toolset. */
  async listEnabled(workspaceId: string): Promise<AiMcpServer[]> {
    const rows = await this.db
      .selectFrom('aiMcpServers')
      .selectAll('aiMcpServers')
      .where('workspaceId', '=', workspaceId)
      .where('enabled', '=', true)
      .orderBy('createdAt', 'asc')
      .execute();
    return rows.map(normalizeRow);
  }

  async insert(
    values: {
      workspaceId: string;
      name: string;
      transport: string;
      url: string;
      headersEnc?: string | null;
      toolAllowlist?: string[] | null;
      enabled?: boolean;
    },
    trx?: KyselyTransaction,
  ): Promise<AiMcpServer> {
    const db = dbOrTx(this.db, trx);
    return db
      .insertInto('aiMcpServers')
      .values({
        workspaceId: values.workspaceId,
        name: values.name,
        transport: values.transport,
        url: values.url,
        headersEnc: values.headersEnc ?? null,
        // jsonb column: the postgres driver would otherwise encode a JS array as
        // a Postgres array literal. Bind the JSON text and cast it to jsonb.
        toolAllowlist: jsonbArray(values.toolAllowlist),
        enabled: values.enabled ?? true,
      })
      .returningAll()
      .executeTakeFirst();
  }

  async update(
    id: string,
    workspaceId: string,
    patch: {
      name?: string;
      transport?: string;
      url?: string;
      // undefined => leave unchanged; null => clear; string => set.
      headersEnc?: string | null;
      // undefined => leave unchanged; null => clear; string[] => set.
      toolAllowlist?: string[] | null;
      enabled?: boolean;
    },
    trx?: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.transport !== undefined) set.transport = patch.transport;
    if (patch.url !== undefined) set.url = patch.url;
    if (patch.headersEnc !== undefined) set.headersEnc = patch.headersEnc;
    if (patch.toolAllowlist !== undefined) {
      set.toolAllowlist = jsonbArray(patch.toolAllowlist);
    }
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    await db
      .updateTable('aiMcpServers')
      .set(set)
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
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
      .execute();
  }
}

/**
 * Encode a string[] as a jsonb bind for the `tool_allowlist` column. Passing a
 * plain JS array to the postgres driver would serialize it as a Postgres array
 * literal (incompatible with jsonb), so we bind the JSON text and cast it.
 *
 * The cast is `::text::jsonb`, NOT `::jsonb`: if the parameter is bound straight
 * to a jsonb cast, node-postgres infers its type as jsonb and JSON-stringifies
 * the (already-JSON) string a SECOND time, so the column ends up holding a jsonb
 * STRING SCALAR (`"[\"a\"]"`) instead of a jsonb ARRAY. Forcing the param through
 * `::text` first binds it as text (sent verbatim), and `::jsonb` then parses it
 * into a real array. (`normalizeRow` below repairs rows written the old way.)
 *
 * Returns null for null/empty arrays (an empty allowlist means "no restriction"
 * is not intended — callers pass null to clear; an empty array is normalized to
 * null here so it never round-trips as `[]`).
 */
function jsonbArray(value: string[] | null | undefined) {
  if (value === null || value === undefined || value.length === 0) {
    return null;
  }
  // Typed as string[] so it is assignable to the toolAllowlist column.
  return sql<string[]>`${JSON.stringify(value)}::text::jsonb`;
}

/**
 * Parse the `toolAllowlist` value read from the DB into the `string[] | null`
 * the entity type promises. The jsonb column historically round-trips as a JSON
 * STRING (rows written by the old double-encoding `jsonbArray`, see above), so
 * the driver hands back a string like `'["a","b"]'` rather than an array. Be
 * tolerant: an already-parsed array passes through; a JSON string is parsed; null
 * / a non-array / unparseable value becomes null (unrestricted).
 */
export function parseToolAllowlist(value: unknown): string[] | null {
  if (value == null) return null;
  if (Array.isArray(value)) {
    return value.every((v) => typeof v === 'string') ? (value as string[]) : null;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) &&
        parsed.every((v) => typeof v === 'string')
        ? (parsed as string[])
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Normalize a DB row so `toolAllowlist` is always `string[] | null`. */
function normalizeRow(row: AiMcpServer): AiMcpServer {
  return { ...row, toolAllowlist: parseToolAllowlist(row.toolAllowlist) };
}
