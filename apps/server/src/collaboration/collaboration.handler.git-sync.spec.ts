// Exercises the REAL `gitSyncWriteBody` collab handler (the owner-routed body
// write the data-loss fix introduces). The handler imports the editor graph via
// collaboration.util / yjs.util (tiptapExtensions -> editor-ext -> react-dom,
// unloadable under jest's node env, same coupling noted in
// gitmost-datasource.service.spec.ts), so we stub those + the transformer. The
// stubbed toYdoc builds paragraph blocks straight from the ProseMirror JSON so
// we can assert convergence on real text.
jest.mock('./collaboration.util', () => ({
  tiptapExtensions: [],
  inEditorShape: (json: any) => json,
  getPageId: (name: string) => name.replace(/^page\./, ''),
  prosemirrorNodeToYElement: jest.fn(),
  // Same rule as the real helper: exactly one paragraph with no content.
  isEmptyParagraphDoc: (json: any) =>
    json?.type === 'doc' &&
    json.content?.length === 1 &&
    json.content[0]?.type === 'paragraph' &&
    !json.content[0].content?.length,
}));
jest.mock('./yjs.util', () => ({
  setYjsMark: jest.fn(),
  updateYjsMarkAttribute: jest.fn(),
}));
jest.mock('@hocuspocus/transformer', () => {
  const Yjs = require('yjs');
  return {
    TiptapTransformer: {
      toYdoc: (json: any) => {
        if (json?.__throw) throw new Error('boom: malformed doc');
        const d = new Yjs.Doc();
        const frag = d.getXmlFragment('default');
        const blocks = (json?.content ?? []).map((node: any) => {
          const el = new Yjs.XmlElement(node.type || 'paragraph');
          const text = (node.content ?? [])
            .map((t: any) => t.text ?? '')
            .join('');
          const t = new Yjs.XmlText();
          if (text) t.insert(0, text);
          el.insert(0, [t]);
          return el;
        });
        if (blocks.length) frag.insert(0, blocks);
        return d;
      },
      fromYdoc: (doc: any) => ({
        type: 'doc',
        content: doc
          .getXmlFragment('default')
          .toArray()
          .map((el: any) => {
            const text = el
              .toArray()
              .map((c: any) => c.toString())
              .join('');
            return {
              type: 'paragraph',
              content: text ? [{ type: 'text', text }] : [],
            };
          }),
      }),
    },
  };
});

import * as Y from 'yjs';
import { CollaborationHandler } from './collaboration.handler';

const pmDoc = (...paras: string[]) => ({
  type: 'doc',
  content: paras.map((text) => ({
    type: 'paragraph',
    content: text ? [{ type: 'text', text }] : [],
  })),
});

const texts = (frag: Y.XmlFragment): string[] =>
  frag.toArray().map((el) =>
    (el as Y.XmlElement)
      .toArray()
      .map((c) => (c as Y.XmlText).toString())
      .join(''),
  );

// Build a fake Hocuspocus whose openDirectConnection yields a DirectConnection
// over a REAL shared Document, with a connected "editor" doc that receives the
// shared doc's updates (modelling Document.handleUpdate's broadcast on the
// OWNING instance). Initial content carries live block ids; the editor starts
// fully synced with the shared doc.
function fakeHocuspocus(initial: { text: string; id: string }[]) {
  const shared = new Y.Doc();
  const frag = shared.getXmlFragment('default');
  shared.transact(() => {
    frag.insert(
      0,
      initial.map((s) => {
        const el = new Y.XmlElement('paragraph');
        el.setAttribute('id', s.id);
        const t = new Y.XmlText();
        if (s.text) t.insert(0, s.text);
        el.insert(0, [t]);
        return el;
      }),
    );
  });
  const editor = new Y.Doc();
  Y.applyUpdate(editor, Y.encodeStateAsUpdate(shared));
  // Broadcast relay: server-originated updates flow to the connected editor.
  shared.on('update', (u: Uint8Array, origin: any) => {
    if (origin !== 'editor') Y.applyUpdate(editor, u, 'server');
  });

  const openDirectConnection = jest.fn(async () => ({
    // DirectConnection.transact runs the fn directly against the Document (no
    // wrapping Y transaction), exactly like @hocuspocus/server.
    transact: async (fn: (doc: Y.Doc) => void) => fn(shared),
    disconnect: jest.fn(async () => undefined),
  }));

  return { hocuspocus: { openDirectConnection } as any, shared, editor };
}

