import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '../../types/kysely.types';
import { dbOrTx } from '../../utils';
import {
  InsertableWorkspace,
  UpdatableWorkspace,
  Workspace,
} from '@docmost/db/types/entity.types';
import { ExpressionBuilder, sql } from 'kysely';
import { DB, Workspaces } from '@docmost/db/types/db';

/**
 * Writable `settings.ai.provider` keys, enforced at this generic SQL layer. This
 * repo cannot import AI-feature types, so this list is its own copy; a parity
 * test (ai-provider-settings-keys.spec.ts) asserts it equals
 * PROVIDER_SETTINGS_KEYS in ai.types so a future drift fails in CI rather than
 * silently dropping a field at this boundary.
 */
export const AI_PROVIDER_SETTINGS_ALLOWED: readonly string[] = [
  'driver',
  'chatModel',
  'chatContextWindow',
  'chatApiStyle',
  'embeddingModel',
  'baseUrl',
  'embeddingBaseUrl',
  'sttModel',
  'sttBaseUrl',
  'sttApiStyle',
  'sttLanguage',
  'systemPrompt',
  'publicShareChatModel',
  'publicShareAssistantRoleId',
];

@Injectable()
export class WorkspaceRepo {
  public baseFields: Array<keyof Workspaces> = [
    'id',
    'name',
    'description',
    'logo',
    'hostname',
    'customDomain',
    'settings',
    'defaultRole',
    'emailDomains',
    'defaultSpaceId',
    'createdAt',
    'updatedAt',
    'deletedAt',
    'stripeCustomerId',
    'status',
    'billingEmail',
    'trialEndAt',
    'enforceSso',
    'plan',
    'enforceMfa',
    'trashRetentionDays',
    'isScimEnabled',
  ];
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async findById(
    workspaceId: string,
    opts?: {
      withLock?: boolean;
      withMemberCount?: boolean;
      withLicenseKey?: boolean;
      trx?: KyselyTransaction;
    },
  ): Promise<Workspace> {
    const db = dbOrTx(this.db, opts?.trx);

    let query = db
      .selectFrom('workspaces')
      .select(this.baseFields)
      .where('id', '=', workspaceId);

    if (opts?.withMemberCount) {
      query = query.select(this.withMemberCount);
    }

    if (opts?.withLicenseKey) {
      query = query.select('licenseKey');
    }

    if (opts?.withLock && opts?.trx) {
      query = query.forUpdate();
    }

    return query.executeTakeFirst();
  }

  async findLicenseKeyById(
    workspaceId: string,
  ): Promise<string | undefined> {
    const row = await this.db
      .selectFrom('workspaces')
      .select('licenseKey')
      .where('id', '=', workspaceId)
      .executeTakeFirst();
    return row?.licenseKey;
  }

  async findFirst(): Promise<Workspace> {
    return await this.db
      .selectFrom('workspaces')
      .selectAll()
      .orderBy('createdAt', 'asc')
      .limit(1)
      .executeTakeFirst();
  }

  async findByHostname(hostname: string): Promise<Workspace> {
    return await this.db
      .selectFrom('workspaces')
      .selectAll()
      .where(sql`LOWER(hostname)`, '=', sql`LOWER(${hostname})`)
      .executeTakeFirst();
  }

  async hostnameExists(
    hostname: string,
    trx?: KyselyTransaction,
  ): Promise<boolean> {
    if (hostname?.length < 1) return false;

    const db = dbOrTx(this.db, trx);
    let { count } = await db
      .selectFrom('workspaces')
      .select((eb) => eb.fn.count('id').as('count'))
      .where(sql`LOWER(hostname)`, '=', sql`LOWER(${hostname})`)
      .executeTakeFirst();
    count = count as number;
    return count != 0;
  }

