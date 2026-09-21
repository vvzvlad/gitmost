import { Inject, Injectable } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '../../types/kysely.types';
import { dbOrTx, registerAfterCommit } from '../../utils';
import {
  InsertableWorkspace,
  UpdatableWorkspace,
  Workspace,
} from '@docmost/db/types/entity.types';
import { ExpressionBuilder, sql } from 'kysely';
import { DB, Workspaces } from '@docmost/db/types/db';
import { CacheKey } from '../../../common/helpers/cache-keys';

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
    'temporaryNoteHours',
    'isScimEnabled',
  ];
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  /**
   * #348 — bust the DomainMiddleware workspace caches after any workspace write.
   * Deletes BOTH the self-hosted (constant) key and the cloud per-hostname key so
   * a single implementation covers either deployment mode (the irrelevant key is a
   * harmless no-op). Best-effort: a cache error must never fail the write, and a
   * missed bust is bounded by WORKSPACE_CACHE_TTL_MS. Note: a hostname RENAME only
   * busts the NEW hostname's key (the row returned here carries the new hostname);
   * the old key expires via TTL.
   */
  private async bustWorkspaceCache(
    workspace?: Pick<Workspace, 'hostname'> | undefined,
    trx?: KyselyTransaction,
  ): Promise<void> {
    const del = async () => {
      try {
        await this.cacheManager.del(CacheKey.WORKSPACE_SELF_HOSTED);
        if (workspace?.hostname) {
          await this.cacheManager.del(
            CacheKey.WORKSPACE_BY_HOST(workspace.hostname),
          );
        }
      } catch {
        // cache is best-effort; TTL is the backstop
      }
    };
    if (trx) {
      // Inside a caller transaction the write is NOT yet committed: busting now
      // opens a repopulation window (a concurrent reader reloads the cache with
      // the pre-commit / stale row, which then survives until TTL). Defer the del
      // to the transaction's commit (drained by the owning executeTx) (#495).
      registerAfterCommit(trx, del);
    } else {
      // No transaction: the mutation above already auto-committed, so this del is
      // already post-commit.
      await del();
    }
  }

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

  async findLicenseKeyById(workspaceId: string): Promise<string | undefined> {
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
    const workspace = await db
      .updateTable('workspaces')
      .set({ ...updatableWorkspace, updatedAt: new Date() })
      .where('id', '=', workspaceId)
      .returning(this.baseFields)
      .executeTakeFirst();
    await this.bustWorkspaceCache(workspace, trx);
    return workspace;
  }

  async insertWorkspace(
    insertableWorkspace: InsertableWorkspace,
    trx?: KyselyTransaction,
  ): Promise<Workspace> {
    const db = dbOrTx(this.db, trx);
    const workspace = await db
      .insertInto('workspaces')
      .values(insertableWorkspace)
      .returning(this.baseFields)
      .executeTakeFirst();
    // Bust the cached "not found" so a fresh install / new tenant is seen at once.
    await this.bustWorkspaceCache(workspace, trx);
    return workspace;
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
    const workspace = await db
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
    await this.bustWorkspaceCache(workspace, trx);
    return workspace;
  }

  async updateAiSettings(
    workspaceId: string,
    prefKey: string,
    prefValue: string | boolean,
    trx?: KyselyTransaction,
  ) {
    const db = dbOrTx(this.db, trx);
    const workspace = await db
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
    await this.bustWorkspaceCache(workspace, trx);
    return workspace;
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
   * array/string. Sibling `settings.ai.*` keys (search / chat / mcp
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
    const workspace = await db
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
    await this.bustWorkspaceCache(workspace, trx);
    return workspace;
  }

  /**
   * #599 — read the workspace's EMBEDDING GENERATION pointer
   * (`settings.ai.embedding`).
   *
   *  - `activeFingerprint`: the generation search/RAG currently SERVE from. It is
   *    the workspace's persisted pointer, deliberately NOT derived from the live
   *    provider config: changing the model/revision/prefix changes the config
   *    (TARGET) fingerprint instantly, but the pointer only moves after a full
   *    target reindex completes (the atomic flip). null = never flipped (a fresh
   *    or legacy instance), and callers then fall back to the config fingerprint.
   *  - `activeModel`: the bare model NAME of that generation (`page_embeddings.
   *    model_name` of its rows). Recorded at the flip so a reader can tell a
   *    same-model fingerprint change (revision/prefix — same embedding space, the
   *    old rows stay comparable) from a MODEL change (a different space, where a
   *    cosine of the new model's query against the old model's rows is noise). null
   *    = never flipped, or flipped by a build that predates this key.
   *  - `coverageTotal`: the number of pages that actually produced >= 1 chunk in
   *    the completed run that established `activeFingerprint`. It is the coverage
   *    DENOMINATOR (see EmbeddingGenerationService.computeCoverage) — the raw
   *    embeddable count cannot be used, because pages with no extractable text
   *    never produce a row and would pin the state at `stale` forever.
   *  - `coverageEmbeddable`: how many pages that same run considered EMBEDDABLE.
   *    `coverageEmbeddable - coverageTotal` is the measured number of pages that
   *    look embeddable but yield no chunk; the live denominator subtracts it from
   *    the CURRENT embeddable count, which is what lets coverage go `stale` when
   *    pages are ADDED without pinning a chunk-less workspace at `stale` forever.
   *
   * Values are read with `->>` (jsonb text extraction), so a corrupted/absent key
   * degrades to null rather than throwing.
   */
  async getEmbeddingGeneration(
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<{
    activeFingerprint: string | null;
    activeModel: string | null;
    coverageTotal: number | null;
    coverageEmbeddable: number | null;
    coverageAt: Date | null;
  }> {
    const db = dbOrTx(this.db, trx);
    const row = await db
      .selectFrom('workspaces')
      .select([
        sql<
          string | null
        >`settings->'ai'->'embedding'->>'activeFingerprint'`.as(
          'activeFingerprint',
        ),
        sql<string | null>`settings->'ai'->'embedding'->>'activeModel'`.as(
          'activeModel',
        ),
        sql<string | null>`settings->'ai'->'embedding'->>'coverageTotal'`.as(
          'coverageTotal',
        ),
        sql<
          string | null
        >`settings->'ai'->'embedding'->>'coverageEmbeddable'`.as(
          'coverageEmbeddable',
        ),
        sql<string | null>`settings->'ai'->'embedding'->>'coverageAt'`.as(
          'coverageAt',
        ),
      ])
      .where('id', '=', workspaceId)
      .executeTakeFirst();

    // NOTE `Number(null) === 0` — an ABSENT key must stay null (= "no completed run
    // for this generation", which drives the bootstrap denominator), never 0 (which
    // would read as "this generation covers a workspace of zero pages" = a vacuous
    // `full`). So the null check comes BEFORE the numeric parse.
    const count = (raw: string | null | undefined): number | null => {
      const parsed = raw == null || raw === '' ? NaN : Number(raw);
      return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
    };
    // `coverageAt` is stored as an ISO string. A missing key (a pointer flipped by
    // a build that predates it) or an unparseable value must read as null, which
    // makes computeCoverage fall back to its pure frozen-gap rule — never a bogus
    // Invalid Date, which would silently make every `updated_at > $since`
    // comparison false and hide every changed page.
    const at = (raw: string | null | undefined): Date | null => {
      if (!raw) return null;
      const parsed = new Date(raw);
      return Number.isFinite(parsed.getTime()) ? parsed : null;
    };
    return {
      activeFingerprint: row?.activeFingerprint || null,
      activeModel: row?.activeModel || null,
      coverageTotal: count(row?.coverageTotal),
      coverageEmbeddable: count(row?.coverageEmbeddable),
      coverageAt: at(row?.coverageAt),
    };
  }

  /**
   * #599 — the ATOMIC POINTER FLIP: move `settings.ai.embedding.activeFingerprint`
   * to the generation a completed reindex just built, and record that run's
   * coverage denominator, in ONE settings write.
   *
   * All five keys are written by a single UPDATE (one jsonb `||` merge), so a
   * reader can never observe the new fingerprint with the old run's coverage total
   * (or vice-versa) — the flip is all-or-nothing. Sibling `settings.ai.*` keys
   * (provider / search / chat / mcp) are preserved by the merge.
   *
   * `coverageAt` (#599 review F2) is the instant the run that produced these
   * numbers STARTED: it partitions the corpus into the pages the run measured and
   * the pages it did not (created/edited since), which is what keeps the frozen
   * chunk-less gap from excusing brand-new un-embedded pages. It rides in the same
   * write for the same reason as the counts — a coverage timestamp that did not
   * match the coverage numbers would be worse than none.
   *
   * #599 (D6) — BOTH `settings->'ai'` and `settings->'ai'->'embedding'` are wrapped
   * in a `jsonb_typeof = 'object'` CASE. `COALESCE` only guards a NULL value; if
   * either key somehow holds a scalar or an array (a hand-edited row, a bad
   * migration), `'"x"'::jsonb || '{...}'::jsonb` raises
   * `cannot concatenate a non-object jsonb` and every flip of that workspace fails
   * forever. The CASE self-heals it to `{}` instead (the same weakness exists in
   * `updateAiProviderSettings` for `ai`; fixed here for this writer).
   *
   * The "is the config still on this target?" guard lives at the call site
   * (EmbeddingGenerationService.completeRun) — it re-resolves the provider right
   * before this write, so a config change DURING the run never gets a pointer
   * flipped onto a generation nobody is building any more.
   */
  async setEmbeddingGeneration(
    workspaceId: string,
    generation: {
      activeFingerprint: string;
      activeModel: string;
      coverageTotal: number;
      coverageEmbeddable: number;
      /** When the run that measured the coverage STARTED (see the doc above). */
      coverageAt: Date;
    },
    trx?: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    const count = (n: number): string => String(Math.max(0, Math.floor(n)));
    const workspace = await db
      .updateTable('workspaces')
      .set({
        settings: sql`COALESCE(settings, '{}'::jsonb) || jsonb_build_object(
          'ai',
          (CASE WHEN jsonb_typeof(settings->'ai') = 'object'
                THEN settings->'ai' ELSE '{}'::jsonb END)
          || jsonb_build_object(
            'embedding',
            (CASE WHEN jsonb_typeof(settings->'ai'->'embedding') = 'object'
                  THEN settings->'ai'->'embedding' ELSE '{}'::jsonb END)
            || jsonb_build_object(
                 'activeFingerprint', ${generation.activeFingerprint}::text,
                 'activeModel', ${generation.activeModel}::text,
                 'coverageTotal', ${count(generation.coverageTotal)}::text,
                 'coverageEmbeddable', ${count(generation.coverageEmbeddable)}::text,
                 'coverageAt', ${generation.coverageAt.toISOString()}::text
               )
          ))`,
        updatedAt: new Date(),
      })
      .where('id', '=', workspaceId)
      .returning(this.baseFields)
      .executeTakeFirst();
    await this.bustWorkspaceCache(workspace, trx);
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
    const workspace = await db
      .updateTable('workspaces')
      .set({
        settings: sql`COALESCE(settings, '{}'::jsonb)
                || jsonb_build_object('${sql.raw(prefKey)}', ${sql.lit(prefValue)})`,
        updatedAt: new Date(),
      })
      .where('id', '=', workspaceId)
      .returning(this.baseFields)
      .executeTakeFirst();
    await this.bustWorkspaceCache(workspace, trx);
    return workspace;
  }

  async updateSharingSettings(
    workspaceId: string,
    prefKey: string,
    prefValue: string | boolean,
    trx?: KyselyTransaction,
  ) {
    const db = dbOrTx(this.db, trx);
    const workspace = await db
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
    await this.bustWorkspaceCache(workspace, trx);
    return workspace;
  }

  async updateTemplateSettings(
    workspaceId: string,
    prefKey: string,
    prefValue: string | boolean,
    trx?: KyselyTransaction,
  ) {
    const db = dbOrTx(this.db, trx);
    const workspace = await db
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
    await this.bustWorkspaceCache(workspace, trx);
    return workspace;
  }
}
