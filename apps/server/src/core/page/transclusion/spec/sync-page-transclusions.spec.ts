import { TransclusionService } from '../transclusion.service';

/**
 * Diff-logic tests for TransclusionService.syncPageTransclusions and
 * syncPageReferences. Both diff the desired state (parsed from PM JSON) against
 * the existing rows and issue only the minimal inserts/updates/deletes.
 *
 * The collector `collectTransclusionsFromPmJson` maps a `transclusionSource`
 * node to a snapshot of:
 *     { transclusionId: <attrs.id>, content: { type: 'doc', content: <node.content ?? []> } }
 * So for the "unchanged -> no write" branch, the existing row's `content` must
 * deep-equal exactly that shape (isDeepStrictEqual). We mirror that here.
 *
 * Catch: spurious writes on unchanged content (the isDeepStrictEqual no-op
 * branch) and reference-sync drift (key must be `sourcePageId::transclusionId`,
 * so two refs differing only in transclusionId are distinct rows).
 */

// Build a doc with one `transclusionSource` per (id, content-children) entry.
function transclusionDoc(
  entries: Array<{ id: string; children?: unknown[] }>,
) {
  return {
    type: 'doc',
    content: entries.map((e) => ({
      type: 'transclusionSource',
      attrs: { id: e.id },
      content: e.children ?? [],
    })),
  };
}

// The snapshot content shape the collector produces for the given children.
function snapshotContent(children: unknown[] = []) {
  return { type: 'doc', content: children };
}

function buildTransclusionService(existing: Array<any>) {
  const insert = jest.fn().mockResolvedValue(undefined);
  const update = jest.fn().mockResolvedValue(undefined);
  const deleteByPageAndTransclusionIds = jest.fn().mockResolvedValue(undefined);
  const findByPageId = jest.fn().mockResolvedValue(existing);

  const pageTransclusionsRepo = {
    findByPageId,
    insert,
    update,
    deleteByPageAndTransclusionIds,
  };

  const service = new TransclusionService(
    {} as any, // db
    pageTransclusionsRepo as any,
    {} as any, // pageTransclusionReferencesRepo
    {} as any, // pageTemplateReferencesRepo
    {} as any, // pageRepo
    {} as any, // pagePermissionRepo
    {} as any, // spaceMemberRepo
    {} as any, // attachmentRepo
    {} as any, // storageService
    {} as any, // pageAccessService
  );
  return { service, insert, update, deleteByPageAndTransclusionIds };
}

