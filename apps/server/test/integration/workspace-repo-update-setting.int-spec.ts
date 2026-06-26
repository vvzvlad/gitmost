import { Kysely } from 'kysely';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { getTestDb, destroyTestDb, createWorkspace } from './db';

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
    repo = new WorkspaceRepo(db as any);
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
