import { TransclusionService } from '../transclusion.service';

/**
 * Covers two untested, high-risk write paths around `page_template_references`:
 *
 *  1. `syncPageTemplateReferences` — the `toDelete` branch: stale references are
 *     removed when the host page no longer embeds a source, while genuinely new
 *     embeds are inserted. We assert `deleteByReferenceAndSources` /  `insertMany`
 *     receive the correct rows and the returned `{ inserted, deleted }` counts.
 *
 *  2. `insertTemplateReferencesForPages` — the multi-workspace grouping/filtering
 *     branch: candidate source ids are grouped per workspace, each workspace is
 *     validated independently, and cross-workspace sources are dropped.
 *
 * Setup/mocking mirrors the existing transclusion specs (page-template-access /
 * page-template-lookup): `new TransclusionService(...)` is built with the same
 * 11 positional mock args; only the deps each test touches are real stubs.
 */

/**
 * Chainable kysely `db` stub used by `filterInWorkspaceSourceIds`. Every
 * `selectFrom(...).select(...).where(...)` returns the same builder; `.execute()`
 * resolves whatever rows the per-call resolver returns. The resolver receives
 * the captured `where('id','in', <ids>)` and `where('workspaceId','=', ws)`
 * arguments so a test can decide, per workspace, which ids "exist".
 */
function makeWorkspaceScopedDb(
  resolve: (ids: string[], workspaceId: string) => string[],
) {
  const state = { ids: [] as string[], workspaceId: '' };
  const builder: any = {};
  builder.selectFrom = jest.fn(() => builder);
  builder.select = jest.fn(() => builder);
  builder.where = jest.fn((col: string, _op: string, val: any) => {
    if (col === 'id') state.ids = val as string[];
    if (col === 'workspaceId') state.workspaceId = val as string;
    return builder;
  });
  builder.execute = jest.fn(async () =>
    resolve(state.ids, state.workspaceId).map((id) => ({ id })),
  );
  return builder;
}

function buildService(opts: {
  db: any;
  pageTemplateReferencesRepo: any;
}) {
  return new TransclusionService(
    opts.db,
    {} as any, // pageTransclusionsRepo
    {} as any, // pageTransclusionReferencesRepo
    opts.pageTemplateReferencesRepo,
    {} as any, // pageRepo
    {} as any, // pagePermissionRepo
    {} as any, // spaceMemberRepo
    {} as any, // attachmentRepo
    {} as any, // storageService
    {} as any, // pageAccessService
  );
}

const pageEmbedDoc = (sourceIds: string[]) => ({
  type: 'doc',
  content: sourceIds.map((id) => ({
    type: 'pageEmbed',
    attrs: { sourcePageId: id },
  })),
});

