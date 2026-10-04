import * as Y from 'yjs';

import { mergeXmlFragments3Way } from '../../../collaboration/merge/yjs-body-merge';

/**
 * Convergence repro for the git-ingest "silent revert" data-loss bug.
 *
 * ROOT CAUSE (confirmed): the merge logic itself is correct, but the git-ingest
 * write was applied via `openDirectConnection` on whichever instance/process
 * runs git-sync (the api/worker). When an editor is connected to a DIFFERENT
 * collab instance/process, that opens a SEPARATE, detached Y.Doc. The merge
 * lands in that detached doc (and the DB), but the live editor's Y.Doc never
 * receives the Yjs update — so its next debounced autosave overwrites the DB
 * with its STALE state and silently reverts the git change.
 *
 * These tests reproduce the invariant deterministically at the Yjs level (two
 * Y.Docs exchanging updates), because the real failure is DISTRIBUTED — it only
 * manifests when the write and the editor live on different instances, which a
 * single in-process Hocuspocus cannot reproduce (in one process the direct
 * connection already shares the editor's doc). HONEST SCOPE: this models the two
 * outcomes; full cross-instance convergence is not (and cannot be) proven in a
 * unit test without a live multi-instance Hocuspocus + redis.
 *
 *   PATH B (the BUG): the git update is NOT delivered to the editor's doc — the
 *     editor's later autosave reverts the change. Asserts the LOSS.
 *   PATH A (the FIX): the git update IS delivered to the editor's doc as a Yjs
 *     update — which is exactly what running the merge on the OWNING instance's
 *     shared Document does (its update is broadcast to every connection). The
 *     editor's CRDT converges and a later autosave preserves the git change.
 *
 * The fix routes git-sync's body write through CollaborationGateway.writePageBody
 * (the custom-event channel) so it executes on the owning instance — turning
 * PATH B into PATH A.
 */

type Spec = { text: string; id?: string };

// Build a Y.XmlFragment('default'). `id` is set only when provided, mirroring
// the live doc (block UniqueIDs present) vs a git-parsed body (ids absent).
function buildFragment(doc: Y.Doc, specs: Spec[]): Y.XmlFragment {
  const frag = doc.getXmlFragment('default');
  const blocks = specs.map((s) => {
    const el = new Y.XmlElement('paragraph');
    if (s.id) el.setAttribute('id', s.id);
    const t = new Y.XmlText();
    if (s.text) t.insert(0, s.text);
    el.insert(0, [t]);
    return el;
  });
  if (blocks.length) frag.insert(0, blocks);
  return frag;
}

const texts = (frag: Y.XmlFragment): string[] =>
  frag.toArray().map((el) =>
    (el as Y.XmlElement)
      .toArray()
      .map((c) => (c as Y.XmlText).toString())
      .join(''),
  );

// Append '!' to the end of the given block's text — a tiny human edit that
// stands in for a connected editor's autosave-triggering keystroke.
function humanEdit(doc: Y.Doc, blockIndex: number, mark = '!'): void {
  const frag = doc.getXmlFragment('default');
  const el = frag.get(blockIndex) as Y.XmlElement;
  const t = el.get(0) as Y.XmlText;
  doc.transact(() => t.insert(t.length, mark));
}