  async updateWorkspace(
    updatableWorkspace: UpdatableWorkspace,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<Workspace> {
    const db = dbOrTx(this.db, trx);
    return db
      .updateTable('workspaces')
      .set({ ...updatableWorkspace, updatedAt: new Date() })
      .where('id', '=', workspaceId)
      .returning(this.baseFields)
      .executeTakeFirst();
  }

  async insertWorkspace(
    insertableWorkspace: InsertableWorkspace,
    trx?: KyselyTransaction,
  ): Promise<Workspace> {
    const db = dbOrTx(this.db, trx);
    return db
      .insertInto('workspaces')
      .values(insertableWorkspace)
      .returning(this.baseFields)
      .executeTakeFirst();
  }

  async count(): Promise<number> {
    const { count } = await this.db
      .selectFrom('workspaces')
      .select((eb) => eb.fn.count('id').as('count'))
      .executeTakeFirst();
    return count as number;
  }

  withMemberCount(eb: ExpressionBuilder<DB, 'workspaces'>) {
    return eb
      .selectFrom('users')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('users.deactivatedAt', 'is', null)
      .where('users.deletedAt', 'is', null)
      .whereRef('users.workspaceId', '=', 'workspaces.id')
      .as('memberCount');
  }

  async getActiveUserCount(workspaceId: string): Promise<number> {
    const users = await this.db
      .selectFrom('users')
      .select(['id', 'deactivatedAt', 'deletedAt'])
      .where('workspaceId', '=', workspaceId)
      .execute();

    const activeUsers = users.filter(
      (user) => user.deletedAt === null && user.deactivatedAt === null,
    );

    return activeUsers.length;
  }

  async updateApiSettings(
    workspaceId: string,
    prefKey: string,
    prefValue: string | boolean,
    trx?: KyselyTransaction,
  ) {
    const db = dbOrTx(this.db, trx);
    return db
      .updateTable('workspaces')
      .set({
        settings: sql`COALESCE(settings, '{}'::jsonb)
                || jsonb_build_object('api', COALESCE(settings->'api', '{}'::jsonb)
                || jsonb_build_object('${sql.raw(prefKey)}', ${sql.lit(prefValue)}))`,
        updatedAt: new Date(),
      })
      .where('id', '=', workspaceId)
      .returning(this.baseFields)
      .executeTakeFirst();
  }

  async updateAiSettings(
    workspaceId: string,
    prefKey: string,
    prefValue: string | boolean,
    trx?: KyselyTransaction,
  ) {
    const db = dbOrTx(this.db, trx);
    return db
      .updateTable('workspaces')
      .set({
        settings: sql`COALESCE(settings, '{}'::jsonb)
                || jsonb_build_object('ai', COALESCE(settings->'ai', '{}'::jsonb)
                || jsonb_build_object('${sql.raw(prefKey)}', ${sql.lit(prefValue)}))`,
        updatedAt: new Date(),
      })
      .where('id', '=', workspaceId)
      .returning(this.baseFields)
      .executeTakeFirst();
  }

  /**
   * Deep-merge a partial provider config into the fixed path
   * `settings.ai.provider`. Unlike `updateAiSettings` (single scalar key under
   * `settings.ai`), this stores a nested object. The provider object is assembled
   * IN SQL via `jsonb_build_object`: keys come from a fixed allowlist (inlined
   * via `sql.lit`, so no injection) and values are bound params, so the result is
   * a real jsonb object and never a double-encoded string (postgres.js would
   * otherwise re-serialize a `JSON.stringify`'d string, yielding a jsonb string
   * that `||` turns into an array). A `jsonb_typeof = 'object'` CASE self-heals
   * workspaces whose `settings.ai.provider` was previously corrupted into an
   * array/string. Sibling `settings.ai.*` keys (search / generative / chat / mcp
   * / systemPrompt) and provider fields absent from the partial are preserved via
   * jsonb `||` merge.
   */
  async updateAiProviderSettings(
    workspaceId: string,
    provider: Record<string, unknown>,
    trx?: KyselyTransaction,
  ): Promise<Workspace> {
    const db = dbOrTx(this.db, trx);
    // Assemble the provider object IN SQL. Keys are fixed provider field names
    // (sql.lit -> inlined literals, no injection); values are bound params cast
    // to ::text — postgres.js sends bound params untyped, and jsonb_build_object's
    // value args are polymorphic ("any"), so without the explicit ::text cast
    // Postgres throws "could not determine data type of parameter $1". The result
    // is a real jsonb object, never a double-encoded string. The CASE self-heals
    // workspaces whose settings.ai.provider was previously corrupted into an
    // array/string.
    const entries = Object.entries(provider).filter(
      ([k, v]) => v !== undefined && AI_PROVIDER_SETTINGS_ALLOWED.includes(k),
    );
    const patch = entries.length
      ? sql`jsonb_build_object(${sql.join(
          entries.flatMap(([k, v]) => [sql.lit(k), sql`${v}::text`]),
        )})`
      : sql`'{}'::jsonb`;
    return db
      .updateTable('workspaces')
      .set({
        settings: sql`COALESCE(settings, '{}'::jsonb) || jsonb_build_object(
          'ai', COALESCE(settings->'ai', '{}'::jsonb) || jsonb_build_object(
            'provider',
            (CASE WHEN jsonb_typeof(settings->'ai'->'provider') = 'object'
                  THEN settings->'ai'->'provider' ELSE '{}'::jsonb END)
            || ${patch}
          ))`,
        updatedAt: new Date(),
      })
      .where('id', '=', workspaceId)
      .returning(this.baseFields)
      .executeTakeFirst();
  }

  /**
   * Set a single scalar key at the TOP LEVEL of `settings` (e.g.
   * `settings.htmlEmbed`). Mirrors `updateAiSettings`/`updateSharingSettings`
   * but without a nested namespace object. `prefKey` comes from a fixed
   * allowlist at the call site (inlined via `sql.raw`, never user input); the
   * value is inlined via `sql.lit`.
   */
  async updateSetting(
    workspaceId: string,
    prefKey: string,
    prefValue: string | boolean,
    trx?: KyselyTransaction,
  ) {
    const db = dbOrTx(this.db, trx);
    return db
      .updateTable('workspaces')
      .set({
        settings: sql`COALESCE(settings, '{}'::jsonb)
                || jsonb_build_object('${sql.raw(prefKey)}', ${sql.lit(prefValue)})`,
        updatedAt: new Date(),
      })
      .where('id', '=', workspaceId)
      .returning(this.baseFields)
      .executeTakeFirst();
  }

  async updateSharingSettings(
    workspaceId: string,
    prefKey: string,
    prefValue: string | boolean,
    trx?: KyselyTransaction,
  ) {
    const db = dbOrTx(this.db, trx);
    return db
      .updateTable('workspaces')
      .set({
        settings: sql`COALESCE(settings, '{}'::jsonb)
                || jsonb_build_object('sharing', COALESCE(settings->'sharing', '{}'::jsonb)
                || jsonb_build_object('${sql.raw(prefKey)}', ${sql.lit(prefValue)}))`,
        updatedAt: new Date(),
      })
      .where('id', '=', workspaceId)
      .returning(this.baseFields)
      .executeTakeFirst();
  }

  async updateTemplateSettings(
    workspaceId: string,
    prefKey: string,
    prefValue: string | boolean,
    trx?: KyselyTransaction,
  ) {
    const db = dbOrTx(this.db, trx);
    return db
      .updateTable('workspaces')
      .set({
        settings: sql`COALESCE(settings, '{}'::jsonb)
                || jsonb_build_object('templates', COALESCE(settings->'templates', '{}'::jsonb)
                || jsonb_build_object('${sql.raw(prefKey)}', ${sql.lit(prefValue)}))`,
        updatedAt: new Date(),
      })
      .where('id', '=', workspaceId)
      .returning(this.baseFields)
      .executeTakeFirst();
  }

}