describe('TransclusionService.syncPageTemplateReferences — toDelete branch', () => {
  it('deletes stale references and inserts new ones with correct args/counts', async () => {
    // Every candidate id is treated as in-workspace by the existence query.
    const db = makeWorkspaceScopedDb((ids) => ids);

    const insertMany = jest.fn().mockResolvedValue(undefined);
    const deleteByReferenceAndSources = jest.fn().mockResolvedValue(undefined);
    const pageTemplateReferencesRepo = {
      // existing refs: "keep" stays embedded, "stale-a"/"stale-b" no longer are
      findByReferencePageId: jest.fn().mockResolvedValue([
        { sourcePageId: 'keep' },
        { sourcePageId: 'stale-a' },
        { sourcePageId: 'stale-b' },
      ]),
      insertMany,
      deleteByReferenceAndSources,
    };

    const service = buildService({ db, pageTemplateReferencesRepo });

    // host now embeds: keep (unchanged) + fresh (new). stale-a/stale-b gone.
    const result = await service.syncPageTemplateReferences(
      'host',
      'w1',
      pageEmbedDoc(['keep', 'fresh']),
    );

    expect(result).toEqual({ inserted: 1, deleted: 2 });

    // only the genuinely new embed is inserted (keep already existed)
    expect(insertMany).toHaveBeenCalledTimes(1);
    expect(insertMany.mock.calls[0][0]).toEqual([
      { workspaceId: 'w1', referencePageId: 'host', sourcePageId: 'fresh' },
    ]);

    // stale references removed, scoped to host + workspace
    expect(deleteByReferenceAndSources).toHaveBeenCalledTimes(1);
    const [refPageId, workspaceId, staleSources] =
      deleteByReferenceAndSources.mock.calls[0];
    expect(refPageId).toBe('host');
    expect(workspaceId).toBe('w1');
    expect([...staleSources].sort()).toEqual(['stale-a', 'stale-b']);
  });

  it('deletes ALL existing references when the host embeds nothing anymore', async () => {
    const db = makeWorkspaceScopedDb((ids) => ids);
    const insertMany = jest.fn().mockResolvedValue(undefined);
    const deleteByReferenceAndSources = jest.fn().mockResolvedValue(undefined);
    const pageTemplateReferencesRepo = {
      findByReferencePageId: jest
        .fn()
        .mockResolvedValue([{ sourcePageId: 'a' }, { sourcePageId: 'b' }]),
      insertMany,
      deleteByReferenceAndSources,
    };

    const service = buildService({ db, pageTemplateReferencesRepo });

    const result = await service.syncPageTemplateReferences(
      'host',
      'w1',
      pageEmbedDoc([]), // no embeds left
    );

    expect(result).toEqual({ inserted: 0, deleted: 2 });
    expect(insertMany).not.toHaveBeenCalled();
    const [, , staleSources] = deleteByReferenceAndSources.mock.calls[0];
    expect([...staleSources].sort()).toEqual(['a', 'b']);
  });

  it('treats a cross-workspace embed as stale: it never survives to be kept', async () => {
    // existence query drops "cross-ws"; so an existing ref to it must be deleted
    const db = makeWorkspaceScopedDb((ids) => ids.filter((id) => id !== 'cross-ws'));
    const insertMany = jest.fn().mockResolvedValue(undefined);
    const deleteByReferenceAndSources = jest.fn().mockResolvedValue(undefined);
    const pageTemplateReferencesRepo = {
      findByReferencePageId: jest
        .fn()
        .mockResolvedValue([{ sourcePageId: 'cross-ws' }]),
      insertMany,
      deleteByReferenceAndSources,
    };

    const service = buildService({ db, pageTemplateReferencesRepo });

    // host still "embeds" cross-ws in its doc, but it is not in-workspace
    const result = await service.syncPageTemplateReferences(
      'host',
      'w1',
      pageEmbedDoc(['cross-ws']),
    );

    expect(result).toEqual({ inserted: 0, deleted: 1 });
    expect(insertMany).not.toHaveBeenCalled();
    const [, , staleSources] = deleteByReferenceAndSources.mock.calls[0];
    expect([...staleSources]).toEqual(['cross-ws']);
  });

  it('no-ops both repos when desired and existing already match', async () => {
    const db = makeWorkspaceScopedDb((ids) => ids);
    const insertMany = jest.fn().mockResolvedValue(undefined);
    const deleteByReferenceAndSources = jest.fn().mockResolvedValue(undefined);
    const pageTemplateReferencesRepo = {
      findByReferencePageId: jest
        .fn()
        .mockResolvedValue([{ sourcePageId: 'same' }]),
      insertMany,
      deleteByReferenceAndSources,
    };

    const service = buildService({ db, pageTemplateReferencesRepo });

    const result = await service.syncPageTemplateReferences(
      'host',
      'w1',
      pageEmbedDoc(['same']),
    );

    expect(result).toEqual({ inserted: 0, deleted: 0 });
    expect(insertMany).not.toHaveBeenCalled();
    expect(deleteByReferenceAndSources).not.toHaveBeenCalled();
  });
});

