import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB, KyselyTransaction } from '../../types/kysely.types';
import { dbOrTx } from '../../utils';
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
    return this.db
      .selectFrom('aiAgentRoles')
      .selectAll('aiAgentRoles')
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
  }

  /** All live roles for the workspace (management list + chat picker). */
  async listByWorkspace(workspaceId: string): Promise<AiAgentRole[]> {
    return this.db
      .selectFrom('aiAgentRoles')
      .selectAll('aiAgentRoles')
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'asc')
      .execute();
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
    },
    trx?: KyselyTransaction,
  ): Promise<AiAgentRole> {
    const db = dbOrTx(this.db, trx);
    return db
      .insertInto('aiAgentRoles')
      .values({
        workspaceId: values.workspaceId,
        creatorId: values.creatorId ?? null,
        name: values.name,
        emoji: values.emoji ?? null,
        description: values.description ?? null,
        instructions: values.instructions,
        modelConfig: jsonbObject(values.modelConfig),
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
      // undefined => unchanged; null => clear; string => set.
      emoji?: string | null;
      description?: string | null;
      instructions?: string;
      // undefined => unchanged; null => clear; object => set.
      modelConfig?: ModelConfigValue;
      enabled?: boolean;
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
      set.modelConfig = jsonbObject(patch.modelConfig);
    }
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
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
 * Encode an object as a jsonb bind for the `model_config` column. The postgres
 * driver would otherwise need an explicit cast; bind the JSON text and cast it.
 * Returns null for null/undefined/empty objects. Cast to `any` because the
 * generated column type is the broad `JsonValue` union, which a concrete object
 * type is not structurally assignable to.
 */
export function jsonbObject(value: ModelConfigValue | undefined) {
  if (value === null || value === undefined || Object.keys(value).length === 0) {
    return null;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return sql`${JSON.stringify(value)}::jsonb` as any;
}
