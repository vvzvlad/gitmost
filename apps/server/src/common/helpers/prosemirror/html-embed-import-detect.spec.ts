import { markdownToProseMirror } from '@docmost/prosemirror-markdown';
import { encodeHtmlEmbedSource } from '@docmost/editor-ext';
import { htmlToJson } from '../../../collaboration/collaboration.util';
import { hasHtmlEmbedNode, stripHtmlEmbedNodes } from './html-embed.util';

/**
 * CONTRACT: imported markdown/HTML can carry an htmlEmbed in the *serialized*
 * DOM form —
 *   <div data-type="htmlEmbed" data-source="...">
 * — directly, bypassing the editor's `<!--html-embed:-->` comment marker.
 *
 * The block renders inside a sandboxed iframe, so this is not an XSS surface;
 * this exercises the REAL server import conversion path that ImportService uses
 * (`markdownToProseMirror`, the canonical converter — issue #345/#347) and
 * asserts that such a node is DETECTED and STRIPPABLE — so the share read path's
 * master-toggle strip can remove it when the workspace toggle is OFF.
 */
describe('htmlEmbed smuggled via the raw serialized div in imported markdown/HTML', () => {
  it('round-trips through markdownToProseMirror and is DETECTED (base64 data-source)', async () => {
    const source = '<script>steal()</script>';
    const encoded = encodeHtmlEmbedSource(source);
    const md = [
      'Hello',
      '',
      `<div data-type="htmlEmbed" data-source="${encoded}"></div>`,
      '',
      'World',
    ].join('\n');

    // The canonical importer parses the raw block-level div into a real
    // htmlEmbed node carrying the decoded source.
    const json = await markdownToProseMirror(md);
    expect(hasHtmlEmbedNode(json)).toBe(true);

    // Because it is detected, the share master-toggle strip can remove it.
    const stripped = stripHtmlEmbedNodes(json);
    expect(hasHtmlEmbedNode(stripped)).toBe(false);
    // Surrounding non-embed content is retained.
    expect(JSON.stringify(stripped)).toContain('Hello');
    expect(JSON.stringify(stripped)).toContain('World');
  });

  it('round-trips through direct HTML conversion (htmlToJson) and is DETECTED', () => {
    const source = '<script>steal()</script>';
    const encoded = encodeHtmlEmbedSource(source);
    const html = `<p>Hello</p><div data-type="htmlEmbed" data-source="${encoded}"></div><p>World</p>`;

    const json = htmlToJson(html);
    expect(hasHtmlEmbedNode(json)).toBe(true);
    expect(hasHtmlEmbedNode(stripHtmlEmbedNodes(json))).toBe(false);
  });

  it('is still DETECTED even when the data-source is NOT valid base64', async () => {
    // A naive raw inline source (HTML-escaped, not base64) still parses as an
    // htmlEmbed NODE — the decoder just yields an empty source. Detection (and
    // therefore stripping) does not depend on the source being well-formed, so
    // the bypass cannot be hidden by sending a malformed data-source.
    const md = `<div data-type="htmlEmbed" data-source="&lt;script&gt;x&lt;/script&gt;"></div>`;
    const json = await markdownToProseMirror(md);
    expect(hasHtmlEmbedNode(json)).toBe(true);
    expect(hasHtmlEmbedNode(stripHtmlEmbedNodes(json))).toBe(false);
  });
});