describe('TransclusionService.syncPageTransclusions (diff logic)', () => {
  it('inserts a brand-new transclusion id', async () => {
    const { service, insert, update, deleteByPageAndTransclusionIds } =
      buildTransclusionService([]);

    const result = await service.syncPageTransclusions(
      'page-1',
      'w1',
      transclusionDoc([{ id: 't-new', children: [{ type: 'paragraph' }] }]),
    );

    expect(result).toEqual({ inserted: 1, updated: 0, deleted: 0 });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0][0]).toEqual({
      workspaceId: 'w1',
      pageId: 'page-1',
      transclusionId: 't-new',
      content: snapshotContent([{ type: 'paragraph' }]),
    });
    expect(update).not.toHaveBeenCalled();
    expect(deleteByPageAndTransclusionIds).not.toHaveBeenCalled();
  });

  it('updates an existing id when its content changed (isDeepStrictEqual false)', async () => {
    const { service, insert, update } = buildTransclusionService([
      { transclusionId: 't1', content: snapshotContent([{ type: 'old' }]) },
    ]);

    const result = await service.syncPageTransclusions(
      'page-1',
      'w1',
      transclusionDoc([{ id: 't1', children: [{ type: 'new' }] }]),
    );

    expect(result).toEqual({ inserted: 0, updated: 1, deleted: 0 });
    expect(insert).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    const [pageId, transclusionId, data] = update.mock.calls[0];
    expect(pageId).toBe('page-1');
    expect(transclusionId).toBe('t1');
    expect(data).toEqual({ content: snapshotContent([{ type: 'new' }]) });
  });

  it('does NOT write when content is identical (no-op branch)', async () => {
    // The existing row content deep-equals the collector's snapshot exactly.
    const children = [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }];
    const { service, insert, update, deleteByPageAndTransclusionIds } =
      buildTransclusionService([
        { transclusionId: 't1', content: snapshotContent(children) },
      ]);

    const result = await service.syncPageTransclusions(
      'page-1',
      'w1',
      transclusionDoc([{ id: 't1', children }]),
    );

    expect(result).toEqual({ inserted: 0, updated: 0, deleted: 0 });
    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(deleteByPageAndTransclusionIds).not.toHaveBeenCalled();
  });

  it('deletes an existing id absent from the desired set', async () => {
    const { service, insert, update, deleteByPageAndTransclusionIds } =
      buildTransclusionService([
        { transclusionId: 'gone', content: snapshotContent([]) },
      ]);

    const result = await service.syncPageTransclusions(
      'page-1',
      'w1',
      transclusionDoc([]), // nothing desired
    );

    expect(result).toEqual({ inserted: 0, updated: 0, deleted: 1 });
    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(deleteByPageAndTransclusionIds).toHaveBeenCalledTimes(1);
    const [pageId, removedIds] = deleteByPageAndTransclusionIds.mock.calls[0];
    expect(pageId).toBe('page-1');
    expect(removedIds).toEqual(['gone']);
  });

  it('handles a combined insert + update + no-op + delete in one pass', async () => {
    const same = [{ type: 'keep' }];
    const { service, insert, update, deleteByPageAndTransclusionIds } =
      buildTransclusionService([
        { transclusionId: 'same', content: snapshotContent(same) }, // unchanged
        { transclusionId: 'chg', content: snapshotContent([{ type: 'old' }]) }, // updated
        { transclusionId: 'del', content: snapshotContent([]) }, // deleted
      ]);

    const result = await service.syncPageTransclusions(
      'page-1',
      'w1',
      transclusionDoc([
        { id: 'same', children: same }, // identical -> no write
        { id: 'chg', children: [{ type: 'new' }] }, // changed -> update
        { id: 'add', children: [{ type: 'fresh' }] }, // new -> insert
      ]),
    );

    expect(result).toEqual({ inserted: 1, updated: 1, deleted: 1 });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0][0].transclusionId).toBe('add');
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][1]).toBe('chg');
    expect(deleteByPageAndTransclusionIds.mock.calls[0][1]).toEqual(['del']);
  });
});

// ---------------------------------------------------------------------------
// syncPageReferences
// ---------------------------------------------------------------------------

function referenceDoc(
  refs: Array<{ sourcePageId: string; transclusionId: string }>,
) {
  return {
    type: 'doc',
    content: refs.map((r) => ({
      type: 'transclusionReference',
      attrs: { sourcePageId: r.sourcePageId, transclusionId: r.transclusionId },
    })),
  };
}

function buildReferenceService(existing: Array<any>) {
  const insertMany = jest.fn().mockResolvedValue(undefined);
  const deleteByReferenceAndKeys = jest.fn().mockResolvedValue(undefined);
  const findByReferencePageId = jest.fn().mockResolvedValue(existing);

  const pageTransclusionReferencesRepo = {
    findByReferencePageId,
    insertMany,
    deleteByReferenceAndKeys,
  };

  const service = new TransclusionService(
    {} as any, // db
    {} as any, // pageTransclusionsRepo
    pageTransclusionReferencesRepo as any,
    {} as any, // pageTemplateReferencesRepo
    {} as any, // pageRepo
    {} as any, // pagePermissionRepo
    {} as any, // spaceMemberRepo
    {} as any, // attachmentRepo
    {} as any, // storageService
    {} as any, // pageAccessService
  );
  return { service, insertMany, deleteByReferenceAndKeys };
}

