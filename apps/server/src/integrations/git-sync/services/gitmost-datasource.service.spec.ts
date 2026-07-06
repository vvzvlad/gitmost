// Stub the collab util so importing the service does not drag in the
// editor-ext -> @tiptap/react -> react-dom graph (unloadable under jest's node
// env, same coupling noted in mcp.service.spec.ts). The captured transact
// callback is never executed in these unit tests, so the stub extensions array
// is sufficient; the real collab write path is exercised by integration tests.
jest.mock('../../../collaboration/collaboration.util', () => ({
  tiptapExtensions: [],
  getPageId: (name: string) => name.replace(/^page\./, ''),
}));
// writeBody now builds the replacement Yjs state eagerly (before clearing the
// live doc), so TiptapTransformer.toYdoc runs in these unit tests. Real Tiptap
// extensions are stubbed to [] above (they drag in the React graph), which can't
// build a schema — so stub the transformer to return a small non-empty Y.Doc.
// The real conversion is exercised by the @docmost/git-sync converter tests and
// the integration tests.
jest.mock('@hocuspocus/transformer', () => {
  const Yjs = require('yjs');
  return {
    TiptapTransformer: {
      toYdoc: jest.fn(() => {
        const d = new Yjs.Doc();
        d.getXmlFragment('default').insert(0, [new Yjs.XmlElement('paragraph')]);
        return d;
      }),
    },
  };
});
// PageService is only ever a mocked dependency here; stub the editor-ext entry
// it imports so loading its module does not pull in the React graph either.
jest.mock('@docmost/editor-ext', () => ({
  markdownToHtml: jest.fn(),
}));
// The service loads `parseDocmostMarkdown` / `markdownToProseMirror` at runtime
// via the `loadGitSync()` bridge (the ESM `@docmost/git-sync` package cannot be
// `require()`d under jest). Stub the loader: the real conversion is exercised by
// the @docmost/git-sync converter tests and the converter gate; here the mocked
// TiptapTransformer.toYdoc ignores the converted doc anyway, so a passthrough
// body + a minimal ProseMirror doc is sufficient.
jest.mock('../git-sync.loader', () => ({
  loadGitSync: jest.fn(async () => ({
    parseDocmostMarkdown: (md: string) => ({ meta: {}, body: md }),
    markdownToProseMirror: async () => ({
      type: 'doc',
      content: [{ type: 'paragraph' }],
    }),
    // renamePage funnels the current title through sanitizeTitle to detect the
    // sanitized-stem echo; identity is the correct default here (none of the
    // rename fixtures use filename-hostile chars, so the sanitized form equals
    // the input and the guard never fires).
    sanitizeTitle: (title: string) => title,
    // importPageMarkdown guard #2 uses docsCanonicallyEqual to skip a no-op
    // re-ingest. A key-order-insensitive JSON compare is a sufficient stand-in
    // for the unit tests (the real semantic equality is covered by the
    // @docmost/git-sync converter tests); returning false for genuinely
    // different docs lets the write paths under test proceed.
    docsCanonicallyEqual: (a: unknown, b: unknown) =>
      JSON.stringify(a) === JSON.stringify(b),
  })),
}));

import { GitmostDataSourceService } from './gitmost-datasource.service';
// The loader is mocked above; this binding is the hoisted jest.fn, so a single
// test can swap the runtime bridge (e.g. a smarter `docsCanonicallyEqual`) via
// `mockResolvedValueOnce` without perturbing the default used by every other test.
import { loadGitSync } from '../git-sync.loader';

// Focused unit/contract test for the native GitSyncClient adapter.
// No DB, no real collab server: the repos/services/gateway are mocked and we
// assert the mapping logic + the provenance/soft-delete/position contracts.

type AnyMock = jest.Mock;

interface Mocks {
  pageRepo: {
    findById: AnyMock;
    getSpaceDescendants: AnyMock;
    restorePage: AnyMock;
  };
  spaceRepo: { findById: AnyMock };
  pageService: {
    create: AnyMock;
    update: AnyMock;
    movePage: AnyMock;
    removePage: AnyMock;
  };
  collabGateway: { writePageBody: AnyMock };
  // Minimal Kysely-ish chainable mock for the direct-query paths.
  db: any;
}

function makeQueryBuilder(rows: any[]) {
  const qb: any = {};
  for (const m of ['select', 'where', 'orderBy', 'limit']) {
    qb[m] = jest.fn(() => qb);
  }
  qb.execute = jest.fn(async () => rows);
  qb.executeTakeFirst = jest.fn(async () => rows[0]);
  return qb;
}

