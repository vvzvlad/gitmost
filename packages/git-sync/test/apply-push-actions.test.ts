import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { applyPushActions, LAST_PUSHED_REF } from '../src/engine/push';
import { bodyHash } from '../src/engine/loop-guard';
import type { ApplyPushDeps, PushActions } from '../src/engine/push';
import { parsePageFile, serializePageFile } from '@docmost/prosemirror-markdown';

// The Docmost space this vault mirrors (native files carry no spaceId; the run
// supplies it). A CREATE targets this space.
const SPACE_ID = 'sp-test';

// FS→Docmost push, FIRST increment (SPEC §6). `applyPushActions` is the THIN IO
// half: create/update/delete via FAKES that record every call — no real network,
// git, or fs. Asserts: update uses importPageMarkdown (collab path, SPEC
// §2/§15.6); create writes the assigned pageId BACK into the file meta; delete
// soft-deletes; rename/move is returned as `deferred` with NO client call; the
// last-pushed ref is advanced.

/** A recording client fake; createPage returns a configurable assigned id. */
function makeClient(opts?: { createId?: string }) {
  const client = {
    // Empty live tree by default -> creates take the normal createPage path; the
    // retry-adopt lookup only fires when a (parentPageId, title) node matches.
    listSpaceTree: vi.fn(async () => ({
      pages: [] as { id: string; parentPageId?: string | null; title?: string }[],
      complete: true,
    })),
    importPageMarkdown: vi.fn(async (_pageId: string, _md: string) => ({
      success: true,
    })),
    createPage: vi.fn(
      async (
        title: string,
        _content: string,
        _spaceId: string,
        _parentPageId?: string,
      ) => ({
        // Mirrors the real `createPage` shape: `{ data: { id, ... }, success }`.
        data: { id: opts?.createId ?? 'assigned-id', title },
        success: true,
      }),
    ),
    deletePage: vi.fn(async (_pageId: string) => ({ success: true })),
    movePage: vi.fn(
      async (
        _pageId: string,
        _parentPageId: string | null,
        _position?: string,
      ) => ({ success: true }),
    ),
    renamePage: vi.fn(async (pageId: string, title: string) => ({
      success: true,
      pageId,
      title,
    })),
  };
  return client;
}

/**
 * A recording git fake: `updateRef` (advance last-pushed) and `fastForwardBranch`
 * (advance the `docmost` mirror, the loop-close). `ffResult` configures what the
 * ff returns (default a successful advance).
 */
function makeGit(opts?: {
  ffResult?: { ok: boolean; reason?: string };
  /** Pre-image tree at `refs/docmost/last-pushed` (path -> text). */
  prevTree?: Record<string, string>;
}) {
  const updateRefCalls: { ref: string; target: string }[] = [];
  const ffCalls: { branch: string; toCommit: string }[] = [];
  const prevTree = opts?.prevTree ?? {};
  const git = {
    updateRef: vi.fn(async (ref: string, target: string) => {
      updateRefCalls.push({ ref, target });
    }),
    fastForwardBranch: vi.fn(async (branch: string, toCommit: string) => {
      ffCalls.push({ branch, toCommit });
      return opts?.ffResult ?? { ok: true };
    }),
    // The move/rename classifier reads the PREVIOUS parent folder's `.md` at
    // refs/docmost/last-pushed via this; `null` when absent there (SPEC §5).
    showFileAtRef: vi.fn(async (_ref: string, path: string) =>
      path in prevTree ? prevTree[path] : null,
    ),
  };
  return { git, updateRefCalls, ffCalls };
}

/** A recording fs fake over a path->text store. */
function makeFs(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial };
  const writes: { path: string; text: string }[] = [];
  const reads: string[] = [];
  const fs = {
    readFile: vi.fn(async (path: string) => {
      reads.push(path);
      if (!(path in store)) throw new Error(`no such file: ${path}`);
      return store[path];
    }),
    writeFile: vi.fn(async (path: string, text: string) => {
      store[path] = text;
      writes.push({ path, text });
    }),
  };
  return { fs, store, writes, reads };
}

function deps(client: any, git: any, fs: ReturnType<typeof makeFs>): ApplyPushDeps {
  return {
    client,
    git,
    readFile: fs.fs.readFile,
    writeFile: fs.fs.writeFile,
    spaceId: SPACE_ID,
  };
}

/**
 * A native page file: `gitmost_id` frontmatter + a clean body. The TITLE is NOT
 * stored — it is derived from the filename — so this helper takes only a pageId.
 * Used to seed both the working tree (fs) and the prev tree (showFileAtRef).
 */
