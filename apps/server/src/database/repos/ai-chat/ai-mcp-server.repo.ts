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
    return this.db
      .selectFrom('aiMcpServers')
      .selectAll('aiMcpServers')
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
  }

  async listByWorkspace(workspaceId: string): Promise<AiMcpServer[]> {
    return this.db
      .selectFrom('aiMcpServers')
      .selectAll('aiMcpServers')
      .where('workspaceId', '=', workspaceId)
      .orderBy('createdAt', 'asc')
      .execute();
  }

  /** Enabled servers only — used by the agent loop to build the toolset. */
  async listEnabled(workspaceId: string): Promise<AiMcpServer[]> {
    return this.db
      .selectFrom('aiMcpServers')
      .selectAll('aiMcpServers')
      .where('workspaceId', '=', workspaceId)
      .where('enabled', '=', true)
      .orderBy('createdAt', 'asc')
      .execute();
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
 * Returns null for null/empty arrays (an empty allowlist means "no restriction"
 * is not intended — callers pass null to clear; an empty array is normalized to
 * null here so it never round-trips as `[]`).
 */
function jsonbArray(value: string[] | null | undefined) {
  if (value === null || value === undefined || value.length === 0) {
    return null;
  }
  // Typed as string[] so it is assignable to the toolAllowlist column.
  return sql<string[]>`${JSON.stringify(value)}::jsonb`;
}
