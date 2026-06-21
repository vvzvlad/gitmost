import { TransclusionService } from '../transclusion.service';

/**
 * Tests for TransclusionService.listReferences — returns the source page info
 * plus the list of pages that reference a given sync block. This is a read path
 * that leaks title/icon/slug, so it MUST drop any referencing page the viewer
 * cannot see, any soft-deleted page, and any cross-workspace page — even if such
 * an id slipped through the referencePageIds filter.
 *
 * Collaborating methods/repos:
 *   - pageTransclusionReferencesRepo.findReferencePageIdsByTransclusion(
 *       sourcePageId, transclusionId, workspaceId) -> string[]
 *   - filterViewerAccessiblePageIds(...) -> accessible ids (spied/stubbed)
 *   - pageRepo.findById(id, { includeSpace: true }) -> page row (per id)
 *
 * Output ordering: `references` preserves the order of `referencePageIds`.
 * Catch: leaking title/icon of a private/cross-workspace referencing page.
 */

const WS = 'w1';

function pageRow(over: Partial<any>) {
  return {
    id: 'x',
    slugId: 'slug-x',
    title: 'Title X',
    icon: '📄',
    spaceId: 'space-x',
    deletedAt: null,
    workspaceId: WS,
    space: { slug: 'space-slug-x' },
    ...over,
  };
}

function buildService(opts: {
  referencePageIds: string[];
  accessibleIds: string[];
  pagesById: Record<string, any | null>;
}) {
  const findReferencePageIdsByTransclusion = jest
    .fn()
    .mockResolvedValue(opts.referencePageIds);
  const pageTransclusionReferencesRepo = {
    findReferencePageIdsByTransclusion,
  };
  const findById = jest.fn(async (id: string) => opts.pagesById[id] ?? null);
  const pageRepo = { findById };

  const service = new TransclusionService(
    {} as any, // db
    {} as any, // pageTransclusionsRepo
    pageTransclusionReferencesRepo as any,
    {} as any, // pageTemplateReferencesRepo
    pageRepo as any,
    {} as any, // pagePermissionRepo
    {} as any, // spaceMemberRepo
    {} as any, // attachmentRepo
    {} as any, // storageService
    {} as any, // pageAccessService
  );

  jest
    .spyOn(service, 'filterViewerAccessiblePageIds')
    .mockResolvedValue(opts.accessibleIds);

  return { service, findById, findReferencePageIdsByTransclusion };
}

