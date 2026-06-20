import {
  canAuthorHtmlEmbed,
  hasHtmlEmbedNode,
  htmlEmbedAllowed,
  isHtmlEmbedFeatureEnabled,
  stripHtmlEmbedNodes,
} from './html-embed.util';
import { htmlToJson, jsonToHtml } from '../../../collaboration/collaboration.util';
import {
  decodeHtmlEmbedSource,
  encodeHtmlEmbedSource,
} from '@docmost/editor-ext';

const findFirstChild = (json: any, type: string): any | undefined => {
  if (!json || typeof json !== 'object') return undefined;
  if (json.type === type) return json;
  if (Array.isArray(json.content)) {
    for (const child of json.content) {
      const found = findFirstChild(child, type);
      if (found) return found;
    }
  }
  return undefined;
};

describe('stripHtmlEmbedNodes', () => {
  it('removes a top-level htmlEmbed node', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'before' }] },
        { type: 'htmlEmbed', attrs: { source: '<script>alert(1)</script>' } },
        { type: 'paragraph', content: [{ type: 'text', text: 'after' }] },
      ],
    };

    const result = stripHtmlEmbedNodes(doc);
    expect(hasHtmlEmbedNode(result)).toBe(false);
    // Other nodes are preserved.
    expect(result.content).toHaveLength(2);
    expect(result.content[0].content[0].text).toBe('before');
    expect(result.content[1].content[0].text).toBe('after');
  });

  it('removes nested htmlEmbed nodes (e.g. inside columns)', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'columns',
          content: [
            {
              type: 'column',
              content: [
                { type: 'htmlEmbed', attrs: { source: '<b>x</b>' } },
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'keep' }],
                },
              ],
            },
          ],
        },
      ],
    };

    const result = stripHtmlEmbedNodes(doc);
    expect(hasHtmlEmbedNode(result)).toBe(false);
    const col = findFirstChild(result, 'column');
    expect(col.content).toHaveLength(1);
    expect(col.content[0].type).toBe('paragraph');
  });

  it('does not mutate the input document', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'htmlEmbed', attrs: { source: 'x' } }],
    };
    stripHtmlEmbedNodes(doc);
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0].type).toBe('htmlEmbed');
  });

  it('leaves documents without htmlEmbed untouched', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'hi' }] },
      ],
    };
    expect(hasHtmlEmbedNode(doc)).toBe(false);
    const result = stripHtmlEmbedNodes(doc);
    expect(result).toEqual(doc);
  });

  it('neutralizes a root node that is itself an htmlEmbed', () => {
    // Defensive: the PM root is always a `doc`, so this is unreachable in normal
    // use, but the helper must still never return a bare htmlEmbed.
    const root = {
      type: 'htmlEmbed',
      attrs: { source: '<script>alert(1)</script>' },
    };
    const result = stripHtmlEmbedNodes(root);
    expect(hasHtmlEmbedNode(result)).toBe(false);
  });
});

describe('canAuthorHtmlEmbed', () => {
  it('allows owner and admin', () => {
    expect(canAuthorHtmlEmbed('owner')).toBe(true);
    expect(canAuthorHtmlEmbed('admin')).toBe(true);
  });
  it('denies member and unknown/empty roles', () => {
    expect(canAuthorHtmlEmbed('member')).toBe(false);
    expect(canAuthorHtmlEmbed(null)).toBe(false);
    expect(canAuthorHtmlEmbed(undefined)).toBe(false);
    expect(canAuthorHtmlEmbed('viewer')).toBe(false);
  });
});

describe('isHtmlEmbedFeatureEnabled', () => {
  it('is true only when settings.htmlEmbed === true', () => {
    expect(isHtmlEmbedFeatureEnabled({ htmlEmbed: true })).toBe(true);
  });
  it('defaults to false (absent / false / non-object)', () => {
    expect(isHtmlEmbedFeatureEnabled({})).toBe(false);
    expect(isHtmlEmbedFeatureEnabled({ htmlEmbed: false })).toBe(false);
    expect(isHtmlEmbedFeatureEnabled(null)).toBe(false);
    expect(isHtmlEmbedFeatureEnabled(undefined)).toBe(false);
    // Truthy-but-not-true values must NOT enable the feature.
    expect(isHtmlEmbedFeatureEnabled({ htmlEmbed: 'true' as any })).toBe(false);
  });
});