describe('git-ingest convergence with an open editor', () => {
  // Shared setup: the page is persisted with two blocks (live ids), and BOTH the
  // server-side ingest doc (S) and the connected editor's doc (C) load that same
  // state — they start fully synced, exactly like two instances that each loaded
  // the page from the DB.
  function setup() {
    const db = new Y.Doc();
    buildFragment(db, [
      { text: 'alpha', id: 'p1' },
      { text: 'beta', id: 'p2' },
    ]);
    const state0 = Y.encodeStateAsUpdate(db);

    const server = new Y.Doc(); // where the git merge is applied
    Y.applyUpdate(server, state0);
    const editor = new Y.Doc(); // the browser's live in-memory doc
    Y.applyUpdate(editor, state0);

    // base (last-synced, from git markdown — no ids) == the pre-change content.
    const baseDoc = new Y.Doc();
    const baseFrag = buildFragment(baseDoc, [{ text: 'alpha' }, { text: 'beta' }]);
    return { state0, server, editor, baseFrag };
  }

  // git changed the SECOND block alpha/beta -> beta2; the editor is idle on it.
  function applyGitMerge(server: Y.Doc, baseFrag: Y.XmlFragment): Uint8Array {
    const targetDoc = new Y.Doc();
    const targetFrag = buildFragment(targetDoc, [
      { text: 'alpha' },
      { text: 'beta2' },
    ]);
    let captured: Uint8Array | null = null;
    const onUpdate = (u: Uint8Array) => {
      // Accumulate (the merge emits one update per op when unwrapped); here a
      // single transact yields one update covering the whole merge.
      captured = captured ? Y.mergeUpdates([captured, u]) : u;
    };
    server.on('update', onUpdate);
    server.transact(() =>
      mergeXmlFragments3Way(
        server.getXmlFragment('default'),
        targetFrag,
        baseFrag,
      ),
    );
    server.off('update', onUpdate);
    return captured!;
  }

  it('PATH B (the BUG): undelivered git update is reverted by the editor autosave — DATA LOSS', () => {
    const { server, editor, baseFrag } = setup();

    // git merge lands on the server doc only.
    applyGitMerge(server, baseFrag);
    expect(texts(server.getXmlFragment('default'))).toEqual(['alpha', 'beta2']);

    // The editor NEVER receives the update (detached doc on another instance).
    // It makes an unrelated edit on block 0 and autosaves its full state.
    humanEdit(editor, 0);
    const persisted = new Y.Doc();
    Y.applyUpdate(persisted, Y.encodeStateAsUpdate(editor));

    // git's 'beta2' is gone — the page reverted to 'beta'. This is the bug.
    expect(texts(persisted.getXmlFragment('default'))).toEqual([
      'alpha!',
      'beta',
    ]);
  });

  it('PATH A (the FIX): delivering the git update to the editor converges — git change SURVIVES', () => {
    const { server, editor, baseFrag } = setup();

    // git merge on the server doc, capturing the broadcastable Yjs update.
    const gitUpdate = applyGitMerge(server, baseFrag);

    // Running on the OWNING instance broadcasts the update to the connected
    // editor (Document.handleUpdate). Model that: the editor applies it.
    Y.applyUpdate(editor, gitUpdate);
    expect(texts(editor.getXmlFragment('default'))).toEqual(['alpha', 'beta2']);

    // The editor now autosaves (unrelated edit on block 0). Its full state still
    // carries git's change — no revert.
    humanEdit(editor, 0);
    const persisted = new Y.Doc();
    Y.applyUpdate(persisted, Y.encodeStateAsUpdate(editor));
    expect(texts(persisted.getXmlFragment('default'))).toEqual([
      'alpha!',
      'beta2',
    ]);
  });

  it('PATH A — concurrent edits to DIFFERENT paragraphs both survive (finding #2)', () => {
    const { server, editor, baseFrag } = setup();

    // The editor is actively editing block 0 (concurrent with the push).
    humanEdit(editor, 0, ' EDIT');

    // git changes block 1; merge on the server, broadcast to the editor.
    const gitUpdate = applyGitMerge(server, baseFrag);
    Y.applyUpdate(editor, gitUpdate);

    // Both sides preserved: the human's block-0 edit AND git's block-1 change.
    const persisted = new Y.Doc();
    Y.applyUpdate(persisted, Y.encodeStateAsUpdate(editor));
    expect(texts(persisted.getXmlFragment('default'))).toEqual([
      'alpha EDIT',
      'beta2',
    ]);
  });
});
