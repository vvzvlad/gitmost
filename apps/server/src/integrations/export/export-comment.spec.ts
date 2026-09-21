import { JSDOM } from 'jsdom';
import { jsonToHtml } from '../../collaboration/collaboration.util';

/**
 * Regression test for issue #298: page/space export (Markdown/HTML) crashes on
 * pages that contain inline comments.
 *
 * The in-process MCP module injects a jsdom `global.window` + `global.document`
 * into the Node server (see packages/mcp/src/lib/collaboration.ts). Before the
 * fix, the comment mark's `renderHTML` guard was only
 * `typeof window === "undefined" || typeof document === "undefined"`, so with
 * BOTH jsdom globals present it took the interactive browser branch and returned
 * a LIVE jsdom <span> node. The export path serializes via happy-dom's
 * DOMSerializer, and appending a foreign jsdom node crashed happy-dom
 * ("Cannot read properties of undefined (reading 'length')").
 *
 * We reproduce the MCP-loaded server by injecting jsdom globals, then export a
 * doc containing a comment mark and assert the serialization SUCCEEDS and emits
 * the expected serializable <span data-comment-id=... class="comment-mark">.
 *
 * Non-vacuity: this test only exercises the buggy branch because BOTH jsdom
 * `window` AND `document` are set below. If the `isNodeRuntime` condition is
 * removed from the guard in packages/editor-ext/src/lib/comment/comment.ts,
 * `renderHTML` returns a live jsdom node and `jsonToHtml` throws — this test
 * then fails. (In a plain node env without the injected globals the guard's
 * `typeof window === "undefined"` clause already short-circuits, so it is the
 * injected globals that make this assertion meaningful.)
 */
describe('export with inline comments (issue #298)', () => {
  const originalWindow = (global as any).window;
  const originalDocument = (global as any).document;

  beforeAll(() => {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
    (global as any).window = dom.window;
    (global as any).document = dom.window.document;
  });

  afterAll(() => {
    (global as any).window = originalWindow;
    (global as any).document = originalDocument;
  });

  const docWithComment = (resolved: boolean) => ({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            marks: [
              {
                type: 'comment',
                attrs: { commentId: 'c-123', resolved },
              },
            ],
            text: 'commented text',
          },
        ],
      },
    ],
  });

  it('exports a page with an unresolved comment mark without crashing', () => {
    let html: string;
    expect(() => {
      html = jsonToHtml(docWithComment(false));
    }).not.toThrow();

    expect(html).toContain('data-comment-id="c-123"');
    expect(html).toContain('class="comment-mark"');
    expect(html).toContain('commented text');
  });

  it('exports a resolved comment mark with the resolved class/attr', () => {
    const html = jsonToHtml(docWithComment(true));
    expect(html).toContain('data-comment-id="c-123"');
    expect(html).toContain('comment-mark resolved');
    expect(html).toContain('data-resolved="true"');
  });
});