describe('htmlEmbedAllowed (toggle AND admin)', () => {
  it('toggle OFF + admin/owner => not allowed (feature disabled for everyone)', () => {
    expect(htmlEmbedAllowed(false, 'admin')).toBe(false);
    expect(htmlEmbedAllowed(false, 'owner')).toBe(false);
  });
  it('toggle OFF + member => not allowed', () => {
    expect(htmlEmbedAllowed(false, 'member')).toBe(false);
  });
  it('toggle ON + admin/owner => allowed', () => {
    expect(htmlEmbedAllowed(true, 'admin')).toBe(true);
    expect(htmlEmbedAllowed(true, 'owner')).toBe(true);
  });
  it('toggle ON + member/unknown => not allowed', () => {
    expect(htmlEmbedAllowed(true, 'member')).toBe(false);
    expect(htmlEmbedAllowed(true, null)).toBe(false);
    expect(htmlEmbedAllowed(true, undefined)).toBe(false);
    expect(htmlEmbedAllowed(true, 'viewer')).toBe(false);
  });
});

// NOTE: a previous revision of this file re-implemented the write-path admin
// gate as a local `applyAdminGate` stand-in and asserted against THAT. A
// deleted/misplaced real guard would have kept those green. The stand-in is
// removed. The collab store, REST/MCP update, and transclusion-unsync paths are
// now tested against their REAL code in:
//   - collaboration/extensions/persistence.extension.html-embed.spec.ts
//   - collaboration/collaboration.handler.html-embed.spec.ts
//   - core/page/transclusion/spec/transclusion-unsync-html-embed.spec.ts
//   - core/page/services/page-service-html-embed-identity.spec.ts (create/dup)
//   - integrations/import/services/import-html-embed-identity.spec.ts (import)
//
// The case below stays here because it asserts a REAL parse path
// (htmlToJson, the markdown/html create format) feeding the REAL helpers — not a
// re-implemented gate.
describe('htmlEmbed smuggled via the markdown/html <!--html-embed--> form (real parse + real helpers)', () => {
  it('the parsed node is detected and stripped by the real helpers', () => {
    // The markdown/html create formats decode to the same htmlEmbed node, so the
    // gate (run on the parsed JSON) covers them identically.
    const source = '<script>steal()</script>';
    const encoded = encodeHtmlEmbedSource(source);
    const html = `<div data-type="htmlEmbed" data-source="${encoded}"></div>`;
    const parsed = htmlToJson(html);
    expect(hasHtmlEmbedNode(parsed)).toBe(true);

    // A non-admin role gates to strip via the real helpers.
    expect(canAuthorHtmlEmbed('member')).toBe(false);
    const stripped = stripHtmlEmbedNodes(parsed);
    expect(hasHtmlEmbedNode(stripped)).toBe(false);
  });
});

describe('htmlEmbed source base64 codec', () => {
  it('round-trips arbitrary source including UTF-8', () => {
    const source = '<script>console.log("héllo → 世界")</script>';
    const encoded = encodeHtmlEmbedSource(source);
    expect(encoded).not.toContain('<');
    expect(decodeHtmlEmbedSource(encoded)).toBe(source);
  });
});

describe('htmlEmbed node HTML <-> JSON round-trip', () => {
  it('preserves the raw source through HTML -> JSON', () => {
    const source = '<script>track("page")</script><style>.a{color:red}</style>';
    const encoded = encodeHtmlEmbedSource(source);
    const html = `<div data-type="htmlEmbed" data-source="${encoded}"></div>`;

    const json = htmlToJson(html);
    const node = findFirstChild(json, 'htmlEmbed');
    expect(node).toBeDefined();
    expect(node.attrs.source).toBe(source);
  });

  it('round-trips JSON -> HTML -> JSON keeping the source', () => {
    const source = '<div onclick="x()">raw &amp; markup</div>';
    const json = {
      type: 'doc',
      content: [{ type: 'htmlEmbed', attrs: { source } }],
    };

    const html = jsonToHtml(json);
    // The static HTML carries the encoded source but does NOT inline the raw
    // markup (it must not be an injection vector by itself).
    expect(html).toContain('data-type="htmlEmbed"');
    expect(html).not.toContain('onclick');

    const back = htmlToJson(html);
    const node = findFirstChild(back, 'htmlEmbed');
    expect(node).toBeDefined();
    expect(node.attrs.source).toBe(source);
  });
});