describe('TransclusionService.insertTemplateReferencesForPages — multi-workspace grouping', () => {
  it('groups candidates per workspace and validates each workspace independently', async () => {
    // Each workspace "owns" only its own source ids. The existence query is
    // workspace-scoped, so an id from another workspace is dropped.
    const owned: Record<string, string[]> = {
      w1: ['s1'],
      w2: ['s2'],
    };
    const executeArgs: Array<{ ids: string[]; workspaceId: string }> = [];
    const db = makeWorkspaceScopedDb((ids, workspaceId) => {
      executeArgs.push({ ids: [...ids], workspaceId });
      const ownedSet = new Set(owned[workspaceId] ?? []);
      return ids.filter((id) => ownedSet.has(id));
    });

    const insertMany = jest.fn().mockResolvedValue(undefined);
    const pageTemplateReferencesRepo = { insertMany };

    const service = buildService({ db, pageTemplateReferencesRepo });

    // page-a in w1 embeds s1 (valid) + s2 (belongs to w2 -> dropped)
    // page-b in w2 embeds s2 (valid)
    const result = await service.insertTemplateReferencesForPages([
      { id: 'page-a', workspaceId: 'w1', content: pageEmbedDoc(['s1', 's2']) },
      { id: 'page-b', workspaceId: 'w2', content: pageEmbedDoc(['s2']) },
    ]);

    expect(result).toEqual({ inserted: 2 });

    expect(insertMany).toHaveBeenCalledTimes(1);
    const rows = insertMany.mock.calls[0][0];
    expect(rows).toEqual([
      { workspaceId: 'w1', referencePageId: 'page-a', sourcePageId: 's1' },
      { workspaceId: 'w2', referencePageId: 'page-b', sourcePageId: 's2' },
    ]);

    // one existence query per workspace, each scoped to that workspace's candidates
    expect(executeArgs).toHaveLength(2);
    const w1Call = executeArgs.find((c) => c.workspaceId === 'w1');
    const w2Call = executeArgs.find((c) => c.workspaceId === 'w2');
    expect(w1Call?.ids.sort()).toEqual(['s1', 's2']);
    expect(w2Call?.ids).toEqual(['s2']);
  });

  it('drops every cross-workspace source and inserts nothing when none are in-workspace', async () => {
    // No id is owned by its page's workspace -> all filtered out.
    const db = makeWorkspaceScopedDb(() => []);
    const insertMany = jest.fn().mockResolvedValue(undefined);
    const service = buildService({
      db,
      pageTemplateReferencesRepo: { insertMany },
    });

    const result = await service.insertTemplateReferencesForPages([
      { id: 'page-a', workspaceId: 'w1', content: pageEmbedDoc(['x']) },
      { id: 'page-b', workspaceId: 'w2', content: pageEmbedDoc(['y']) },
    ]);

    expect(result).toEqual({ inserted: 0 });
    expect(insertMany).not.toHaveBeenCalled();
  });

  it('dedupes a sourceId shared by two pages in the same workspace into one validation', async () => {
    const executeArgs: Array<{ ids: string[]; workspaceId: string }> = [];
    const db = makeWorkspaceScopedDb((ids, workspaceId) => {
      executeArgs.push({ ids: [...ids], workspaceId });
      return ids; // all in-workspace
    });
    const insertMany = jest.fn().mockResolvedValue(undefined);
    const service = buildService({
      db,
      pageTemplateReferencesRepo: { insertMany },
    });

    // both pages embed the same source "shared" in w1
    const result = await service.insertTemplateReferencesForPages([
      { id: 'page-a', workspaceId: 'w1', content: pageEmbedDoc(['shared']) },
      { id: 'page-b', workspaceId: 'w1', content: pageEmbedDoc(['shared']) },
    ]);

    // a row per (page, source) pair, but only one existence query for w1
    expect(result).toEqual({ inserted: 2 });
    expect(executeArgs).toHaveLength(1);
    expect(executeArgs[0]).toEqual({ ids: ['shared'], workspaceId: 'w1' });

    const rows = insertMany.mock.calls[0][0];
    expect(rows).toEqual([
      { workspaceId: 'w1', referencePageId: 'page-a', sourcePageId: 'shared' },
      { workspaceId: 'w1', referencePageId: 'page-b', sourcePageId: 'shared' },
    ]);
  });

  it('returns inserted:0 without querying when no page has embeds', async () => {
    const execute = jest.fn();
    const db = makeWorkspaceScopedDb(() => {
      execute();
      return [];
    });
    const insertMany = jest.fn().mockResolvedValue(undefined);
    const service = buildService({
      db,
      pageTemplateReferencesRepo: { insertMany },
    });

    const result = await service.insertTemplateReferencesForPages([
      { id: 'page-a', workspaceId: 'w1', content: pageEmbedDoc([]) },
    ]);

    expect(result).toEqual({ inserted: 0 });
    expect(insertMany).not.toHaveBeenCalled();
    // filterInWorkspaceSourceIds short-circuits on empty candidates, so the
    // existence query never runs.
    expect(execute).not.toHaveBeenCalled();
  });
});
