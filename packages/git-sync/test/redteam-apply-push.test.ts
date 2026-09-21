import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { applyPushActions } from '../src/engine/push';
import type { ApplyPushDeps, PushActions } from '../src/engine/push';

const SPACE_ID = 'sp-test';

/** A recording client fake; listSpaceTree/createPage configurable per test. */
function makeClient() {
  return {
    listSpaceTree: vi.fn(async () => ({
      pages: [] as { id: string; parentPageId?: string | null; title?: string }[],
      complete: true,
    })),
    importPageMarkdown: vi.fn(async () => ({ success: true })),
    createPage: vi.fn(
      async (
        title: string,
        _content: string,
        _spaceId: string,
        _parentPageId?: string,
      ) => ({ data: { id: 'assigned-id', title }, success: true }),
    ),
    deletePage: vi.fn(async () => ({ success: true })),
    movePage: vi.fn(async () => ({ success: true })),
    renamePage: vi.fn(async () => ({ success: true })),
  };
}

function makeGit() {
  return {
    updateRef: vi.fn(async () => {}),
    fastForwardBranch: vi.fn(async () => ({ ok: true })),
    showFileAtRef: vi.fn(async () => null),
  };
}

/** A recording fs fake over a path->text store (writes are read back). */
function makeFs(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial };
  const fs = {
    readFile: vi.fn(async (path: string) => {
      if (!(path in store)) throw new Error(`no such file: ${path}`);
      return store[path];
    }),
    writeFile: vi.fn(async (path: string, text: string) => {
      store[path] = text;
    }),
  };
  return { fs, store };
}

function deps(client: any, git: any, fs: ReturnType<typeof makeFs>): ApplyPushDeps {
  return {
    client,
    git: git as any,
    readFile: fs.fs.readFile,
    writeFile: fs.fs.writeFile,
    spaceId: SPACE_ID,
  };
}

function actions(partial: Partial<PushActions>): PushActions {
  return {
    creates: [],
    updates: [],
    deletes: [],
    renamesMoves: [],
    skipped: [],
    ...partial,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// === Finding #6 — adopt must NOT clobber an arbitrary duplicate-title sibling ===
// The retry-adopt map keys pages by (parentPageId|root, title). When TWO root
// siblings share the title 'Foo', the key collides and the map keeps the FIRST
// (p1). A brand-new untracked 'Foo/Foo.md' (no gitmost_id) then "adopts" p1 and
// pushes its body over it via importPageMarkdown — silently overwriting an
// arbitrary, possibly unrelated, existing page. Desired: a fresh createPage, or
// an ambiguity skip — NEVER a silent overwrite of an existing sibling.
describe('redteam #6 — adopt clobbers wrong duplicate-title sibling', () => {
  it('does NOT overwrite an arbitrary duplicate-title sibling (p1) via importPageMarkdown', async () => {
    const client = makeClient();
    client.listSpaceTree.mockResolvedValue({
      pages: [
        { id: 'p1', parentPageId: null, title: 'Foo' },
        { id: 'p2', parentPageId: null, title: 'Foo' },
      ],
      complete: true,
    });
    const git = makeGit();
    // A brand-new local file with NO gitmost_id frontmatter.
    const fs = makeFs({ 'Foo/Foo.md': '# Foo\n\nfresh foo body\n' });

    await applyPushActions(
      deps(client, git, fs),
      actions({ creates: [{ path: 'Foo/Foo.md' }] }),
    );

    // The wrong sibling must never be overwritten with our body.
    const clobberedP1 = client.importPageMarkdown.mock.calls.some(
      (c: any[]) => c[0] === 'p1',
    );
    expect(clobberedP1).toBe(false);
  });
});

// === Finding #12 — new child under new parent must be parented, not put at ROOT ===
// creates are applied in path order: 'Proj/Apple.md' (Apple < Proj) BEFORE
// 'Proj/Proj.md'. When Apple is created first, its parent folder-note
// 'Proj/Proj.md' has no gitmost_id yet, so the parent resolves to null and Apple
// is created at the SPACE ROOT instead of under Proj. Desired: the parent page is
// created before its child, so Apple's createPage receives Proj's assigned id.
describe('redteam #12 — new child under new parent placed at ROOT', () => {
  it('createPage for Apple receives parentPageId === the id assigned to Proj', async () => {
    let seq = 0;
    const client = makeClient();
    client.createPage.mockImplementation(
      async (title: string) => ({
        data: { id: `id-${++seq}`, title },
        success: true,
      }),
    );
    const git = makeGit();
    // Both brand-new local files, neither carrying a gitmost_id yet. writeFile
    // updates the store so readFile reads back any pageId written during the run.
    const fs = makeFs({
      'Proj/Apple.md': '# Apple\n\napple body\n',
      'Proj/Proj.md': '# Proj\n\nproj body\n',
    });

    await applyPushActions(
      deps(client, git, fs),
      actions({
        creates: [{ path: 'Proj/Apple.md' }, { path: 'Proj/Proj.md' }],
      }),
    );

    const calls = client.createPage.mock.calls;
    const results = client.createPage.mock.results;
    const projIdx = calls.findIndex((c: any[]) => c[0] === 'Proj');
    const appleIdx = calls.findIndex((c: any[]) => c[0] === 'Apple');
    expect(projIdx).toBeGreaterThanOrEqual(0);
    expect(appleIdx).toBeGreaterThanOrEqual(0);
    const projId = ((await results[projIdx].value) as any).data.id;
    const appleParentPageId = calls[appleIdx][3];

    // Apple is a child of Proj -> it must be created under Proj, not at ROOT.
    expect(appleParentPageId).toBe(projId);
  });
});
