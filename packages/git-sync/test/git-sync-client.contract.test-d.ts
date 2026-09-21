import { describe, it, expect, expectTypeOf } from 'vitest';
import type {
  GitSyncClient,
  GitSyncPageNodeLite,
} from '../src/engine/client.types.js';

// Contract / type-level guard of the `GitSyncClient` seam (src/engine/client.types.ts).
//
// The engine reads specific fields off each client result; if the server-side
// native adapter drifts from this shape, `assignedPageId` (from createPage's
// `data.id`) would become `undefined` and the create path would loop forever
// re-creating the same page. These are COMPILE-TIME assertions (a typed dummy
// object that must `satisfies GitSyncClient`, plus `expectTypeOf` checks on the
// exact result fields the engine consumes) — the assertions live in the TYPE
// system, not the runtime body.
//
// ENFORCEMENT (Finding #1): this file is a vitest TYPE test (`.test-d.ts`).
// `vitest.config.ts` enables `test.typecheck` scoped to `test/**/*.test-d.ts`,
// so `npx vitest run` runs `tsc` over THIS file and turns every `expectTypeOf` /
// `@ts-expect-error` / `satisfies GitSyncClient` below into a real build-time
// assertion. If the GitSyncClient result shapes drift (e.g. createPage stops
// returning `{ data: { id: string } }`), the typecheck pass FAILS and the whole
// `vitest run` goes red. (The 35 runtime `*.test.ts` suites are NOT typechecked
// — the `-d` include scopes this to the contract file only.) The trivial
// `expect(true)` calls just keep the test reporter honest; they are NOT the
// guard.

describe('GitSyncClient contract (type-level)', () => {
  it('createPage returns { data: { id } } (+ optional updatedAt)', () => {
    // The exact field the engine reads back to assign the new pageId: the result
    // must EXTEND `{ data: { id: string } }` (carry at least that shape).
    expectTypeOf<
      Awaited<ReturnType<GitSyncClient['createPage']>>
    >().toExtend<{ data: { id: string } }>();
    // `data.id` is a string (NOT possibly-undefined): the anti-loop invariant.
    expectTypeOf<
      Awaited<ReturnType<GitSyncClient['createPage']>>['data']['id']
    >().toEqualTypeOf<string>();
    expect(true).toBe(true);
  });

  it('importPageMarkdown returns an optional updatedAt', () => {
    expectTypeOf<
      Awaited<ReturnType<GitSyncClient['importPageMarkdown']>>['updatedAt']
    >().toEqualTypeOf<string | undefined>();
    expect(true).toBe(true);
  });

  it('getPageJson surfaces the fields the pull side writes into meta', () => {
    type Page = Awaited<ReturnType<GitSyncClient['getPageJson']>>;
    expectTypeOf<Page['id']>().toEqualTypeOf<string>();
    expectTypeOf<Page['slugId']>().toEqualTypeOf<string>();
    expectTypeOf<Page['title']>().toEqualTypeOf<string>();
    expectTypeOf<Page['parentPageId']>().toEqualTypeOf<string | null>();
    expectTypeOf<Page['spaceId']>().toEqualTypeOf<string>();
    expectTypeOf<Page['updatedAt']>().toEqualTypeOf<string>();
    expectTypeOf<Page['content']>().toEqualTypeOf<unknown>();
    expect(true).toBe(true);
  });

  it('listSpaceTree returns { pages, complete } (complete gates §8 suppression)', () => {
    type Tree = Awaited<ReturnType<GitSyncClient['listSpaceTree']>>;
    expectTypeOf<Tree['complete']>().toEqualTypeOf<boolean>();
    expectTypeOf<Tree['pages']>().toEqualTypeOf<GitSyncPageNodeLite[]>();
    expect(true).toBe(true);
  });

  it('a structurally-correct adapter satisfies GitSyncClient (drift => compile error)', () => {
    // A minimal dummy adapter mirroring the EXACT result shapes the engine reads.
    // The `satisfies GitSyncClient` clause is the contract guard: any drift in a
    // method arg/result shape makes this FAIL TO COMPILE (and the run errors).
    const adapter = {
      listSpaceTree: async (_spaceId: string, _rootPageId?: string) => ({
        pages: [] as GitSyncPageNodeLite[],
        complete: true,
      }),
      getPageJson: async (pageId: string) => ({
        id: pageId,
        slugId: 'slug',
        title: 'Title',
        parentPageId: null,
        spaceId: 'space',
        updatedAt: '2026-01-01T00:00:00.000Z',
        content: { type: 'doc' } as unknown,
      }),
      importPageMarkdown: async (_pageId: string, _md: string) => ({
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
      // The anti-loop shape: createPage MUST return data.id so the engine can
      // write the assigned pageId back into the file meta.
      createPage: async (
        _title: string,
        _content: string,
        _spaceId: string,
        _parentPageId?: string,
      ) => ({
        data: { id: 'assigned-id' },
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
      deletePage: async (_pageId: string) => ({ success: true }),
      movePage: async (
        _pageId: string,
        _parentPageId: string | null,
        _position?: string,
      ) => ({ success: true }),
      renamePage: async (_pageId: string, _title: string) => ({ success: true }),
      listRecentSince: async (
        _spaceId: string | undefined,
        _sinceIso: string | null,
        _hardPageCap?: number,
      ) => [] as unknown[],
      listTrash: async (_spaceId: string) => [] as unknown[],
      restorePage: async (_pageId: string) => ({ success: true }),
    } satisfies GitSyncClient;

    // Runtime sanity: the dummy createPage really does carry data.id (so the
    // engine's `result.data.id` read yields a string, never undefined).
    expect(typeof adapter).toBe('object');
    return adapter
      .createPage('t', 'c', 's')
      .then((r) => expect(r.data.id).toBe('assigned-id'));
  });

  it('an adapter MISSING data.id is NOT assignable (negative compile guard)', () => {
    // This object intentionally omits `data.id` from createPage. The `@ts-expect-error`
    // asserts the assignment FAILS to type-check — i.e. the contract would catch a
    // server adapter that drifts to a shape making `assignedPageId` undefined. If
    // the contract ever loosened to accept this, the directive would become an
    // UNUSED @ts-expect-error and the file would fail to compile (the guard holds
    // in BOTH directions).
    const bad = {
      listSpaceTree: async () => ({ pages: [] as GitSyncPageNodeLite[], complete: true }),
      getPageJson: async (pageId: string) => ({
        id: pageId,
        slugId: 's',
        title: 't',
        parentPageId: null,
        spaceId: 'sp',
        updatedAt: 'now',
        content: {} as unknown,
      }),
      importPageMarkdown: async () => ({}),
      // Drifted: returns a bare object with NO data.id.
      createPage: async () => ({ success: true }),
      deletePage: async () => ({}),
      movePage: async () => ({}),
      renamePage: async () => ({}),
      listRecentSince: async () => [] as unknown[],
      listTrash: async () => [] as unknown[],
      restorePage: async () => ({}),
    };
    // @ts-expect-error createPage is missing the required `data: { id }` shape.
    const _assert: GitSyncClient = bad;
    void _assert;
    expect(true).toBe(true);
  });
});