describe('TransclusionService.listReferences', () => {
  it('returns only accessible references; an inaccessible reference is excluded', async () => {
    // refs: pub (accessible) and priv (NOT accessible). source accessible too.
    const { service } = buildService({
      referencePageIds: ['pub', 'priv'],
      accessibleIds: ['src', 'pub'], // priv missing -> filtered out
      pagesById: {
        src: pageRow({ id: 'src', slugId: 'src-slug', title: 'Src' }),
        pub: pageRow({ id: 'pub', slugId: 'pub-slug', title: 'Public ref' }),
        priv: pageRow({ id: 'priv', title: 'Private ref' }),
      },
    });

    const result = await service.listReferences({
      sourcePageId: 'src',
      transclusionId: 't1',
      viewerUserId: 'u1',
      workspaceId: WS,
    });

    expect(result.source?.id).toBe('src');
    expect(result.references.map((r) => r.id)).toEqual(['pub']);
    // The private page's title must never appear.
    const json = JSON.stringify(result.references);
    expect(json).not.toContain('Private ref');
  });

  it('drops a soft-deleted reference even though it passed the id filter', async () => {
    // "stale" is in referencePageIds AND in accessibleIds, but its page row is
    // soft-deleted -> must be dropped by the post-load workspace/deleted guard.
    const { service } = buildService({
      referencePageIds: ['live', 'stale'],
      accessibleIds: ['src', 'live', 'stale'],
      pagesById: {
        src: pageRow({ id: 'src' }),
        live: pageRow({ id: 'live', title: 'Live ref' }),
        stale: pageRow({ id: 'stale', title: 'Stale ref', deletedAt: new Date() }),
      },
    });

    const result = await service.listReferences({
      sourcePageId: 'src',
      transclusionId: 't1',
      viewerUserId: 'u1',
      workspaceId: WS,
    });

    expect(result.references.map((r) => r.id)).toEqual(['live']);
    expect(JSON.stringify(result.references)).not.toContain('Stale ref');
  });

  it('drops a cross-workspace reference even though it passed the id filter', async () => {
    const { service } = buildService({
      referencePageIds: ['mine', 'foreign'],
      accessibleIds: ['src', 'mine', 'foreign'],
      pagesById: {
        src: pageRow({ id: 'src' }),
        mine: pageRow({ id: 'mine', title: 'Mine' }),
        foreign: pageRow({
          id: 'foreign',
          title: 'Foreign',
          workspaceId: 'other-ws',
        }),
      },
    });

    const result = await service.listReferences({
      sourcePageId: 'src',
      transclusionId: 't1',
      viewerUserId: 'u1',
      workspaceId: WS,
    });

    expect(result.references.map((r) => r.id)).toEqual(['mine']);
    expect(JSON.stringify(result.references)).not.toContain('Foreign');
  });

  it('returns source:null when the source is inaccessible but still lists accessible refs', async () => {
    // Viewer can see the referencing page but NOT the source page itself.
    const { service } = buildService({
      referencePageIds: ['pub'],
      accessibleIds: ['pub'], // src not accessible
      pagesById: {
        pub: pageRow({ id: 'pub', title: 'Public ref' }),
        src: pageRow({ id: 'src', title: 'Hidden source' }),
      },
    });

    const result = await service.listReferences({
      sourcePageId: 'src',
      transclusionId: 't1',
      viewerUserId: 'u1',
      workspaceId: WS,
    });

    expect(result.source).toBeNull();
    expect(result.references.map((r) => r.id)).toEqual(['pub']);
  });

  it('short-circuits to {source:null, references:[]} when nothing is accessible', async () => {
    const { service, findById } = buildService({
      referencePageIds: ['a', 'b'],
      accessibleIds: [], // nothing accessible
      pagesById: {
        a: pageRow({ id: 'a' }),
        b: pageRow({ id: 'b' }),
        src: pageRow({ id: 'src' }),
      },
    });

    const result = await service.listReferences({
      sourcePageId: 'src',
      transclusionId: 't1',
      viewerUserId: 'u1',
      workspaceId: WS,
    });

    expect(result).toEqual({ source: null, references: [] });
    // No page bodies loaded when the accessible set is empty.
    expect(findById).not.toHaveBeenCalled();
  });

  it('preserves the order of referencePageIds in the output', async () => {
    const { service } = buildService({
      referencePageIds: ['c', 'a', 'b'],
      accessibleIds: ['src', 'a', 'b', 'c'],
      pagesById: {
        src: pageRow({ id: 'src' }),
        a: pageRow({ id: 'a', title: 'A' }),
        b: pageRow({ id: 'b', title: 'B' }),
        c: pageRow({ id: 'c', title: 'C' }),
      },
    });

    const result = await service.listReferences({
      sourcePageId: 'src',
      transclusionId: 't1',
      viewerUserId: 'u1',
      workspaceId: WS,
    });

    // Output order must follow referencePageIds (c, a, b), NOT sorted/byId order.
    expect(result.references.map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });

  it('maps page fields and space slug into the reference info shape', async () => {
    const { service } = buildService({
      referencePageIds: ['pub'],
      accessibleIds: ['src', 'pub'],
      pagesById: {
        src: pageRow({ id: 'src' }),
        pub: pageRow({
          id: 'pub',
          slugId: 'pub-slug',
          title: 'Public',
          icon: '🔗',
          spaceId: 'space-pub',
          space: { slug: 'pub-space' },
        }),
      },
    });

    const result = await service.listReferences({
      sourcePageId: 'src',
      transclusionId: 't1',
      viewerUserId: 'u1',
      workspaceId: WS,
    });

    expect(result.references[0]).toEqual({
      id: 'pub',
      slugId: 'pub-slug',
      title: 'Public',
      icon: '🔗',
      spaceId: 'space-pub',
      spaceSlug: 'pub-space',
    });
  });
});
