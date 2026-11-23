import { SpaceRepo } from '@docmost/db/repos/space/space.repo';
import { createSpace, createWorkspace, destroyTestDb, getTestDb } from './db';

describe('space appearance persistence', () => {
  const db = getTestDb();
  const repo = new SpaceRepo(db as any, {} as any);
  afterAll(destroyTestDb);

  it('round-trips objects with the real driver, preserving sibling settings and partial fields', async () => {
    const workspace = await createWorkspace(db);
    const space = await createSpace(db, workspace.id);
    await db
      .updateTable('spaces')
      .set({
        settings: {
          homePageId: 'keep-home',
          sharing: { disabled: true },
        },
      })
      .where('id', '=', space.id)
      .execute();
    await repo.updateAppearanceSettings(space.id, workspace.id, {
      icon: 'rocket',
      color: '#166c9d',
    });
    const read = () =>
      db
        .selectFrom('spaces')
        .select('settings')
        .where('id', '=', space.id)
        .executeTakeFirstOrThrow();
    expect((await read()).settings).toEqual({
      homePageId: 'keep-home',
      sharing: { disabled: true },
      appearance: { icon: 'rocket', color: '#166c9d' },
    });
    await repo.updateAppearanceSettings(space.id, workspace.id, {
      color: '#7c3aed',
    });
    expect((await read()).settings.appearance).toEqual({
      icon: 'rocket',
      color: '#7c3aed',
    });
    await repo.updateAppearanceSettings(space.id, workspace.id, {
      icon: null,
      color: null,
    });
    expect((await read()).settings).toEqual({
      homePageId: 'keep-home',
      sharing: { disabled: true },
      appearance: { icon: null, color: null },
    });
  });

  it('initializes null settings and ignores a different workspace', async () => {
    const workspace = await createWorkspace(db);
    const other = await createWorkspace(db);
    const space = await createSpace(db, workspace.id);
    await repo.updateAppearanceSettings(space.id, other.id, { icon: 'shield' });
    const read = () =>
      db
        .selectFrom('spaces')
        .select('settings')
        .where('id', '=', space.id)
        .executeTakeFirstOrThrow();
    expect((await read()).settings).toBeNull();
    await repo.updateAppearanceSettings(space.id, workspace.id, {
      icon: 'book',
    });
    expect((await read()).settings).toEqual({ appearance: { icon: 'book' } });
  });
});
