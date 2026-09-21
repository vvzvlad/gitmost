// #647 §C — unit tests for the server-side write-CAS (`replaceIfMatch`) handler.
// Exercises the real handler against a real Y.Doc through a minimal fake
// hocuspocus (openDirectConnection → connection.transact over the live doc), so
// the CAS compare, the empty-guard (B4), the #152 structural-update identity
// preservation, and the B3 attribution context are all covered without a DB or a
// live collaboration process.
import * as Y from 'yjs';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { CollaborationHandler } from './collaboration.handler';
import { tiptapExtensions } from './collaboration.util';
import { pageContentHash } from './content-hash.util';

const para = (id: string, text: string) => ({
  type: 'paragraph',
  attrs: { id },
  content: [{ type: 'text', text }],
});
const doc = (...content: any[]) => ({ type: 'doc', content });
const emptyDoc = () => ({ type: 'doc', content: [{ type: 'paragraph' }] });

/**
 * Minimal fake hocuspocus: one live Y.Doc seeded from JSON via the same
 * toYdoc→applyUpdate path onLoadDocument uses. `openDirectConnection` returns a
 * connection whose `transact` runs the callback inside a real `doc.transact`.
 */
function makeFakeHocuspocus(seedJson: any) {
  const ydoc = new Y.Doc();
  const seed = TiptapTransformer.toYdoc(seedJson, 'default', tiptapExtensions);
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(seed));

  let lastContext: any = null;
  const documents = new Map<string, Y.Doc>([['page.p1', ydoc]]);
  const hocuspocus = {
    documents,
    openDirectConnection: async (_name: string, context: any) => {
      lastContext = context;
      return {
        transact: async (fn: (d: Y.Doc) => void) => {
          ydoc.transact(() => fn(ydoc));
        },
        disconnect: async () => {},
      };
    },
  };
  return { hocuspocus, ydoc, getContext: () => lastContext };
}

function currentJson(ydoc: Y.Doc) {
  return TiptapTransformer.fromYdoc(ydoc, 'default');
}

describe('CollaborationHandler.replaceIfMatch (#647 §C)', () => {
  const handler = new CollaborationHandler();

  it('applies when baseHash matches the live doc and returns the new hash', async () => {
    const seed = doc(para('a', 'Alpha'), para('b', 'Bravo'));
    const { hocuspocus, ydoc } = makeFakeHocuspocus(seed);
    const baseHash = pageContentHash(currentJson(ydoc));
    const next = doc(para('a', 'ALPHA'), para('b', 'Bravo'));

    const res: any = await handler
      .getHandlers(hocuspocus as any)
      .replaceIfMatch('page.p1', {
        prosemirrorJson: next,
        baseHash,
        user: { id: 'u1' } as any,
      });

    expect(res.applied).toBe(true);
    // B1: newHash is over `fromYdoc(doc)` AFTER the write (the materialized live
    // content), NOT the raw input JSON — so it is coherent with what a subsequent
    // read (getLiveContentPair) would return, and a raw-JSON hash would NOT match.
    expect(res.newHash).toBe(pageContentHash(currentJson(ydoc)));
    expect(currentJson(ydoc).content[0].content[0].text).toBe('ALPHA');
  });

  it('rejects (no mutation) when baseHash is stale, returning currentHash', async () => {
    const seed = doc(para('a', 'Alpha'));
    const { hocuspocus, ydoc } = makeFakeHocuspocus(seed);
    const liveHash = pageContentHash(currentJson(ydoc));
    const next = doc(para('a', 'Zeta'));

    const res: any = await handler
      .getHandlers(hocuspocus as any)
      .replaceIfMatch('page.p1', {
        prosemirrorJson: next,
        baseHash: 'deadbeef-stale-hash',
        user: { id: 'u1' } as any,
      });

    expect(res.applied).toBe(false);
    expect(res.currentHash).toBe(liveHash);
    // The live doc was NOT mutated.
    expect(currentJson(ydoc).content[0].content[0].text).toBe('Alpha');
  });

  it('refuses an empty-over-non-empty replace (B4) instead of a false success', async () => {
    const seed = doc(para('a', 'Alpha'));
    const { hocuspocus, ydoc } = makeFakeHocuspocus(seed);
    const baseHash = pageContentHash(currentJson(ydoc));

    const res: any = await handler
      .getHandlers(hocuspocus as any)
      .replaceIfMatch('page.p1', {
        prosemirrorJson: emptyDoc(),
        baseHash,
        user: { id: 'u1' } as any,
      });

    expect(res.applied).toBe(false);
    expect(res.reason).toBe('empty-replace-refused');
    expect(res.currentHash).toBe(baseHash);
    // Not emptied.
    expect(currentJson(ydoc).content[0].content[0].text).toBe('Alpha');
  });

  it('preserves the Yjs identity of an UNCHANGED block (#152 structural update)', async () => {
    const seed = doc(para('a', 'Alpha'), para('b', 'Bravo'));
    const { hocuspocus, ydoc } = makeFakeHocuspocus(seed);
    const frag = ydoc.getXmlFragment('default');
    const clockBefore = (frag.get(1) as any)._item?.id?.clock;
    const baseHash = pageContentHash(currentJson(ydoc));

    // Change ONLY the first paragraph.
    await handler.getHandlers(hocuspocus as any).replaceIfMatch('page.p1', {
      prosemirrorJson: doc(para('a', 'ALPHA-2'), para('b', 'Bravo')),
      baseHash,
      user: { id: 'u1' } as any,
    });

    // A naive delete+recreate would give the second block a fresh Yjs clock; the
    // structural diff (updateYFragment) leaves the unchanged block's item intact.
    const clockAfter = (frag.get(1) as any)._item?.id?.clock;
    expect(clockAfter).toBe(clockBefore);
    expect(currentJson(ydoc).content[1].content[0].text).toBe('Bravo');
  });

  it('threads B3 attribution ({user, actor, aiChatId, apiKeyId}) into the connection context', async () => {
    const seed = doc(para('a', 'Alpha'));
    const { hocuspocus, ydoc, getContext } = makeFakeHocuspocus(seed);
    const baseHash = pageContentHash(currentJson(ydoc));

    await handler.getHandlers(hocuspocus as any).replaceIfMatch('page.p1', {
      prosemirrorJson: doc(para('a', 'Beta')),
      baseHash,
      user: { id: 'u1' } as any,
      actor: 'agent',
      aiChatId: 'chat-9',
      apiKeyId: 'key-7',
    });

    expect(getContext()).toMatchObject({
      user: { id: 'u1' },
      actor: 'agent',
      aiChatId: 'chat-9',
      apiKeyId: 'key-7',
    });
  });
});