describe('CollaborationHandler.gitSyncWriteBody (owner-routed body write)', () => {
  it('converges a connected editor on the git change (no silent revert)', async () => {
    const { hocuspocus, shared, editor } = fakeHocuspocus([
      { text: 'alpha', id: 'p1' },
      { text: 'beta', id: 'p2' },
    ]);
    const handler = new CollaborationHandler();
    const handlers = handler.getHandlers(hocuspocus);

    // git changed block 1 beta -> beta2; base is the pre-change content.
    await handlers.gitSyncWriteBody('page.x', {
      prosemirrorJson: pmDoc('alpha', 'beta2'),
      baseProsemirrorJson: pmDoc('alpha', 'beta'),
      userId: 'svc-user',
    });

    // The shared (owning-instance) doc holds the merge...
    expect(texts(shared.getXmlFragment('default'))).toEqual(['alpha', 'beta2']);
    // ...and the connected editor CONVERGED via the broadcast (the bug would
    // leave it on 'beta' and revert the page on its next autosave).
    expect(texts(editor.getXmlFragment('default'))).toEqual(['alpha', 'beta2']);
  });

  it('preserves a concurrent edit to a DIFFERENT block (3-way, finding #2)', async () => {
    const { hocuspocus, shared, editor } = fakeHocuspocus([
      { text: 'alpha', id: 'p1' },
      { text: 'beta', id: 'p2' },
    ]);
    // The editor is actively editing block 0 while the push arrives.
    const eFrag = editor.getXmlFragment('default');
    editor.transact(
      () => (eFrag.get(0) as Y.XmlElement).get(0) instanceof Y.XmlText &&
        ((eFrag.get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(5, ' EDIT'),
      'editor',
    );
    Y.applyUpdate(shared, Y.encodeStateAsUpdate(editor), 'editor');

    const handler = new CollaborationHandler();
    await handler.getHandlers(hocuspocus).gitSyncWriteBody('page.x', {
      prosemirrorJson: pmDoc('alpha', 'beta2'),
      baseProsemirrorJson: pmDoc('alpha', 'beta'),
      userId: 'svc-user',
    });

    // Human's block-0 edit AND git's block-1 change both survive on the editor.
    expect(texts(editor.getXmlFragment('default'))).toEqual([
      'alpha EDIT',
      'beta2',
    ]);
  });

  it('FLUSHES the pending debounced store BEFORE merging so an in-flight edit survives (finding #2)', async () => {
    // QA #119 finding #2: the 3-way merge must run against the latest live-doc
    // state. A concurrent UI edit that is still in-flight (the store is debounced)
    // must be drained into the live doc BEFORE git merges, or git clean-applies and
    // the edit is silently dropped — even on a DIFFERENT block. Model the drain via
    // the pending-store flush: when it runs, the in-flight block-0 edit lands.
    const shared = new Y.Doc();
    const frag = shared.getXmlFragment('default');
    shared.transact(() => {
      frag.insert(
        0,
        [
          { text: 'alpha', id: 'p1' },
          { text: 'beta', id: 'p2' },
        ].map((s) => {
          const el = new Y.XmlElement('paragraph');
          el.setAttribute('id', s.id);
          const t = new Y.XmlText();
          t.insert(0, s.text);
          el.insert(0, [t]);
          return el;
        }),
      );
    });

    const order: string[] = [];
    const debouncer = {
      isDebounced: jest.fn(() => true),
      executeNow: jest.fn(async () => {
        order.push('flush');
        // The in-flight client edit to block 0 only lands once the pending store
        // is flushed (i.e. the event loop is drained) — BEFORE the merge.
        shared.transact(() =>
          ((frag.get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(5, ' EDIT'),
        );
      }),
    };
    const openDirectConnection = jest.fn(async () => ({
      transact: async (fn: (doc: Y.Doc) => void) => {
        order.push('merge');
        fn(shared);
      },
      disconnect: jest.fn(async () => undefined),
    }));
    const hocuspocus = { openDirectConnection, debouncer } as any;

    const handler = new CollaborationHandler();
    await handler.getHandlers(hocuspocus).gitSyncWriteBody('page.x', {
      prosemirrorJson: pmDoc('alpha', 'beta2'), // git changes block 1
      baseProsemirrorJson: pmDoc('alpha', 'beta'),
      userId: 'svc-user',
    });

    // The flush ran, and it ran BEFORE the merge transaction.
    expect(debouncer.executeNow).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['flush', 'merge']);
    // Both the in-flight block-0 edit and git's block-1 change survive — the
    // pre-flush bug would have produced ['alpha', 'beta2'] (UI edit dropped).
    expect(texts(shared.getXmlFragment('default'))).toEqual([
      'alpha EDIT',
      'beta2',
    ]);
  });

  it('does not flush when no store is pending (isDebounced false)', async () => {
    const { hocuspocus, shared } = fakeHocuspocus([{ text: 'a', id: 'p1' }]);
    const executeNow = jest.fn();
    (hocuspocus as any).debouncer = {
      isDebounced: jest.fn(() => false),
      executeNow,
    };
    const handler = new CollaborationHandler();
    await handler.getHandlers(hocuspocus).gitSyncWriteBody('page.x', {
      prosemirrorJson: pmDoc('a', 'b'),
      userId: 'svc-user',
    });
    expect(executeNow).not.toHaveBeenCalled();
    expect(texts(shared.getXmlFragment('default'))).toEqual(['a', 'b']);
  });

  it('crash-safe: a transform failure never opens the connection or mutates the live doc', async () => {
    const { hocuspocus, shared } = fakeHocuspocus([{ text: 'alpha', id: 'p1' }]);
    const before = texts(shared.getXmlFragment('default'));
    const handler = new CollaborationHandler();

    await expect(
      handler.getHandlers(hocuspocus).gitSyncWriteBody('page.x', {
        prosemirrorJson: { __throw: true } as any,
        userId: 'svc-user',
      }),
    ).rejects.toThrow('boom');

    // The incoming doc is built BEFORE opening the connection, so the throw
    // happens first: the live doc is untouched and no connection was opened.
    expect(hocuspocus.openDirectConnection).not.toHaveBeenCalled();
    expect(texts(shared.getXmlFragment('default'))).toEqual(before);
  });

  it('refuses an empty body with no base over a non-empty live doc (live unchanged)', async () => {
    const { hocuspocus, shared, editor } = fakeHocuspocus([
      { text: 'alpha', id: 'p1' },
      { text: 'beta', id: 'p2' },
    ]);
    const handler = new CollaborationHandler();

    await expect(
      handler.getHandlers(hocuspocus).gitSyncWriteBody('page.x', {
        prosemirrorJson: pmDoc(''),
        userId: 'svc-user',
      }),
    ).rejects.toThrow(/refused/);

    expect(texts(shared.getXmlFragment('default'))).toEqual(['alpha', 'beta']);
    expect(texts(editor.getXmlFragment('default'))).toEqual(['alpha', 'beta']);
  });

  it('applies an empty body without a base to a fresh page shell with no blocks', async () => {
    // A page created by pageService.create has no ydoc yet: its live fragment
    // holds NO blocks (fromYdoc -> {type:'doc', content: []}). That is an empty
    // page, so the no-base empty-body refusal must not fire.
    const { hocuspocus, shared } = fakeHocuspocus([]);
    const handler = new CollaborationHandler();

    await expect(
      handler.getHandlers(hocuspocus).gitSyncWriteBody('page.x', {
        prosemirrorJson: pmDoc(''),
        userId: 'svc-user',
      }),
    ).resolves.toBeUndefined();

    expect(texts(shared.getXmlFragment('default'))).toEqual(['']);
  });

  it('flags the store as an intentional clear ONLY for an empty body with a non-empty base', async () => {
    const contextOf = async (payload: any) => {
      const { hocuspocus } = fakeHocuspocus([{ text: 'alpha', id: 'p1' }]);
      await new CollaborationHandler()
        .getHandlers(hocuspocus)
        .gitSyncWriteBody('page.x', { userId: 'svc-user', ...payload });
      return hocuspocus.openDirectConnection.mock.calls[0][1];
    };

    expect(
      await contextOf({
        prosemirrorJson: pmDoc(''),
        baseProsemirrorJson: pmDoc('alpha'),
      }),
    ).toEqual({
      actor: 'git-sync',
      user: { id: 'svc-user' },
      gitSyncIntentionalClear: true,
    });
    expect(
      (
        await contextOf({
          prosemirrorJson: pmDoc(''),
          baseProsemirrorJson: pmDoc(''),
        })
      ).gitSyncIntentionalClear,
    ).toBe(false);
    expect(
      (
        await contextOf({
          prosemirrorJson: pmDoc('alpha', 'beta'),
          baseProsemirrorJson: pmDoc('alpha'),
        })
      ).gitSyncIntentionalClear,
    ).toBe(false);
  });

  it('falls back to a 2-way merge when no base is supplied', async () => {
    const { hocuspocus, shared, editor } = fakeHocuspocus([
      { text: 'alpha', id: 'p1' },
    ]);
    const handler = new CollaborationHandler();

    await handler.getHandlers(hocuspocus).gitSyncWriteBody('page.x', {
      prosemirrorJson: pmDoc('alpha', 'gamma'),
      userId: 'svc-user',
    });

    expect(texts(shared.getXmlFragment('default'))).toEqual(['alpha', 'gamma']);
    expect(texts(editor.getXmlFragment('default'))).toEqual(['alpha', 'gamma']);
  });
});
