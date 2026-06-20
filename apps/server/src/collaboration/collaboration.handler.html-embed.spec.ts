import * as Y from 'yjs';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { CollaborationHandler } from './collaboration.handler';
import { hasHtmlEmbedNode } from '../common/helpers/prosemirror/html-embed.util';

// Exercises the REAL CollaborationHandler.updatePageContent admin gate (the
// REST/MCP/AI content-update entrypoint, used by the page update endpoint and
// the MCP/AI agent). updatePageContent reads `user?.role` and strips htmlEmbed
// BEFORE handing the json to withYdocConnection. We stub only
// withYdocConnection (which would otherwise open a real hocuspocus connection):
// the role-extraction (`user?.role`) + strip that run upstream of it are REAL
// production code. The 'replace' branch then runs the production
// TiptapTransformer.toYdoc on the gated json against a real Y.Doc, which we
// decode back to JSON and assert on. This replaces the re-implemented
// `applyAdminGate` stand-in for this entrypoint.

const docWithEmbed = () => ({
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'keep' }] },
    {
      type: 'columns',
      content: [
        {
          type: 'column',
          attrs: { position: 'left' },
          content: [
            { type: 'htmlEmbed', attrs: { source: '<script>nested</script>' } },
            { type: 'paragraph', content: [{ type: 'text', text: 'inner' }] },
          ],
        },
        {
          type: 'column',
          attrs: { position: 'right' },
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'r' }] },
          ],
        },
      ],
    },
    { type: 'htmlEmbed', attrs: { source: '<script>top</script>' } },
  ],
});

/**
 * Run the REAL updatePageContent('replace') with a stubbed withYdocConnection.
 * The stub provides a real Y.Doc + recording fragment; the production fn calls
 * TiptapTransformer.toYdoc(<gated json>) and applies it to the doc, so decoding
 * the doc afterward yields exactly the gated content.
 */
async function gatedContentFor(role: string | null | undefined) {
  const handler = new CollaborationHandler();
  const captureDoc = new Y.Doc();

  jest
    .spyOn(handler, 'withYdocConnection')
    .mockImplementation(async (_hp, _name, _ctx, fn: any) => {
      const fragment = captureDoc.getXmlFragment('default');
      // Mirror the real Document surface the fn touches.
      const docLike: any = {
        getXmlFragment: () => fragment,
      };
      // The fn does: fragment.delete(0,len) then
      // Y.applyUpdate(doc, encodeStateAsUpdate(toYdoc(gatedJson))). It calls
      // Y.applyUpdate(doc, ...) — so docLike must be a real Y.Doc target.
      fn(captureDoc);
    });

  const handlers = handler.getHandlers({} as any);
  await handlers.updatePageContent('page-1', {
    prosemirrorJson: docWithEmbed(),
    operation: 'replace',
    user: { id: 'u1', role } as any,
  });

  return TiptapTransformer.fromYdoc(captureDoc, 'default');
}

describe('CollaborationHandler.updatePageContent htmlEmbed admin gate (real code)', () => {
  it('non-admin (member): every htmlEmbed (top-level + nested) stripped before the ydoc', async () => {
    const gated = await gatedContentFor('member');
    expect(hasHtmlEmbedNode(gated)).toBe(false);
    // Non-embed siblings survive.
    const json = JSON.stringify(gated);
    expect(json).toContain('keep');
    expect(json).toContain('inner');
  });

  it('unknown/empty role: fails closed (stripped)', async () => {
    for (const role of [undefined, null, 'viewer'] as const) {
      expect(hasHtmlEmbedNode(await gatedContentFor(role))).toBe(false);
    }
  });

  it('admin: htmlEmbed preserved', async () => {
    expect(hasHtmlEmbedNode(await gatedContentFor('admin'))).toBe(true);
  });

  it('owner: htmlEmbed preserved', async () => {
    expect(hasHtmlEmbedNode(await gatedContentFor('owner'))).toBe(true);
  });
});
