import { TransclusionService } from '../transclusion.service';

/**
 * Exercises the pure access/mapping logic of `lookupTemplate`:
 *  - accessible + present  -> content (comments stripped) + meta
 *  - accessible + missing  -> not_found
 *  - inaccessible          -> no_access
 * The access decision is taken from `filterViewerAccessiblePageIds`, which we
 * stub; DB/repo internals are mocked.
 */
describe('TransclusionService.lookupTemplate (access mapping)', () => {
  function makeService(opts: {
    accessibleIds: string[];
    pages: Array<{
      id: string;
      title: string | null;
      icon: string | null;
      content: unknown;
      updatedAt: Date;
    }>;
  }) {
    const pageRepo = {
      findManyByIds: jest.fn().mockResolvedValue(opts.pages),
    };

    const service = new TransclusionService(
      {} as any, // db
      {} as any, // pageTransclusionsRepo
      {} as any, // pageTransclusionReferencesRepo
      {} as any, // pageTemplateReferencesRepo
      pageRepo as any,
      {} as any, // pagePermissionRepo
      {} as any, // spaceMemberRepo
      {} as any, // attachmentRepo
      {} as any, // storageService
      {} as any, // pageAccessService
      {} as any, // workspaceRepo
    );

    jest
      .spyOn(service, 'filterViewerAccessiblePageIds')
      .mockResolvedValue(opts.accessibleIds);

    return { service, pageRepo };
  }

  const now = new Date('2026-06-20T00:00:00.000Z');

  it('returns no_access for ids the viewer cannot see', async () => {
    const { service } = makeService({ accessibleIds: [], pages: [] });
    const { items } = await service.lookupTemplate(['p1'], 'u1', 'w1');
    expect(items).toEqual([{ sourcePageId: 'p1', status: 'no_access' }]);
  });

  it('returns not_found for accessible-but-missing pages', async () => {
    const { service } = makeService({ accessibleIds: ['p1'], pages: [] });
    const { items } = await service.lookupTemplate(['p1'], 'u1', 'w1');
    expect(items).toEqual([{ sourcePageId: 'p1', status: 'not_found' }]);
  });

  it('returns content + meta for accessible pages and strips comment marks', async () => {
    const content = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'hello',
              marks: [{ type: 'comment', attrs: { commentId: 'c1' } }],
            },
          ],
        },
      ],
    };
    const { service } = makeService({
      accessibleIds: ['p1'],
      pages: [
        { id: 'p1', title: 'Tmpl', icon: '📄', content, updatedAt: now },
      ],
    });

    const { items } = await service.lookupTemplate(['p1'], 'u1', 'w1');
    expect(items).toHaveLength(1);
    const item = items[0] as any;
    expect(item.status).toBeUndefined();
    expect(item.title).toBe('Tmpl');
    expect(item.icon).toBe('📄');
    expect(item.sourceUpdatedAt).toBe(now);

    // comment mark must be gone from the returned content
    const json = JSON.stringify(item.content);
    expect(json).not.toContain('comment');
    expect(json).toContain('hello');
  });

  it('maps a mixed batch positionally', async () => {
    const { service } = makeService({
      accessibleIds: ['ok'],
      pages: [
        { id: 'ok', title: 'A', icon: null, content: { type: 'doc', content: [] }, updatedAt: now },
      ],
    });
    const { items } = await service.lookupTemplate(
      ['no', 'ok', 'gone'],
      'u1',
      'w1',
    );
    expect((items[0] as any).status).toBe('no_access');
    expect((items[1] as any).status).toBeUndefined();
    expect((items[2] as any).status).toBe('no_access');
  });
});