describe('TransclusionService.syncPageReferences (diff logic)', () => {
  it('inserts a new reference keyed by sourcePageId::transclusionId', async () => {
    const { service, insertMany, deleteByReferenceAndKeys } =
      buildReferenceService([]);

    const result = await service.syncPageReferences(
      'ref-page',
      'w1',
      referenceDoc([{ sourcePageId: 's1', transclusionId: 't1' }]),
    );

    expect(result).toEqual({ inserted: 1, deleted: 0 });
    expect(insertMany).toHaveBeenCalledTimes(1);
    expect(insertMany.mock.calls[0][0]).toEqual([
      {
        workspaceId: 'w1',
        referencePageId: 'ref-page',
        sourcePageId: 's1',
        transclusionId: 't1',
      },
    ]);
    expect(deleteByReferenceAndKeys).not.toHaveBeenCalled();
  });

  it('deletes an existing reference absent from the desired set', async () => {
    const { service, insertMany, deleteByReferenceAndKeys } =
      buildReferenceService([
        { sourcePageId: 's-gone', transclusionId: 't-gone' },
      ]);

    const result = await service.syncPageReferences(
      'ref-page',
      'w1',
      referenceDoc([]),
    );

    expect(result).toEqual({ inserted: 0, deleted: 1 });
    expect(insertMany).not.toHaveBeenCalled();
    expect(deleteByReferenceAndKeys).toHaveBeenCalledTimes(1);
    const [referencePageId, keys] = deleteByReferenceAndKeys.mock.calls[0];
    expect(referencePageId).toBe('ref-page');
    expect(keys).toEqual([
      { sourcePageId: 's-gone', transclusionId: 't-gone' },
    ]);
  });

  it('no-ops when desired and existing already match', async () => {
    const { service, insertMany, deleteByReferenceAndKeys } =
      buildReferenceService([{ sourcePageId: 's1', transclusionId: 't1' }]);

    const result = await service.syncPageReferences(
      'ref-page',
      'w1',
      referenceDoc([{ sourcePageId: 's1', transclusionId: 't1' }]),
    );

    expect(result).toEqual({ inserted: 0, deleted: 0 });
    expect(insertMany).not.toHaveBeenCalled();
    expect(deleteByReferenceAndKeys).not.toHaveBeenCalled();
  });

  it('treats two refs differing only in transclusionId as DISTINCT keys', async () => {
    // existing has (s1,t1). desired keeps (s1,t1) and adds (s1,t2). The two must
    // not collapse: (s1,t2) is inserted, (s1,t1) untouched, nothing deleted.
    const { service, insertMany, deleteByReferenceAndKeys } =
      buildReferenceService([{ sourcePageId: 's1', transclusionId: 't1' }]);

    const result = await service.syncPageReferences(
      'ref-page',
      'w1',
      referenceDoc([
        { sourcePageId: 's1', transclusionId: 't1' },
        { sourcePageId: 's1', transclusionId: 't2' },
      ]),
    );

    expect(result).toEqual({ inserted: 1, deleted: 0 });
    expect(insertMany.mock.calls[0][0]).toEqual([
      {
        workspaceId: 'w1',
        referencePageId: 'ref-page',
        sourcePageId: 's1',
        transclusionId: 't2',
      },
    ]);
    expect(deleteByReferenceAndKeys).not.toHaveBeenCalled();
  });

  it('combines insert + delete when the source page of a ref changes', async () => {
    // existing (s-old,t1); desired (s-new,t1). Different sourcePageId -> distinct
    // key -> delete the old, insert the new.
    const { service, insertMany, deleteByReferenceAndKeys } =
      buildReferenceService([{ sourcePageId: 's-old', transclusionId: 't1' }]);

    const result = await service.syncPageReferences(
      'ref-page',
      'w1',
      referenceDoc([{ sourcePageId: 's-new', transclusionId: 't1' }]),
    );

    expect(result).toEqual({ inserted: 1, deleted: 1 });
    expect(insertMany.mock.calls[0][0]).toEqual([
      {
        workspaceId: 'w1',
        referencePageId: 'ref-page',
        sourcePageId: 's-new',
        transclusionId: 't1',
      },
    ]);
    expect(deleteByReferenceAndKeys.mock.calls[0][1]).toEqual([
      { sourcePageId: 's-old', transclusionId: 't1' },
    ]);
  });
});
