import { Kysely } from 'kysely';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { CacheKey } from 'src/common/helpers/cache-keys';
import { getTestDb, destroyTestDb, createWorkspace } from './db';

// A minimal Map-backed cache double with a working `del` (the previous `{}` stub
// made bustWorkspaceCache's `del` throw into its own try/catch, so the #348
// invalidation was never actually exercised — review F6).
function makeCacheDouble() {
  const store = new Map<string, unknown>();
  return {
    store,
    get: async (k: string) => store.get(k),
    set: async (k: string, v: unknown) => {
      store.set(k, v);
    },
    del: async (k: string) => {
      store.delete(k);
    },
  };
}

/**
 * A — WorkspaceRepo.updateSetting jsonb-MERGE (the html-embed kill-switch
 * write-half). Setting a single top-level key must NOT clobber sibling
 * settings namespaces. This is real SQL: the repo does
 * `COALESCE(settings,'{}') || jsonb_build_object(key, value)`.
 */
describe('WorkspaceRepo.updateSetting (jsonb merge) [integration]', () => {
  let db: Kysely<any>;
  let repo: WorkspaceRepo;

  beforeAll(() => {
    db = getTestDb();
    // Repos are plain classes taking @InjectKysely() db — instantiate directly.
    // 2nd arg is CACHE_MANAGER (used only to bust the #348 workspace cache); a
    // stub is fine here since bustWorkspaceCache is best-effort (try/catch).
    repo = new WorkspaceRepo(db as any, {} as any);
  });

  afterAll(async () => {
    await destroyTestDb();
  });

  it('persists htmlEmbed:true without clobbering sibling ai/sharing settings', async () => {
    const ws = await createWorkspace(db, {
      settings: { ai: { chat: true }, sharing: { x: 1 } },
    });

    const updated = await repo.updateSetting(ws.id, 'htmlEmbed', true);

    // Returned row carries the merged settings.
    expect(updated.settings).toMatchObject({
      htmlEmbed: true,
      ai: { chat: true },
      sharing: { x: 1 },
    });

    // Re-read from the DB to confirm it actually persisted (not just returning()).
    const row = await db
      .selectFrom('workspaces')
      .select(['settings'])
      .where('id', '=', ws.id)
      .executeTakeFirstOrThrow();

    expect(row.settings).toEqual({
      ai: { chat: true },
      sharing: { x: 1 },
      htmlEmbed: true,
    });
  });

  it('initializes settings from NULL via COALESCE without error', async () => {
    const ws = await createWorkspace(db, { settings: undefined });

    const updated = await repo.updateSetting(ws.id, 'htmlEmbed', false);

    expect(updated.settings).toEqual({ htmlEmbed: false });
  });
});

/**
 * #348 F6 — the DomainMiddleware workspace cache (WORKSPACE_SELF_HOSTED /
 * WORKSPACE_BY_HOST, 15s TTL) caches security-relevant fields (enforceSso/
 * enforceMfa/status). Its correctness rests entirely on bustWorkspaceCache being
 * called from every mutator. This exercises the real invalidation with a working
 * cache double (not the {} stub, whose del throws-and-swallows): warm the cache
 * like DomainMiddleware, mutate, and assert the busted key is gone so a stale
 * workspace row can't outlive the mutation.
 */
describe('WorkspaceRepo bustWorkspaceCache invalidation [integration]', () => {
  let db: Kysely<any>;

  beforeAll(() => {
    db = getTestDb();
  });
  afterAll(async () => {
    await destroyTestDb();
  });

  it('updateSetting busts the self-hosted workspace cache key', async () => {
    const cache = makeCacheDouble();
    const repo = new WorkspaceRepo(db as any, cache as any);
    const ws = await createWorkspace(db, { settings: {} });

    // Warm the cache as DomainMiddleware would (self-hosted key).
    cache.store.set(CacheKey.WORKSPACE_SELF_HOSTED, ws);
    expect(cache.store.has(CacheKey.WORKSPACE_SELF_HOSTED)).toBe(true);

    await repo.updateSetting(ws.id, 'htmlEmbed', true);

    // The mutation must have invalidated the cached row.
    expect(cache.store.has(CacheKey.WORKSPACE_SELF_HOSTED)).toBe(false);
  });

  it('updateSharingSettings busts the by-host workspace cache key too', async () => {
    const cache = makeCacheDouble();
    const repo = new WorkspaceRepo(db as any, cache as any);
    const ws = await createWorkspace(db, { settings: {} });
    // createWorkspace assigns a unique hostname; read it back for the by-host key.
    const { hostname } = await db
      .selectFrom('workspaces')
      .select(['hostname'])
      .where('id', '=', ws.id)
      .executeTakeFirstOrThrow();

    // Warm BOTH keys (self-hosted + by-host); the by-host bust needs the row's
    // hostname, which the mutator returns from the DB.
    cache.store.set(CacheKey.WORKSPACE_SELF_HOSTED, ws);
    cache.store.set(CacheKey.WORKSPACE_BY_HOST(hostname as string), ws);

    await repo.updateSharingSettings(ws.id, 'allowInvite', true);

    expect(cache.store.has(CacheKey.WORKSPACE_SELF_HOSTED)).toBe(false);
    expect(cache.store.has(CacheKey.WORKSPACE_BY_HOST(hostname as string))).toBe(
      false,
    );
  });
});
