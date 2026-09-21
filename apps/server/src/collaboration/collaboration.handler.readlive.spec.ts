import { TiptapTransformer } from '@hocuspocus/transformer';
import { CollaborationHandler } from './collaboration.handler';
import { tiptapExtensions } from './collaboration.util';
import { pageContentHash } from './content-hash.util';

/**
 * #647 refinement B — the owner-side `readLiveContent` handler (the local half of
 * the `readLiveIfLoaded` primitive #654 gates on). It reads ONLY docs already in
 * `hocuspocus.documents`, so it never force-loads (property 2) and returns the
 * fully hydrated live content + a coherent hash (property 5).
 */

function makeYdoc(text: string) {
  return TiptapTransformer.toYdoc(
    {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    },
    'default',
    tiptapExtensions,
  );
}

// Fake hocuspocus exposing the `documents` Map the handler reads, plus a spied
// openDirectConnection that MUST NOT be called (the read never force-loads).
function fakeHocuspocus(docs: Record<string, any>) {
  const openDirectConnection = jest.fn(async () => {
    throw new Error('readLiveContent must NOT open a direct connection');
  });
  return {
    documents: new Map(Object.entries(docs)),
    openDirectConnection,
  } as any;
}

describe('CollaborationHandler.readLiveContent (#647 §B)', () => {
  it('loaded doc → {loaded:true} with hydrated content and a coherent hash', async () => {
    const ydoc = makeYdoc('hello world');
    const hocuspocus = fakeHocuspocus({ 'page.uuid-1': ydoc });
    const handlers = new CollaborationHandler().getHandlers(hocuspocus);

    const res: any = await handlers.readLiveContent('page.uuid-1');

    expect(res.loaded).toBe(true);
    // property 5: content is the fully hydrated fromYdoc of the live doc.
    const expected = TiptapTransformer.fromYdoc(ydoc, 'default');
    expect(res.content).toEqual(expected);
    // hash is coherent with the returned content (same materialization).
    expect(res.hash).toBe(pageContentHash(expected));
    expect(res.hash).toBe(pageContentHash(res.content));
    // property 2: no force-load happened.
    expect(hocuspocus.openDirectConnection).not.toHaveBeenCalled();
  });

  it('not-loaded doc → {loaded:false}, never force-loads', async () => {
    const hocuspocus = fakeHocuspocus({});
    const handlers = new CollaborationHandler().getHandlers(hocuspocus);

    const res: any = await handlers.readLiveContent('page.absent');

    expect(res).toEqual({ loaded: false });
    expect(hocuspocus.openDirectConnection).not.toHaveBeenCalled();
  });

  it('two loaded docs with different content hash differently', async () => {
    const hocuspocus = fakeHocuspocus({
      'page.a': makeYdoc('alpha'),
      'page.b': makeYdoc('beta'),
    });
    const handlers = new CollaborationHandler().getHandlers(hocuspocus);
    const a: any = await handlers.readLiveContent('page.a');
    const b: any = await handlers.readLiveContent('page.b');
    expect(a.hash).not.toBe(b.hash);
  });
});