function build(rows: any[] = []): {
  service: GitmostDataSourceService;
  mocks: Mocks;
} {
  const mocks: Mocks = {
    pageRepo: {
      findById: jest.fn(),
      getSpaceDescendants: jest.fn(),
      restorePage: jest.fn(async () => undefined),
    },
    spaceRepo: { findById: jest.fn(async () => ({ id: 'space-1' })) },
    pageService: {
      create: jest.fn(),
      update: jest.fn(async () => undefined),
      movePage: jest.fn(async () => undefined),
      removePage: jest.fn(async () => undefined),
    },
    collabGateway: {
      writePageBody: jest.fn(async () => undefined),
    },
    db: {
      selectFrom: jest.fn(() => makeQueryBuilder(rows)),
    },
  };

  const service = new GitmostDataSourceService(
    mocks.pageRepo as any,
    mocks.spaceRepo as any,
    mocks.pageService as any,
    mocks.collabGateway as any,
    mocks.db as any,
  );

  return { service, mocks };
}

const CTX = { workspaceId: 'ws-1', userId: 'svc-user' };
// A bound context that carries the reconciling spaceId, enabling deletePage's
// cross-space MOVE guard (the `if (ctx.spaceId)` branch).
const CTX_SPACE = { ...CTX, spaceId: 'space-1' };
// A syntactically VALID parent uuid. createPage/movePage now coerce a malformed
// (non-UUID) parentPageId to root (F1), so tests exercising the normal
// pass-through parent path must use a real uuid, not an arbitrary token.
const PARENT_UUID = '11111111-1111-4111-8111-111111111111';

