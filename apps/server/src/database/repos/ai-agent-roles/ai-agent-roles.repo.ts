import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '../../types/kysely.types';
import { dbOrTx, jsonbBind, parseJsonbValue } from '../../utils';
import { AiAgentRole } from '@docmost/db/types/entity.types';

/** The jsonb shape persisted in `model_config` (loosely typed for the column). */
type ModelConfigValue = Record<string, unknown> | null;

/**
 * Repository for per-workspace agent roles (admin-owned presets). All lookups
 * are workspace-scoped and soft-delete aware (`deleted_at IS NULL`). A role
 * shapes only the system-prompt persona + optional model override; it never
 * widens or narrows the toolset or CASL boundary.
 */
@Injectable()
export class AiAgentRoleRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  /** Single live (not soft-deleted) role scoped to the workspace. */
  async findById(
    id: string,
    workspaceId: string,
  ): Promise<AiAgentRole | undefined> {
    const row = await this.db
      .selectFrom('aiAgentRoles')
      .selectAll('aiAgentRoles')
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    return row ? normalizeRow(row) : row;
  }

  /**
   * Single live (not soft-deleted) AND enabled role scoped to the workspace, or
   * undefined. This is the SECURITY invariant shared by the authenticated chat
   * and the anonymous public-share assistant: a role only applies its persona /
   * model override when it currently exists, is not soft-deleted, and is enabled
   * — a disabled or deleted role server-authoritatively degrades to the built-in
   * universal assistant. Single source of truth so the two resolve paths cannot
   * drift apart.
   */
  async findLiveEnabled(
    id: string,
    workspaceId: string,
  ): Promise<AiAgentRole | undefined> {
    const row = await this.db
      .selectFrom('aiAgentRoles')
      .selectAll('aiAgentRoles')
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .where('enabled', '=', true)
      .executeTakeFirst();
    return row ? normalizeRow(row) : row;
  }

  /** All live roles for the workspace (management list + chat picker). */
  async listByWorkspace(workspaceId: string): Promise<AiAgentRole[]> {
    const rows = await this.db
      .selectFrom('aiAgentRoles')
      .selectAll('aiAgentRoles')
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'asc')
      .execute();
    return rows.map(normalizeRow);
  }

  async insert(
    values: {
      workspaceId: string;
      creatorId?: string | null;
      name: string;
      emoji?: string | null;
      description?: string | null;
      instructions: string;
      modelConfig?: ModelConfigValue;
      enabled?: boolean;
      autoStart?: boolean;
      // null/'' => stored as null (client default launch message).
      launchMessage?: string | null;
    },
    trx?: KyselyTransaction,
  ): Promise<AiAgentRole> {
    const db = dbOrTx(this.db, trx);
    const row = await db
      .insertInto('aiAgentRoles')
      .values({
        workspaceId: values.workspaceId,
        creatorId: values.creatorId ?? null,
        name: values.name,
        emoji: values.emoji ?? null,
        description: values.description ?? null,
        instructions: values.instructions,
        // Cast: the generated `model_config` column type is the broad JsonValue
        // union, which the concrete RawBuilder<Record> is not structurally
        // assignable to (same reason the old jsonbObject cast to any).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        modelConfig: jsonbBind(values.modelConfig) as any,
        enabled: values.enabled ?? true,
        autoStart: values.autoStart ?? true,
        // Empty string is treated as "no custom text" => null.
        launchMessage: values.launchMessage || null,
      })
      .returningAll()
      .executeTakeFirst();
    return normalizeRow(row);
  }

  async update(
    id: string,
    workspaceId: string,
    patch: {
      name?: string;
      // undefined => unchanged; null => clear; string => set.
      emoji?: string | null;
      description?: string | null;
      instructions?: string;
      // undefined => unchanged; null => clear; object => set.
      modelConfig?: ModelConfigValue;
      enabled?: boolean;
      autoStart?: boolean;
      // undefined => unchanged; null/'' => clear to null; string => set.
      launchMessage?: string | null;
    },
    trx?: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.emoji !== undefined) set.emoji = patch.emoji;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.instructions !== undefined) set.instructions = patch.instructions;
    if (patch.modelConfig !== undefined) {
      set.modelConfig = jsonbBind(patch.modelConfig);
    }
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.autoStart !== undefined) set.autoStart = patch.autoStart;
    if (patch.launchMessage !== undefined) {
      // Empty string clears to null (client default launch message).
      set.launchMessage = patch.launchMessage || null;
    }
    await db
      .updateTable('aiAgentRoles')
      .set(set)
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .execute();
  }

  /** Soft delete (consistent with ai_chats). Bound chats keep their role_id; the
   * stream resolves only live roles, so the chat degrades to universal. */
  async softDelete(
    id: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    await db
      .updateTable('aiAgentRoles')
      .set({ deletedAt: new Date() })
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .execute();
  }
}

/**
 * Parse the `model_config` value read from the DB into the object the entity
 * type promises. Rows written by the old double-encoding bind (`::jsonb` instead
 * of `::text::jsonb`) round-trip as a JSON STRING, so the driver hands back e.g.
 * `'{"driver":"gemini"}'` rather than an object; the read-path check
 * `typeof cfg === 'object'` then failed and the model override was SILENTLY
 * dropped (the role fell back to the default model). Be tolerant: a JSON string
 * is parsed; an already-parsed object passes through; null / a non-object (incl.
 * an array) / unparseable value becomes null (= no override). This self-heals
 * already-corrupted rows on read, no migration required.
 */
export function parseModelConfig(
  value: unknown,
): Record<string, unknown> | null {
  // Shape guard only; the legacy double-encoding self-heal lives in
  // parseJsonbValue (database/utils.ts).
  return parseJsonbValue(
    value,
    (v): v is Record<string, unknown> =>
      v !== null && typeof v === 'object' && !Array.isArray(v),
  );
}

/** Normalize a DB row so `modelConfig` is always an object or null. The cast
 *  bridges parseModelConfig's concrete `Record | null` to the column's broad
 *  generated `JsonValue` type (an object is a valid JsonValue at runtime). */
function normalizeRow(row: AiAgentRole): AiAgentRole {
  return {
    ...row,
    modelConfig: parseModelConfig(
      row.modelConfig,
    ) as AiAgentRole['modelConfig'],
  };
}