function fileFor(pageId: string, body = 'body'): string {
  return serializePageFile(pageId, body);
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

describe('applyPushActions — update (collab path, SPEC §2/§15.6)', () => {
  it('reads the file and calls importPageMarkdown with the STRIPPED body', async () => {
    const fileBody = fileFor('p-1', 'updated body');
    const client = makeClient();
    const { git } = makeGit();
    const fs = makeFs({ 'Doc.md': fileBody });

    const res = await applyPushActions(
      deps(client, git, fs),
      actions({ updates: [{ pageId: 'p-1', path: 'Doc.md' }] }),
    );

    expect(res.updated).toBe(1);
    // The collab/Yjs write path is used — NOT a raw jsonb overwrite. The pushed
    // content is the CLEAN body (no gitmost_id frontmatter leaks to Docmost).
    expect(client.importPageMarkdown).toHaveBeenCalledTimes(1);
    expect(client.importPageMarkdown).toHaveBeenCalledWith('p-1', 'updated body', null);
    // No raw-overwrite path exists on the injected client surface at all.
    expect((client as any).updatePageJson).toBeUndefined();
    expect(client.createPage).not.toHaveBeenCalled();
    expect(client.deletePage).not.toHaveBeenCalled();
  });

  it('forwards the last-pushed base body (3-way merge ancestor) when present', async () => {
    const client = makeClient();
    // The pre-image (refs/docmost/last-pushed) carries the base version; both
    // sides are stripped to their clean body for a body-to-body 3-way merge.
    const { git } = makeGit({ prevTree: { 'Doc.md': fileFor('p-1', 'base body') } });
    const fs = makeFs({ 'Doc.md': fileFor('p-1', 'updated body') });

    await applyPushActions(
      deps(client, git, fs),
      actions({ updates: [{ pageId: 'p-1', path: 'Doc.md' }] }),
    );

    // importPageMarkdown receives the stripped base so the server 3-way merges it.
    expect(client.importPageMarkdown).toHaveBeenCalledWith(
      'p-1',
      'updated body',
      'base body',
    );
    expect(git.showFileAtRef).toHaveBeenCalledWith(LAST_PUSHED_REF, 'Doc.md');
  });

  it('RENAME-derived update resolves the 3-way base from the OLD path (basePath), not the new path', async () => {
    // The residual flaw after F4: a rename+edit emits an UPDATE whose `path` is the
    // NEW path, but at refs/docmost/last-pushed the file lived at the OLD path. If
    // the base were looked up at the NEW path it would return null and the merge
    // would degrade to a 2-way (clobbering a concurrent Docmost-side edit). The fix
    // threads `basePath = oldPath` so the base is the pre-rename file (honest 3-way).
    const client = makeClient();
    // The pre-image tree only has the OLD path; the NEW path does NOT exist there.
    const { git } = makeGit({
      prevTree: { 'Old/Path.md': fileFor('p-mv', 'base body') },
    });
    // The working tree has the file at its NEW path with the EDITED body.
    const fs = makeFs({ 'New/Path.md': fileFor('p-mv', 'edited body') });

    await applyPushActions(
      deps(client, git, fs),
      actions({
        updates: [
          { pageId: 'p-mv', path: 'New/Path.md', basePath: 'Old/Path.md' },
        ],
      }),
    );

    // The BODY is read from the NEW path (working tree) -> the EDITED body is pushed
    // (not lost). The BASE is resolved from the OLD path -> a NON-NULL common
    // ancestor ('base body'), so importPageMarkdown does an honest 3-way merge and
    // a concurrent Docmost-side edit to a different block is preserved (not rolled
    // back to git's body, which a null 2-way base would have done).
    expect(client.importPageMarkdown).toHaveBeenCalledWith(
      'p-mv',
      'edited body',
      'base body',
    );
    // The base lookup hit the OLD path, NOT the new path (the core of the fix).
    expect(git.showFileAtRef).toHaveBeenCalledWith(LAST_PUSHED_REF, 'Old/Path.md');
    expect(git.showFileAtRef).not.toHaveBeenCalledWith(
      LAST_PUSHED_REF,
      'New/Path.md',
    );
  });

  it('PURE rename (no body edit) still 3-way merges against the old-path base (no 2-way clobber)', async () => {
    // Even a rename with NO body change pushes a body update (F4). Before this fix
    // its base would be null (new path absent at last-pushed) -> a 2-way merge that
    // could roll a concurrent Docmost edit back to git's body. With basePath=oldPath
    // the base equals the (unchanged) body, so the 3-way merge of
    // (base=oldBody, incoming=oldBody) is a no-op and any live Docmost edit survives.
    const client = makeClient();
    const { git } = makeGit({
      prevTree: { 'Old.md': fileFor('p-pure', 'same body') },
    });
    const fs = makeFs({ 'New.md': fileFor('p-pure', 'same body') });

    await applyPushActions(
      deps(client, git, fs),
      actions({
        updates: [{ pageId: 'p-pure', path: 'New.md', basePath: 'Old.md' }],
      }),
    );

    // Incoming body == base body == 'same body' -> the 3-way merge is a no-op AND
    // preserves any concurrent live edit (the base is the real ancestor, not null).
    expect(client.importPageMarkdown).toHaveBeenCalledWith(
      'p-pure',
      'same body',
      'same body',
    );
    expect(git.showFileAtRef).toHaveBeenCalledWith(LAST_PUSHED_REF, 'Old.md');
  });
});

describe('applyPushActions — create (assigned pageId written back to meta)', () => {
  it('createPage gets title/parent from the PATH and writes the pageId back', async () => {
    // A brand-new local file with NO frontmatter (a hand-written Obsidian note)
    // under a parent folder. title = filename, parent = the folder's folder-note,
    // space = the run's space — all DERIVED, none stored in the file.
    const client = makeClient({ createId: 'page-new-42' });
    const { git } = makeGit();
    const fs = makeFs({
      'Parent/My New Page.md': '# My New Page\n\nbody text\n',
      // The enclosing folder's folder-note identifies the parent page.
      'Parent/Parent.md': fileFor('parent-9'),
    });

    const res = await applyPushActions(
      deps(client, git, fs),
      actions({ creates: [{ path: 'Parent/My New Page.md' }] }),
    );

    expect(res.created).toBe(1);
    expect(client.createPage).toHaveBeenCalledTimes(1);
    const [title, content, spaceId, parentPageId] =
      client.createPage.mock.calls[0];
    expect(title).toBe('My New Page'); // from the filename
    expect(spaceId).toBe(SPACE_ID); // from the run
    expect(parentPageId).toBe('parent-9'); // from the folder's folder-note
    expect(content).toContain('body text');

    // The file was rewritten with the assigned pageId as gitmost_id frontmatter,
    // body preserved, NO docmost:meta.
    expect(fs.writes.map((w) => w.path)).toEqual(['Parent/My New Page.md']);
    const rewritten = fs.store['Parent/My New Page.md'];
    expect(rewritten.startsWith('---\ngitmost_id: page-new-42\n---')).toBe(true);
    expect(rewritten).not.toContain('docmost:meta');
    const parsed = parsePageFile(rewritten);
    expect(parsed.id).toBe('page-new-42');
    expect(parsed.body).toContain('body text');

    // The write-back is recorded so a follow-up commit can be made.
    expect(res.writtenBack).toEqual([
      { path: 'Parent/My New Page.md', pageId: 'page-new-42' },
    ]);
  });
});

describe('applyPushActions — create RETRY-ADOPT idempotency (#1)', () => {
  // Create is NOT atomic with the pageId write-back: if a prior cycle created the
  // page in Docmost but died before persisting the id back, the file is re-seen as
  // a CREATE. The applier must ADOPT the existing page (write the id back + push the
  // body as an idempotent UPDATE) instead of calling createPage again (which would
  // duplicate the page). The live page is matched by (parentPageId, title).
  it('ADOPTS an existing page (no createPage) when the live tree already has a match', async () => {
    const client = makeClient({ createId: 'should-not-be-used' });
    // The live Docmost tree already has the page this create targets:
    //   title "My New Page" under the parent folder's page `parent-9`.
    client.listSpaceTree.mockResolvedValue({
      pages: [
        { id: 'parent-9', parentPageId: null, title: 'Parent' },
        { id: 'already-created-7', parentPageId: 'parent-9', title: 'My New Page' },
      ],
      complete: true,
    });
    const { git } = makeGit();
    const fs = makeFs({
      'Parent/My New Page.md': '# My New Page\n\nbody text\n',
      'Parent/Parent.md': fileFor('parent-9'),
    });

    const res = await applyPushActions(
      deps(client, git, fs),
      actions({ creates: [{ path: 'Parent/My New Page.md' }] }),
    );

    expect(res.created).toBe(1);
    // CRITICAL: createPage was NOT called — no duplicate page in Docmost.
    expect(client.createPage).not.toHaveBeenCalled();
    // The body was pushed as an UPDATE targeting the EXISTING id (idempotent).
    expect(client.importPageMarkdown).toHaveBeenCalledTimes(1);
    expect(client.importPageMarkdown).toHaveBeenCalledWith(
      'already-created-7',
      expect.stringContaining('body text'),
      null,
    );

    // The file was rewritten with the EXISTING id as gitmost_id (now tracked).
    expect(fs.writes.map((w) => w.path)).toEqual(['Parent/My New Page.md']);
    const rewritten = fs.store['Parent/My New Page.md'];
    expect(parsePageFile(rewritten).id).toBe('already-created-7');
    expect(res.writtenBack).toEqual([
      { path: 'Parent/My New Page.md', pageId: 'already-created-7' },
    ]);
  });

  it('does NOT adopt from an INCOMPLETE tree even when a node matches (falls back to createPage)', async () => {
    // Defensive guard: retry-adopt is only safe from a COMPLETE live tree. A
    // TRUNCATED tree (complete:false) could miss an already-created page and let
    // us duplicate it — the very thing adopt prevents. So on an incomplete tree
    // the map is NOT built and we MUST fall back to the normal createPage path,
    // even though this particular tree happens to carry a matching node.
    const client = makeClient({ createId: 'page-new-55' });
    // A node that WOULD match the create's (parentPageId 'parent-9', title
    // 'My New Page') — but the tree is flagged incomplete, so it must be ignored.
    client.listSpaceTree.mockResolvedValue({
      pages: [
        { id: 'parent-9', parentPageId: null, title: 'Parent' },
        { id: 'already-created-7', parentPageId: 'parent-9', title: 'My New Page' },
      ],
      complete: false,
    });
    const { git } = makeGit();
    const fs = makeFs({
      'Parent/My New Page.md': '# My New Page\n\nbody text\n',
      'Parent/Parent.md': fileFor('parent-9'),
    });

    const res = await applyPushActions(
      deps(client, git, fs),
      actions({ creates: [{ path: 'Parent/My New Page.md' }] }),
    );

    expect(res.created).toBe(1);
    // CRITICAL: createPage ran (normal path) — adopt was suppressed by complete:false.
    expect(client.createPage).toHaveBeenCalledTimes(1);
    // No adopt-UPDATE happened: the matching node was NOT trusted.
    expect(client.importPageMarkdown).not.toHaveBeenCalled();
    // The file carries the NEWLY assigned id, not the would-be adopted one.
    expect(parsePageFile(fs.store['Parent/My New Page.md']).id).toBe('page-new-55');
    expect(res.writtenBack).toEqual([
      { path: 'Parent/My New Page.md', pageId: 'page-new-55' },
    ]);
  });

  it('a NORMAL create (empty live tree) STILL calls createPage', async () => {
    // No matching live node -> the happy path: createPage runs, no adopt.
    const client = makeClient({ createId: 'page-new-99' });
    // makeClient's listSpaceTree returns an empty tree by default.
    const { git } = makeGit();
    const fs = makeFs({
      'Parent/My New Page.md': '# My New Page\n\nbody text\n',
      'Parent/Parent.md': fileFor('parent-9'),
    });

    const res = await applyPushActions(
      deps(client, git, fs),
      actions({ creates: [{ path: 'Parent/My New Page.md' }] }),
    );

    expect(res.created).toBe(1);
    expect(client.createPage).toHaveBeenCalledTimes(1);
    // No adopt-UPDATE happened (importPageMarkdown is the update path).
    expect(client.importPageMarkdown).not.toHaveBeenCalled();
    expect(parsePageFile(fs.store['Parent/My New Page.md']).id).toBe('page-new-99');
  });

  it('a thrown adopt is isolated as a `create` failure (per-page isolation, SPEC §12)', async () => {
    const client = makeClient({ createId: 'unused' });
    client.listSpaceTree.mockResolvedValue({
      pages: [{ id: 'existing-1', parentPageId: null, title: 'Doc' }],
      complete: true,
    });
    // The adopt pushes the body as an UPDATE; make that throw.
    client.importPageMarkdown.mockRejectedValue(new Error('adopt boom'));
    const { git, updateRefCalls } = makeGit();
    const fs = makeFs({ 'Doc.md': '# Doc\n\nbody\n' });

    const res = await applyPushActions(
      deps(client, git, fs),
      actions({ creates: [{ path: 'Doc.md' }] }),
      'sha-adopt-fail',
    );

    expect(res.created).toBe(0);
    expect(client.createPage).not.toHaveBeenCalled();
    expect(res.failures).toEqual([
      { kind: 'create', path: 'Doc.md', error: 'adopt boom' },
    ]);
    // A failure means the refs are NOT advanced (re-run retries cleanly, §12).
    expect(res.lastPushedAdvanced).toBe(false);
    expect(updateRefCalls).toEqual([]);
  });
});

describe('applyPushActions — delete (soft-delete to Trash, SPEC §8)', () => {
  it('calls deletePage(pageId)', async () => {
    const client = makeClient();
    const { git } = makeGit();
    const fs = makeFs();

    const res = await applyPushActions(
      deps(client, git, fs),
      actions({ deletes: [{ pageId: 'p-del' }] }),
    );

    expect(res.deleted).toBe(1);
    expect(client.deletePage).toHaveBeenCalledTimes(1);
    expect(client.deletePage).toHaveBeenCalledWith('p-del');
    // No body read needed for a delete.
    expect(fs.reads).toEqual([]);
  });
});

// FS→Docmost push #3 (SPEC §5/§6/§16): the move/rename APPLY. The classifier
// resolves the parent from the FILE PATH (the enclosing folder's `.md`), not
// stale `meta.parentPageId`, then `applyPushActions` calls move_page / rename_page
// (both for a reparent+retitle) or records a path-only NO-OP with NO client call.

describe('applyPushActions — move (parent changed, title same; SPEC §5/§16)', () => {
  it('calls movePage(pageId, newParent) and NOT renamePage', async () => {
    // The page moved from the space root (Doc.md) under a folder (Parent/Doc.md).
    // The new parent page owns folder `Parent/`, so its file is the FOLDER-NOTE
    // `Parent/Parent.md`, whose gitmost_id is the parent id.
    const client = makeClient();
    const { git } = makeGit({
      // Prev pre-image: the file used to sit at the root (parent ROOT).
      prevTree: { 'Doc.md': fileFor('p-mv') },
    });
    const fs = makeFs({
      // Current tree: the moved file + its new parent folder's folder-note.
      'Parent/Doc.md': fileFor('p-mv'),
      'Parent/Parent.md': fileFor('parent-id'),
    });

    const res = await applyPushActions(
      deps(client, git, fs),
      actions({
        renamesMoves: [
          { pageId: 'p-mv', oldPath: 'Doc.md', newPath: 'Parent/Doc.md' },
        ],
      }),
    );

    expect(res.moved).toBe(1);
    expect(res.renamed).toBe(0);
    expect(client.movePage).toHaveBeenCalledTimes(1);
    // Reparented under `parent-id`; position left UNDEFINED (client default).
    expect(client.movePage).toHaveBeenCalledWith('p-mv', 'parent-id');
    expect(client.renamePage).not.toHaveBeenCalled();
    expect(res.noops).toEqual([]);
  });
});

describe('applyPushActions — move-to-root (newParent null; SPEC §16)', () => {
  it('calls movePage(pageId, null) when the file lands at the space root', async () => {
    const client = makeClient();
    const { git } = makeGit({
      // Prev: the file used to live under `Parent/`, so its old parent is the
      // page whose folder-note is `Parent/Parent.md` (parent-id).
      prevTree: {
        'Parent/Doc.md': fileFor('p-mv'),
        'Parent/Parent.md': fileFor('parent-id'),
      },
    });
    // Current: the file is now at the root -> no enclosing folder -> parent ROOT.
    const fs = makeFs({ 'Doc.md': fileFor('p-mv') });

    const res = await applyPushActions(
      deps(client, git, fs),
      actions({
        renamesMoves: [
          { pageId: 'p-mv', oldPath: 'Parent/Doc.md', newPath: 'Doc.md' },
        ],
      }),
    );

    expect(res.moved).toBe(1);
    expect(client.movePage).toHaveBeenCalledWith('p-mv', null);
    expect(client.renamePage).not.toHaveBeenCalled();
  });
});

describe('applyPushActions — rename (same parent, title changed; SPEC §5/§6)', () => {
  it('calls renamePage(pageId, title-from-filename) and NOT movePage', async () => {
    // Same enclosing folder on both sides (parent unchanged), the FILENAME (=
    // title) changed Old -> New -> a pure rename to the new filename's title.
    const client = makeClient();
    const { git } = makeGit({
      prevTree: {
        'Folder/Old.md': fileFor('p-rn'),
        'Folder/Folder.md': fileFor('folder-id'),
      },
    });
    const fs = makeFs({
      'Folder/New.md': fileFor('p-rn'),
      'Folder/Folder.md': fileFor('folder-id'),
    });

    const res = await applyPushActions(
      deps(client, git, fs),
      actions({
        renamesMoves: [
          { pageId: 'p-rn', oldPath: 'Folder/Old.md', newPath: 'Folder/New.md' },
        ],
      }),
    );

    expect(res.renamed).toBe(1);
    expect(res.moved).toBe(0);
    expect(client.renamePage).toHaveBeenCalledTimes(1);
    // The title is the NEW filename (no extension), not a stored meta title.
    expect(client.renamePage).toHaveBeenCalledWith('p-rn', 'New');
    expect(client.movePage).not.toHaveBeenCalled();
  });
});

describe('applyPushActions — both (reparent + retitle; move THEN rename)', () => {
  it('calls movePage first, then renamePage', async () => {
    const callOrder: string[] = [];
    const client = makeClient();
    client.movePage.mockImplementation(async () => {
      callOrder.push('move');
      return { success: true };
    });
    client.renamePage.mockImplementation(async (pageId: string, title: string) => {
      callOrder.push('rename');
      return { success: true, pageId, title };
    });
    const { git } = makeGit({
      // Prev: at root (parent ROOT), filename `Old`.
      prevTree: { 'Old.md': fileFor('p-x') },
    });
    const fs = makeFs({
      // Current: under a new folder (folder-note np-id) AND renamed to `New`.
      'NewParent/New.md': fileFor('p-x'),
      'NewParent/NewParent.md': fileFor('np-id'),
    });

    const res = await applyPushActions(
      deps(client, git, fs),
      actions({
        renamesMoves: [
          { pageId: 'p-x', oldPath: 'Old.md', newPath: 'NewParent/New.md' },
        ],
      }),
    );

    expect(res.moved).toBe(1);
    expect(res.renamed).toBe(1);
    expect(client.movePage).toHaveBeenCalledWith('p-x', 'np-id');
    expect(client.renamePage).toHaveBeenCalledWith('p-x', 'New');
    // Order matters: reparent FIRST, then retitle.
    expect(callOrder).toEqual(['move', 'rename']);
  });
});

describe('applyPushActions — noop (parent folder renamed; NO Docmost call; SPEC §5)', () => {
  it('calls NEITHER movePage NOR renamePage and records the noop', async () => {
    // The PARENT folder was renamed Old/ -> New/ (a retitle of the parent page,
    // whose folder-note kept the SAME gitmost_id). For this CHILD, neither its
    // own title (`Child`) nor its parent PAGE (same id `parent-P`) changed — only
    // an ancestor's name did. The page is its pageId; Docmost is untouched.
    const client = makeClient();
    const { git } = makeGit({
      prevTree: {
        'Old/Child.md': fileFor('p-noop'),
        'Old/Old.md': fileFor('parent-P'),
      },
    });
    const fs = makeFs({
      'New/Child.md': fileFor('p-noop'),
      'New/New.md': fileFor('parent-P'),
    });

    const res = await applyPushActions(
      deps(client, git, fs),
      actions({
        renamesMoves: [
          { pageId: 'p-noop', oldPath: 'Old/Child.md', newPath: 'New/Child.md' },
        ],
      }),
    );

    expect(res.moved).toBe(0);
    expect(res.renamed).toBe(0);
    // ZERO Docmost calls — only the ancestor folder name changed.
    expect(client.movePage).not.toHaveBeenCalled();
    expect(client.renamePage).not.toHaveBeenCalled();
    expect(res.noops).toEqual([
      {
        pageId: 'p-noop',
        oldPath: 'Old/Child.md',
        newPath: 'New/Child.md',
        reason: 'path-only-rename',
      },
    ]);
  });
});

describe('applyPushActions — move whose client call throws (SPEC §12 isolation)', () => {
  it('isolates the failure into `failures` and does NOT advance the refs', async () => {
    const client = makeClient();
    client.movePage.mockImplementation(async () => {
      throw new Error('move boom');
    });
    const { git, updateRefCalls, ffCalls } = makeGit({
      prevTree: { 'Doc.md': fileFor('p-mv') },
    });
    const fs = makeFs({
      'Parent/Doc.md': fileFor('p-mv'),
      'Parent/Parent.md': fileFor('parent-id'),
    });

    const res = await applyPushActions(
      deps(client, git, fs),
      actions({
        renamesMoves: [
          { pageId: 'p-mv', oldPath: 'Doc.md', newPath: 'Parent/Doc.md' },
        ],
      }),
      'sha-move-fail',
    );

    expect(res.moved).toBe(0);
    expect(res.failures).toEqual([
      {
        kind: 'move',
        pageId: 'p-mv',
        path: 'Parent/Doc.md',
        error: 'move boom',
      },
    ]);
    // A failure means the refs are NOT advanced — a re-run retries cleanly (§12).
    expect(res.lastPushedAdvanced).toBe(false);
    expect(updateRefCalls).toEqual([]);
    expect(ffCalls).toEqual([]);
    expect(git.updateRef).not.toHaveBeenCalled();
  });
});

describe('applyPushActions — loop-close: ref advance + docmost ff (SPEC §6 step 3 / §10)', () => {
  it('advances last-pushed AND fast-forwards the docmost mirror on a clean push', async () => {
    const client = makeClient();
    const { git, updateRefCalls, ffCalls } = makeGit();
    const fs = makeFs();

    const res = await applyPushActions(
      deps(client, git, fs),
      actions({ deletes: [{ pageId: 'p' }] }),
      'commit-sha-abc',
    );

    expect(res.lastPushedAdvanced).toBe(true);
    expect(updateRefCalls).toEqual([
      { ref: LAST_PUSHED_REF, target: 'commit-sha-abc' },
    ]);
    // The loop-close: the docmost mirror is fast-forwarded to the pushed commit.
    expect(ffCalls).toEqual([{ branch: 'docmost', toCommit: 'commit-sha-abc' }]);
    expect(res.docmostFastForward).toEqual({ ok: true });
  });

  it('surfaces a REFUSED non-fast-forward (mirror NOT clobbered)', async () => {
    const client = makeClient();
    // The ff is refused because docmost is not an ancestor of the pushed commit.
    const { git, updateRefCalls, ffCalls } = makeGit({
      ffResult: { ok: false, reason: 'not-fast-forward' },
    });
    const fs = makeFs();

    const res = await applyPushActions(
      deps(client, git, fs),
      actions({ deletes: [{ pageId: 'p' }] }),
      'sha-div',
    );

    // last-pushed still advances (it is our own marker), but the ff result is
    // surfaced so the caller can log the refusal.
    expect(res.lastPushedAdvanced).toBe(true);
    expect(updateRefCalls).toEqual([{ ref: LAST_PUSHED_REF, target: 'sha-div' }]);
    expect(ffCalls).toEqual([{ branch: 'docmost', toCommit: 'sha-div' }]);
    expect(res.docmostFastForward).toEqual({ ok: false, reason: 'not-fast-forward' });
  });

  it('does NOT advance either ref when no pushed commit is given', async () => {
    const client = makeClient();
    const { git, updateRefCalls } = makeGit();
    const fs = makeFs();

    const res = await applyPushActions(
      deps(client, git, fs),
      actions({ updates: [] }),
    );

    expect(res.lastPushedAdvanced).toBe(false);
    expect(updateRefCalls).toEqual([]);
    expect(res.docmostFastForward).toBeNull();
    expect(git.updateRef).not.toHaveBeenCalled();
    expect(git.fastForwardBranch).not.toHaveBeenCalled();
  });
});

describe('applyPushActions — per-page error isolation + refs gated on success (SPEC §12)', () => {
  it('continues the batch when an update throws; records the failure; refs NOT advanced', async () => {
    // A client whose 2nd importPageMarkdown call throws — the 1st and 3rd must
    // still be applied, the 2nd recorded as a failure, and NO ref advanced.
    let call = 0;
    const client = {
      importPageMarkdown: vi.fn(async (_pageId: string, _md: string) => {
        call++;
        if (call === 2) throw new Error('boom on page 2');
        return { success: true };
      }),
      createPage: vi.fn(),
      deletePage: vi.fn(),
    };
    const { git, updateRefCalls, ffCalls } = makeGit();
    const fs = makeFs({
      'A.md': 'a body',
      'B.md': 'b body',
      'C.md': 'c body',
    });

    const res = await applyPushActions(
      deps(client, git, fs),
      actions({
        updates: [
          { pageId: 'p-a', path: 'A.md' },
          { pageId: 'p-b', path: 'B.md' },
          { pageId: 'p-c', path: 'C.md' },
        ],
      }),
      'sha-partial',
    );

    // The 1st and 3rd were applied; the 2nd threw.
    expect(res.updated).toBe(2);
    expect(client.importPageMarkdown).toHaveBeenCalledTimes(3);
    expect(client.importPageMarkdown).toHaveBeenNthCalledWith(1, 'p-a', 'a body', null);
    expect(client.importPageMarkdown).toHaveBeenNthCalledWith(3, 'p-c', 'c body', null);

    // The failure is recorded with kind/pageId/path/error.
    expect(res.failures).toEqual([
      { kind: 'update', pageId: 'p-b', path: 'B.md', error: 'boom on page 2' },
    ]);

    // Only the successful pages carry a loop-guard push record.
    expect(res.pushed.map((p) => p.pageId)).toEqual(['p-a', 'p-c']);

    // A PARTIAL push advances NEITHER ref, so a re-run retries cleanly (§12).
    expect(res.lastPushedAdvanced).toBe(false);
    expect(updateRefCalls).toEqual([]);
    expect(ffCalls).toEqual([]);
    expect(res.docmostFastForward).toBeNull();
    expect(git.updateRef).not.toHaveBeenCalled();
    expect(git.fastForwardBranch).not.toHaveBeenCalled();
  });
});

describe('applyPushActions — loop-guard push record (SPEC §10)', () => {
  it('records pageId + updatedAt + bodyHash per applied update', async () => {
    const fileBody = fileFor('p-1', 'updated body');
    const client = {
      importPageMarkdown: vi.fn(async (_pageId: string, _md: string) => ({
        // The write returns an updatedAt the loop-guard records.
        data: { updatedAt: '2026-06-20T10:00:00.000Z' },
        success: true,
      })),
      createPage: vi.fn(),
      deletePage: vi.fn(),
    };
    const { git } = makeGit();
    const fs = makeFs({ 'Doc.md': fileBody });

    const res = await applyPushActions(
      deps(client, git, fs),
      actions({ updates: [{ pageId: 'p-1', path: 'Doc.md' }] }),
    );

    expect(res.pushed).toHaveLength(1);
    expect(res.pushed[0].pageId).toBe('p-1');
    expect(res.pushed[0].updatedAt).toBe('2026-06-20T10:00:00.000Z');
    // The bodyHash is a stable sha256 hex of the pushed BODY (frontmatter stripped).
    expect(res.pushed[0].bodyHash).toBe(bodyHash('updated body'));
    expect(res.pushed[0].bodyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('omits updatedAt when the client result does not expose one', async () => {
    // A hand-written file with no frontmatter; its body is the whole text.
    const newFile = '# N\n\nfresh body\n';
    const client = makeClient({ createId: 'created-9' });
    const { git } = makeGit();
    const fs = makeFs({ 'N.md': newFile });

    const res = await applyPushActions(
      deps(client, git, fs),
      actions({ creates: [{ path: 'N.md' }] }),
    );

    expect(res.pushed).toHaveLength(1);
    expect(res.pushed[0].pageId).toBe('created-9');
    expect(res.pushed[0].updatedAt).toBeUndefined();
    // bodyHash of the pushed BODY (parsePageFile strips nothing here — no
    // frontmatter — so it is the trimmed file text).
    expect(res.pushed[0].bodyHash).toBe(bodyHash(parsePageFile(newFile).body));
  });
});

describe('applyPushActions — mixed batch + skipped passthrough', () => {
  it('applies update + create + delete and carries skipped rows through', async () => {
    const updFile = fileFor('u-1', 'upd');
    const newFile = '# N\n\nfresh body\n';
    const client = makeClient({ createId: 'created-1' });
    const { git, updateRefCalls } = makeGit();
    const fs = makeFs({ 'U.md': updFile, 'N.md': newFile });

    const skipped = [
      { path: 'Stray.md', status: 'D' as const, reason: 'no recoverable pageId' },
    ];
    const res = await applyPushActions(
      deps(client, git, fs),
      actions({
        updates: [{ pageId: 'u-1', path: 'U.md' }],
        creates: [{ path: 'N.md' }],
        deletes: [{ pageId: 'd-1' }],
        skipped,
      }),
      'sha-9',
    );

    expect(res).toMatchObject({
      created: 1,
      updated: 1,
      deleted: 1,
      lastPushedAdvanced: true,
    });
    expect(res.writtenBack).toEqual([{ path: 'N.md', pageId: 'created-1' }]);
    expect(res.skipped).toEqual(skipped);
    expect(updateRefCalls).toEqual([{ ref: LAST_PUSHED_REF, target: 'sha-9' }]);
    // The update pushes the STRIPPED body ('upd'), not the frontmatter file.
    expect(client.importPageMarkdown).toHaveBeenCalledWith('u-1', 'upd', null);
    expect(client.deletePage).toHaveBeenCalledWith('d-1');
  });
});