describe('GitmostDataSourceService', () => {
  describe('listSpaceTree', () => {
    it('maps descendants to PageNode and is always complete:true', async () => {
      const { service, mocks } = build();
      mocks.spaceRepo.findById.mockResolvedValue({ id: 'space-1' });
      mocks.pageRepo.getSpaceDescendants.mockResolvedValue([
        {
          id: 'p1',
          slugId: 's1',
          title: 'Root',
          parentPageId: null,
          position: 'a0',
        },
        {
          id: 'p2',
          slugId: 's2',
          title: 'Child',
          parentPageId: 'p1',
          position: 'a1',
        },
      ]);

      const client = service.bind(CTX);
      const res = await client.listSpaceTree('space-1');

      expect(res.complete).toBe(true);
      expect(mocks.pageRepo.getSpaceDescendants).toHaveBeenCalledWith(
        'space-1',
        { includeContent: false },
      );
      expect(res.pages).toEqual([
        {
          id: 'p1',
          slugId: 's1',
          title: 'Root',
          parentPageId: null,
          hasChildren: true, // p2's parent is p1
          position: 'a0',
        },
        {
          id: 'p2',
          slugId: 's2',
          title: 'Child',
          parentPageId: 'p1',
          hasChildren: false,
          position: 'a1',
        },
      ]);
    });

    it('throws when the space is not found', async () => {
      const { service, mocks } = build();
      mocks.spaceRepo.findById.mockResolvedValue(undefined);
      await expect(service.bind(CTX).listSpaceTree('nope')).rejects.toThrow();
    });
  });

  // D-P3-1 ghost guard: the pull reconciler asks which candidate-delete ids are
  // REAL page rows before deleting a tracked vault file. Only rows returned here
  // may be absence-deleted; a ghost id (never a page) is preserved.
  describe('pageIdsExist (D-P3-1 ghost guard)', () => {
    const UUID_A = '11111111-1111-4111-8111-111111111111';
    const UUID_B = '22222222-2222-4222-8222-222222222222';

    it('returns the subset that are real page rows, workspace-scoped (any space/state)', async () => {
      // The DB reports only UUID_A exists as a row.
      const { service, mocks } = build([{ id: UUID_A }]);
      const res = await service.bind(CTX).pageIdsExist([UUID_A, UUID_B]);
      expect(res).toEqual([UUID_A]);
      // The query is workspace-scoped and restricted to the candidate ids.
      // Crucially there is NO deletedAt / spaceId filter: a trashed page or a
      // page moved to another space still counts as "exists" (its file is
      // cleaned up), while a ghost has no row (its file is preserved).
      expect(mocks.db.selectFrom).toHaveBeenCalledWith('pages');
      const qb = mocks.db.selectFrom.mock.results[0].value;
      expect(qb.where).toHaveBeenCalledWith('workspaceId', '=', 'ws-1');
      expect(qb.where).toHaveBeenCalledWith('id', 'in', [UUID_A, UUID_B]);
      const filterCols = qb.where.mock.calls.map((c: any[]) => c[0]);
      expect(filterCols).not.toContain('deletedAt');
      expect(filterCols).not.toContain('spaceId');
    });

    it('filters malformed non-UUID ids BEFORE the predicate (and skips the query when none remain)', async () => {
      // A mix of one valid uuid + malformed tokens: only the valid uuid reaches
      // the predicate, so a bad `gitmost_id` cannot trigger a 22P02 that would
      // reject the whole existence probe.
      const { service, mocks } = build([]);
      const res = await service
        .bind(CTX)
        .pageIdsExist([UUID_A, 'not-a-uuid', '[unclosed']);
      const qb = mocks.db.selectFrom.mock.results[0].value;
      expect(qb.where).toHaveBeenCalledWith('id', 'in', [UUID_A]);
      expect(res).toEqual([]);

      // When EVERY candidate is malformed, the query is skipped entirely.
      const { service: s2, mocks: m2 } = build([]);
      const res2 = await s2.bind(CTX).pageIdsExist(['not-a-uuid', '[unclosed']);
      expect(res2).toEqual([]);
      expect(m2.db.selectFrom).not.toHaveBeenCalled();
    });
  });

  describe('getPageJson', () => {
    it('returns the engine page shape with ISO updatedAt + content', async () => {
      const { service, mocks } = build();
      const updatedAt = new Date('2026-06-20T10:00:00.000Z');
      mocks.pageRepo.findById.mockResolvedValue({
        id: 'p1',
        slugId: 's1',
        title: 'Doc',
        parentPageId: null,
        spaceId: 'space-1',
        updatedAt,
        content: { type: 'doc', content: [] },
      });

      const res = await service.bind(CTX).getPageJson('p1');
      expect(mocks.pageRepo.findById).toHaveBeenCalledWith('p1', {
        includeContent: true,
      });
      expect(res).toEqual({
        id: 'p1',
        slugId: 's1',
        title: 'Doc',
        parentPageId: null,
        spaceId: 'space-1',
        updatedAt: '2026-06-20T10:00:00.000Z',
        content: { type: 'doc', content: [] },
      });
    });

    it('throws NotFound when the page does not exist', async () => {
      const { service, mocks } = build();
      mocks.pageRepo.findById.mockResolvedValue(undefined);
      await expect(service.bind(CTX).getPageJson('gone')).rejects.toThrow(
        /not found/i,
      );
    });
  });

  describe('importPageMarkdown', () => {
    it('parses md, converts to ProseMirror, and routes the body write to the owning instance', async () => {
      const { service, mocks } = build();
      mocks.pageRepo.findById.mockResolvedValue({
        id: 'p1',
        updatedAt: new Date('2026-06-20T11:00:00.000Z'),
      });

      const res = await service
        .bind(CTX)
        .importPageMarkdown('p1', '# Hello\n\nworld');

      // writeBody routes through writePageBody (NOT openDirectConnection): the
      // merge must run on the instance that owns the live doc so a connected
      // editor converges instead of silently reverting the change. The service
      // user rides on the payload as the responsible author.
      expect(mocks.collabGateway.writePageBody).toHaveBeenCalledTimes(1);
      const [docName, payload] = mocks.collabGateway.writePageBody.mock.calls[0];
      expect(docName).toBe('page.p1');
      expect(payload.userId).toBe('svc-user');
      // A converted ProseMirror doc was passed; no base on a plain import.
      expect(payload.prosemirrorJson).toEqual(
        expect.objectContaining({ type: 'doc' }),
      );
      expect(payload.baseProsemirrorJson).toBeUndefined();

      expect(res.updatedAt).toBe('2026-06-20T11:00:00.000Z');
    });

    it('returns updatedAt:undefined when the page row is gone after the write (stale-read branch)', async () => {
      // The page EXISTS at import time (so the unknown-page guard N1-D1 does not
      // fire), writeBody succeeds, but the POST-write findById returns nothing (e.g.
      // the page was concurrently hard-deleted) -> the optional updatedAt is omitted.
      const { service, mocks } = build();
      mocks.pageRepo.findById
        .mockResolvedValueOnce({
          id: 'p1',
          updatedAt: new Date('2026-06-20T11:00:00.000Z'),
        }) // currentPage (import-time read) exists
        .mockResolvedValue(undefined); // post-write read: page is gone

      const res = await service
        .bind(CTX)
        .importPageMarkdown('p1', '# Hello\n\nworld');

      expect(mocks.collabGateway.writePageBody).toHaveBeenCalledTimes(1);
      expect(res.updatedAt).toBeUndefined();
    });

    it('skips (no writeBody) when the gitmost_id is a valid UUID matching NO page (bug N1-D1)', async () => {
      // A well-formed but stale/foreign id (restore-from-backup, copied file) must
      // NOT fall through to writeBody on a non-existent page (which throws "Page not
      // found" and wedges the space's sync loop). It is skipped as an inert no-op.
      const { service, mocks } = build();
      mocks.pageRepo.findById.mockResolvedValue(undefined);

      const res = await service
        .bind(CTX)
        .importPageMarkdown('019f2500-face-7000-8000-000000000002', '# orphan');

      expect(res).toEqual({});
      expect(mocks.collabGateway.writePageBody).not.toHaveBeenCalled();
    });

    // F5 acceptance, criterion (b): guard #2 (docsCanonicallyEqual) must SKIP the
    // re-ingest when the freshly-parsed doc is canonically equal to the page's
    // current DB content even though the two are NOT byte-identical — the DB copy
    // carries the real per-block uuids (comments anchor to them) while a fresh
    // parse has none. Skipping is what protects a concurrent, not-yet-flushed
    // human edit from being clobbered by an idempotent poll re-ingest.
    //
    // NON-VACUITY: `currentContent` here differs from `doc` in raw JSON (it has an
    // `attrs.id` uuid `doc` lacks). The default mock `docsCanonicallyEqual` is a
    // plain `JSON.stringify` compare — it would return FALSE for these inputs, so
    // if guard #2 were removed (or reverted to a canonicalJsonEqual that does not
    // strip ids) writePageBody WOULD be called and this test would fail. We model
    // the package's authoritative id-stripping equality (returns TRUE here) by
    // swapping in a `docsCanonicallyEqual` that normalizes away block ids, proving
    // it is the SEMANTIC equality — not a byte compare — that suppresses the write.
    it('does NOT call writePageBody (guard #2) when content is canonically equal despite differing block ids (F5 criterion b)', async () => {
      const { service, mocks } = build();
      const realUuid = '11111111-1111-4111-8111-111111111111';
      // The DB row's content carries a REAL per-block uuid; a fresh parse does not.
      // These two docs are canonically equal (id-only difference) but NOT
      // byte-identical, so a naive JSON compare treats the page as "changed".
      mocks.pageRepo.findById.mockResolvedValue({
        id: 'p1',
        updatedAt: new Date('2026-06-20T11:00:00.000Z'),
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', attrs: { id: realUuid } }],
        },
      });
      // Swap the runtime bridge for THIS call only: same passthrough parse/convert
      // as the default mock (so `doc` is the id-less `{type:'doc',[paragraph]}`),
      // but `docsCanonicallyEqual` strips block ids before comparing — the real
      // converter's semantics. It returns TRUE for (doc, currentContent) here.
      const stripIds = (node: any): any => {
        if (Array.isArray(node)) return node.map(stripIds);
        if (node && typeof node === 'object') {
          const out: any = {};
          for (const [k, v] of Object.entries(node)) {
            if (k === 'attrs' && v && typeof v === 'object') {
              const { id: _id, ...rest } = v as Record<string, unknown>;
              if (Object.keys(rest).length) out.attrs = stripIds(rest);
            } else {
              out[k] = stripIds(v);
            }
          }
          return out;
        }
        return node;
      };
      (loadGitSync as jest.Mock).mockResolvedValueOnce({
        parseDocmostMarkdown: (md: string) => ({ meta: {}, body: md }),
        markdownToProseMirror: async () => ({
          type: 'doc',
          content: [{ type: 'paragraph' }],
        }),
        sanitizeTitle: (title: string) => title,
        docsCanonicallyEqual: (a: unknown, b: unknown) =>
          JSON.stringify(stripIds(a)) === JSON.stringify(stripIds(b)),
      });

      // No baseMarkdown -> guard #1 (fullMarkdown === baseMarkdown) cannot fire, so
      // the outcome is decided purely by guard #2.
      const res = await service
        .bind(CTX)
        .importPageMarkdown('p1', '# Hello\n\nworld');

      // Guard #2 fired: the redundant re-ingest is skipped, so the concurrent
      // human edit in the live doc is NOT clobbered.
      expect(mocks.collabGateway.writePageBody).not.toHaveBeenCalled();
      // The unchanged page's updatedAt is still surfaced from the DB row.
      expect(res.updatedAt).toBe('2026-06-20T11:00:00.000Z');
    });

    // The 2-way path (no base) is covered above; this exercises the THREE-WAY
    // branch that only fires when a `baseMarkdown` is supplied (review #5). The
    // merge dispatch itself now lives in the collab handler (gitSyncWriteBody);
    // here we assert the datasource forwards the base so the owning instance can
    // run the 3-way reconcile.
    describe('with a baseMarkdown (three-way merge)', () => {
      it('forwards the parsed base body so the owning instance can three-way merge', async () => {
        const { service, mocks } = build();
        mocks.pageRepo.findById.mockResolvedValue({
          id: 'p1',
          updatedAt: new Date('2026-06-20T11:00:00.000Z'),
        });

        await service
          .bind(CTX)
          .importPageMarkdown('p1', '# Full\n\ngit', '# Base\n\nbase');

        expect(mocks.collabGateway.writePageBody).toHaveBeenCalledTimes(1);
        const [, payload] = mocks.collabGateway.writePageBody.mock.calls[0];
        // Both the incoming body AND the last-synced base were converted and
        // forwarded — proof the 3-way common-ancestor is plumbed through.
        expect(payload.prosemirrorJson).toEqual(
          expect.objectContaining({ type: 'doc' }),
        );
        expect(payload.baseProsemirrorJson).toEqual(
          expect.objectContaining({ type: 'doc' }),
        );
      });
    });

    // The cross-space confused-deputy guard (review S2) fires only when
    // ctx.spaceId is bound. A vault file in space A can carry space B's pageId;
    // without this check the reconciling space could overwrite B's page body — a
    // write it has no authority over. When the resolved page already lives in a
    // DIFFERENT space, the import is SKIPPED (writePageBody not called) and the
    // page's own updatedAt is returned unchanged.
    describe('cross-space guard (ctx.spaceId bound, review S2)', () => {
      it('does NOT call writePageBody when the target page lives in another space', async () => {
        const { service, mocks } = build();
        // The resolved page is in space-2, but the reconciling context is space-1.
        // Its content DIFFERS from the parsed doc, so guard #2 (docsCanonicallyEqual)
        // cannot be what suppresses the write — proving NON-VACUITY: without the S2
        // guard the flow would reach writeBody and writePageBody WOULD be called.
        mocks.pageRepo.findById.mockResolvedValue({
          id: 'p1',
          deletedAt: null,
          spaceId: 'space-2',
          updatedAt: new Date('2026-06-21T09:00:00.000Z'),
          content: {
            type: 'doc',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'B body' }] },
            ],
          },
        });

        const res = await service
          .bind(CTX_SPACE)
          .importPageMarkdown('p1', '# Hello\n\nworld');

        // The cross-space page is preserved: no body write happened.
        expect(mocks.collabGateway.writePageBody).not.toHaveBeenCalled();
        // Early-return shape: only the page's own updatedAt is surfaced.
        expect(res).toEqual({ updatedAt: '2026-06-21T09:00:00.000Z' });
      });
    });
  });

  // Bug C9-D1: a vault file with a malformed (non-UUID) `gitmost_id` frontmatter
  // makes the id reach a Postgres `uuid` predicate, which throws error code
  // '22P02'. Left unhandled the push apply records it as a per-cycle failure that
  // never clears -> the whole space's sync loops forever. The bind() seam wraps the
  // id-scoped writes so exactly that error is swallowed as an inert no-op.
  describe('malformed-id guard (bug C9-D1: non-UUID gitmost_id must not wedge sync)', () => {
    const pgInvalidUuid = Object.assign(
      new Error('invalid input syntax for type uuid: "not-a-uuid"'),
      { code: '22P02' },
    );

    it('importPageMarkdown swallows a 22P02 and does NOT write the body', async () => {
      const { service, mocks } = build();
      mocks.pageRepo.findById.mockRejectedValue(pgInvalidUuid);
      const res = await service
        .bind(CTX)
        .importPageMarkdown('not-a-uuid', '# x');
      expect(res).toEqual({}); // inert no-op, no throw
      expect(mocks.collabGateway.writePageBody).not.toHaveBeenCalled();
    });

    it('deletePage swallows the 22P02 thrown by the uuid predicate (no wedge)', async () => {
      const { service, mocks } = build();
      // The malformed id reaches removePage's `uuid` predicate, which throws 22P02.
      mocks.pageService.removePage.mockRejectedValue(pgInvalidUuid);
      await expect(
        service.bind(CTX).deletePage('not-a-uuid'),
      ).resolves.toBeUndefined();
    });

    it('re-throws a NON-22P02 error (does not mask real failures)', async () => {
      const { service, mocks } = build();
      mocks.pageRepo.findById.mockRejectedValue(new Error('db down'));
      await expect(
        service.bind(CTX).importPageMarkdown('not-a-uuid', '# x'),
      ).rejects.toThrow('db down');
    });
  });

  describe('createPage', () => {
    it('creates the shell with git-sync provenance, writes body, returns id', async () => {
      const { service, mocks } = build();
      mocks.pageService.create.mockResolvedValue({ id: 'new-id' });
      mocks.pageRepo.findById.mockResolvedValue({
        id: 'new-id',
        updatedAt: new Date('2026-06-20T12:00:00.000Z'),
      });

      const res = await service
        .bind(CTX)
        .createPage('Title', 'body md', 'space-1', PARENT_UUID);

      expect(mocks.pageService.create).toHaveBeenCalledWith(
        'svc-user',
        'ws-1',
        { spaceId: 'space-1', title: 'Title', parentPageId: PARENT_UUID },
        { actor: 'git-sync', aiChatId: null },
      );
      expect(mocks.collabGateway.writePageBody).toHaveBeenCalledWith(
        'page.new-id',
        expect.objectContaining({ userId: 'svc-user' }),
      );
      expect(res).toEqual({
        data: { id: 'new-id' },
        updatedAt: '2026-06-20T12:00:00.000Z',
      });
    });

    it('returns updatedAt:undefined when the fresh page row is missing after create', async () => {
      const { service, mocks } = build();
      mocks.pageService.create.mockResolvedValue({ id: 'new-id' });
      // The post-create findById returns nothing -> the optional updatedAt is
      // omitted (the id is still returned from create()).
      mocks.pageRepo.findById.mockResolvedValue(undefined);

      const res = await service
        .bind(CTX)
        .createPage('Title', 'body md', 'space-1');

      expect(res).toEqual({ data: { id: 'new-id' }, updatedAt: undefined });
    });

    // F1 (bug C9-D1, parent-id variant): a parent folder-note carrying a broken
    // non-UUID `gitmost_id` makes the push planner hand createPage a malformed
    // parentPageId. Left as-is it flows into pageService.create -> findById
    // (slugId fallback -> no row) -> NotFoundException, a throw that never clears
    // the push `failures` set, so the WHOLE space wedges forever. The fix COERCES
    // the malformed parent to root (undefined) so the page is created at the space
    // root (self-heal) instead of being dropped — and never wedges.
    //
    // NON-VACUITY: the mocked pageService.create asserts it received
    // `parentPageId: undefined`. Against the UNcoerced createPage the malformed
    // string would flow straight through and this assertion would fail (create
    // would be called with parentPageId:'[unclosed-broken-id'), so the test
    // genuinely exercises the coercion.
    it('coerces a malformed (non-UUID) parentPageId to root and does NOT wedge (F1)', async () => {
      const { service, mocks } = build();
      mocks.pageService.create.mockResolvedValue({ id: 'new-id' });
      mocks.pageRepo.findById.mockResolvedValue({
        id: 'new-id',
        updatedAt: new Date('2026-06-20T12:00:00.000Z'),
      });

      const res = await service
        .bind(CTX)
        .createPage('Title', 'body md', 'space-1', '[unclosed-broken-id');

      // No throw propagated to `failures`; create ran with the parent coerced to
      // root (undefined), NOT the malformed string — so create's findById /
      // nextPagePosition never see a non-uuid and cannot 22P02 / NotFound.
      expect(mocks.pageService.create).toHaveBeenCalledWith(
        'svc-user',
        'ws-1',
        { spaceId: 'space-1', title: 'Title', parentPageId: undefined },
        { actor: 'git-sync', aiChatId: null },
      );
      expect(res).toEqual({
        data: { id: 'new-id' },
        updatedAt: '2026-06-20T12:00:00.000Z',
      });
    });

    it('leaves a VALID uuid parentPageId unchanged (only a malformed parent is coerced)', async () => {
      const { service, mocks } = build();
      mocks.pageService.create.mockResolvedValue({ id: 'new-id' });
      mocks.pageRepo.findById.mockResolvedValue({
        id: 'new-id',
        updatedAt: new Date('2026-06-20T12:00:00.000Z'),
      });

      await service
        .bind(CTX)
        .createPage('Title', 'body md', 'space-1', PARENT_UUID);

      // A real uuid passes the isValidUUID check and is forwarded untouched.
      expect(mocks.pageService.create).toHaveBeenCalledWith(
        'svc-user',
        'ws-1',
        { spaceId: 'space-1', title: 'Title', parentPageId: PARENT_UUID },
        { actor: 'git-sync', aiChatId: null },
      );
    });
  });

  describe('deletePage', () => {
    it('uses the soft-delete path (removePage), not a force delete', async () => {
      const { service, mocks } = build();
      await service.bind(CTX).deletePage('p1');
      // Passes git-sync provenance so the soft-delete stamps
      // lastUpdatedSource='git-sync' (loop-guard, PR #119 review).
      expect(mocks.pageService.removePage).toHaveBeenCalledWith(
        'p1',
        'svc-user',
        'ws-1',
        { actor: 'git-sync', aiChatId: null },
      );
      // No forceDelete on the service surface used here.
      expect((mocks.pageService as any).forceDelete).toBeUndefined();
    });

    // The cross-space MOVE guard fires only when ctx.spaceId is bound. It re-reads
    // the page and SKIPS the soft-delete when the page has already moved to a
    // DIFFERENT space (otherwise a move-out would trash the page from both vaults).
    describe('cross-space move guard (ctx.spaceId bound)', () => {
      it("skips removePage when the page moved to another space (move-out)", async () => {
        const { service, mocks } = build();
        mocks.pageRepo.findById.mockResolvedValue({
          id: 'p1',
          deletedAt: null,
          spaceId: 'space-2',
        });

        const res = await service.bind(CTX_SPACE).deletePage('p1');

        // The page still lives in space-2 — it must NOT be trashed.
        expect(mocks.pageService.removePage).not.toHaveBeenCalled();
        expect(res).toEqual({ id: 'p1', skipped: 'moved-to-other-space' });
      });

      it('soft-deletes when the page is still in the reconciling space (genuine delete)', async () => {
        const { service, mocks } = build();
        mocks.pageRepo.findById.mockResolvedValue({
          id: 'p1',
          deletedAt: null,
          spaceId: 'space-1',
        });

        await service.bind(CTX_SPACE).deletePage('p1');

        // Same space -> a real deletion; removePage runs with git-sync provenance.
        expect(mocks.pageService.removePage).toHaveBeenCalledWith(
          'p1',
          'svc-user',
          'ws-1',
          { actor: 'git-sync', aiChatId: null },
        );
      });

      it('soft-deletes when the page row is not found (guard must not swallow a real delete)', async () => {
        const { service, mocks } = build();
        mocks.pageRepo.findById.mockResolvedValue(undefined);

        await service.bind(CTX_SPACE).deletePage('p1');

        expect(mocks.pageService.removePage).toHaveBeenCalledWith(
          'p1',
          'svc-user',
          'ws-1',
          { actor: 'git-sync', aiChatId: null },
        );
      });

      it('soft-deletes when the page is already soft-deleted (deletedAt non-null)', async () => {
        const { service, mocks } = build();
        mocks.pageRepo.findById.mockResolvedValue({
          id: 'p1',
          deletedAt: new Date('2026-06-20T10:00:00.000Z'),
          spaceId: 'space-2',
        });

        await service.bind(CTX_SPACE).deletePage('p1');

        // deletedAt is non-null -> not treated as a live move-out; removePage runs.
        expect(mocks.pageService.removePage).toHaveBeenCalledWith(
          'p1',
          'svc-user',
          'ws-1',
          { actor: 'git-sync', aiChatId: null },
        );
      });
    });
  });

  describe('movePage', () => {
    it('computes a fractional position when none is supplied', async () => {
      // db query returns a last sibling at 'a0' -> jittered key after it.
      const { service, mocks } = build([{ position: 'a0' }]);
      mocks.pageRepo.findById.mockResolvedValue({
        id: 'p1',
        spaceId: 'space-1',
      });

      await service.bind(CTX).movePage('p1', PARENT_UUID);

      expect(mocks.pageService.movePage).toHaveBeenCalledTimes(1);
      const [dto, page, provenance, actorUserId] =
        mocks.pageService.movePage.mock.calls[0];
      expect(dto.pageId).toBe('p1');
      expect(dto.parentPageId).toBe(PARENT_UUID);
      expect(typeof dto.position).toBe('string');
      expect(dto.position.length).toBeGreaterThan(0);
      expect(page).toEqual({ id: 'p1', spaceId: 'space-1' });
      expect(provenance).toEqual({ actor: 'git-sync', aiChatId: null });
      // The git-initiated move is attributed to the service user (lastUpdatedById
      // parity with create/delete/rename).
      expect(actorUserId).toBe('svc-user');
    });

    it('passes through an explicit position unchanged', async () => {
      const { service, mocks } = build();
      mocks.pageRepo.findById.mockResolvedValue({
        id: 'p1',
        spaceId: 'space-1',
      });

      await service.bind(CTX).movePage('p1', null, 'zz');
      const [dto] = mocks.pageService.movePage.mock.calls[0];
      expect(dto.position).toBe('zz');
      // db not consulted for a supplied position.
      expect(mocks.db.selectFrom).not.toHaveBeenCalled();
    });

    it('throws NotFound and moves nothing when the page does not exist', async () => {
      const { service, mocks } = build();
      mocks.pageRepo.findById.mockResolvedValue(undefined);
      await expect(
        service.bind(CTX).movePage('gone', 'parent-1'),
      ).rejects.toThrow(/not found/i);
      expect(mocks.pageService.movePage).not.toHaveBeenCalled();
    });

    // F1 (parent-id variant), mirror of the createPage case. A malformed
    // (non-UUID) destination parentPageId would reach computeMovePosition's raw
    // uuid predicate (22P02, swallowed but mis-logged) or — when a position is
    // supplied — pageService.movePage's findById -> NotFoundException (NOT a
    // 22P02, so NOT swallowed -> the space wedges). The fix coerces it to root
    // (null) so the reparent targets root instead of wedging. The page here has a
    // current parent, so coerced-root != current parent and the echo-guard does
    // not short-circuit — the move proceeds against a null (root) parent.
    //
    // NON-VACUITY: the assertion is `dto.parentPageId === null`. Against the
    // UNcoerced movePage the malformed string would flow through to
    // pageService.movePage's dto and this would fail (it would be the raw
    // '[broken-parent' token).
    it('coerces a malformed (non-UUID) parentPageId to root and does NOT wedge (F1)', async () => {
      const { service, mocks } = build([]); // no siblings -> fresh position key
      mocks.pageRepo.findById.mockResolvedValue({
        id: 'p1',
        spaceId: 'space-1',
        parentPageId: '22222222-2222-4222-8222-222222222222',
      });

      await service.bind(CTX).movePage('p1', '[broken-parent');

      expect(mocks.pageService.movePage).toHaveBeenCalledTimes(1);
      const [dto] = mocks.pageService.movePage.mock.calls[0];
      expect(dto.pageId).toBe('p1');
      // Coerced to root: the malformed parent never reaches the uuid predicate.
      expect(dto.parentPageId).toBeNull();
      expect(typeof dto.position).toBe('string');
    });
  });

  describe('renamePage', () => {
    it('updates only the title with git-sync provenance', async () => {
      const { service, mocks } = build();
      mocks.pageRepo.findById.mockResolvedValue({ id: 'p1', title: 'old' });

      await service.bind(CTX).renamePage('p1', 'new title');

      const [page, dto, user, provenance] =
        mocks.pageService.update.mock.calls[0];
      expect(page).toEqual({ id: 'p1', title: 'old' });
      expect(dto.title).toBe('new title');
      expect(user).toEqual({ id: 'svc-user' });
      expect(provenance).toEqual({ actor: 'git-sync', aiChatId: null });
    });

    it("strips the ` ~<slugId>` disambiguation suffix when it matches the page's OWN slugId", async () => {
      const { service, mocks } = build();
      mocks.pageRepo.findById.mockResolvedValue({
        id: 'p1',
        slugId: 's1',
        title: 'old',
      });

      await service.bind(CTX).renamePage('p1', 'Real Title ~s1');

      const [, dto] = mocks.pageService.update.mock.calls[0];
      // The trailing ` ~s1` equals this page's own slugId -> a vault artifact; strip.
      expect(dto.title).toBe('Real Title');
    });

    it('leaves a FOREIGN ` ~<slugId>` tail untouched (only the own slugId is stripped)', async () => {
      const { service, mocks } = build();
      mocks.pageRepo.findById.mockResolvedValue({
        id: 'p1',
        slugId: 's1',
        title: 'old',
      });

      await service.bind(CTX).renamePage('p1', 'Real Title ~other');

      const [, dto] = mocks.pageService.update.mock.calls[0];
      // ` ~other` is not this page's slugId -> a genuine title; must not be corrupted.
      expect(dto.title).toBe('Real Title ~other');
    });

    it('throws NotFound and renames nothing when the page does not exist', async () => {
      const { service, mocks } = build();
      mocks.pageRepo.findById.mockResolvedValue(undefined);
      await expect(
        service.bind(CTX).renamePage('gone', 'whatever'),
      ).rejects.toThrow(/not found/i);
      expect(mocks.pageService.update).not.toHaveBeenCalled();
    });
  });

  describe('restorePage', () => {
    it('restores via the repo restore path scoped to the workspace', async () => {
      const { service, mocks } = build();
      const res = await service.bind(CTX).restorePage('p1');
      // Stamps lastUpdatedSource='git-sync' on restore (loop-guard, PR #119).
      expect(mocks.pageRepo.restorePage).toHaveBeenCalledWith(
        'p1',
        'ws-1',
        'git-sync',
      );
      expect(res).toEqual({ id: 'p1' });
    });
  });

  // Phase-B+ continuous-sync methods: not yet called by the engine but wired into
  // the GitSyncClient seam (PR #119 review #5). Exercised via the bound client.
  describe('listRecentSince', () => {
    it('queries non-deleted pages newest-first and ISO-stringifies updatedAt', async () => {
      const rows = [
        {
          id: 'p1',
          slugId: 's1',
          title: 'A',
          parentPageId: null,
          spaceId: 'space-1',
          updatedAt: new Date('2026-06-20T10:00:00.000Z'),
        },
      ];
      const { service, mocks } = build(rows);
      const qb = mocks.db.selectFrom.mock.results; // populated after the call

      const out = (await service
        .bind(CTX)
        .listRecentSince('space-1', '2026-06-19T00:00:00.000Z', 100)) as any[];

      // Query builder shaped against the `pages` table with the expected chain.
      expect(mocks.db.selectFrom).toHaveBeenCalledWith('pages');
      const builder = qb[0].value;
      expect(builder.select).toHaveBeenCalled();
      expect(builder.orderBy).toHaveBeenCalledWith('updatedAt', 'desc');
      // deletedAt is null + the conditional spaceId / since / cap clauses.
      const whereArgs = builder.where.mock.calls.map((c: any[]) => c[0]);
      expect(whereArgs).toContain('deletedAt');
      expect(whereArgs).toContain('spaceId');
      expect(whereArgs).toContain('updatedAt');
      expect(builder.limit).toHaveBeenCalledWith(100);

      expect(out).toEqual([
        {
          id: 'p1',
          slugId: 's1',
          title: 'A',
          parentPageId: null,
          spaceId: 'space-1',
          updatedAt: '2026-06-20T10:00:00.000Z',
        },
      ]);
    });

    it('omits the spaceId / since / cap clauses when not supplied', async () => {
      const { service, mocks } = build([]);

      await service.bind(CTX).listRecentSince(undefined, null);

      const builder = mocks.db.selectFrom.mock.results[0].value;
      const whereArgs = builder.where.mock.calls.map((c: any[]) => c[0]);
      // Only the deletedAt-is-null guard; no spaceId / updatedAt> clauses.
      expect(whereArgs).toEqual(['deletedAt']);
      expect(builder.limit).not.toHaveBeenCalled();
    });
  });

  describe('listTrash', () => {
    it('queries soft-deleted pages and ISO-stringifies deletedAt (null stays null)', async () => {
      const rows = [
        {
          id: 'p1',
          slugId: 's1',
          title: 'Trashed',
          parentPageId: null,
          spaceId: 'space-1',
          deletedAt: new Date('2026-06-21T09:00:00.000Z'),
        },
        {
          id: 'p2',
          slugId: 's2',
          title: 'NoDate',
          parentPageId: null,
          spaceId: 'space-1',
          deletedAt: null,
        },
      ];
      const { service, mocks } = build(rows);

      const out = (await service.bind(CTX).listTrash('space-1')) as any[];

      expect(mocks.db.selectFrom).toHaveBeenCalledWith('pages');
      const builder = mocks.db.selectFrom.mock.results[0].value;
      const whereCalls = builder.where.mock.calls;
      // deletedAt is-not null (the trash predicate) + spaceId filter.
      expect(whereCalls).toContainEqual(['deletedAt', 'is not', null]);
      expect(whereCalls).toContainEqual(['spaceId', '=', 'space-1']);
      expect(builder.orderBy).toHaveBeenCalledWith('deletedAt', 'desc');

      expect(out[0].deletedAt).toBe('2026-06-21T09:00:00.000Z');
      expect(out[1].deletedAt).toBeNull();
    });
  });
});
