import {
  hasHtmlEmbedNode,
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

  it('strips a deeply nested htmlEmbed (3+ levels: callout > column > paragraph-sibling)', () => {
    // htmlEmbed sits as a sibling of a paragraph, nested four containers deep.
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'callout',
          content: [
            {
              type: 'columns',
              content: [
                {
                  type: 'column',
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'deep keep' }],
                    },
                    { type: 'htmlEmbed', attrs: { source: '<script>x</script>' } },
                  ],
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
    // Sibling paragraph survives; only the embed is removed.
    expect(col.content).toHaveLength(1);
    expect(col.content[0].type).toBe('paragraph');
    expect(col.content[0].content[0].text).toBe('deep keep');
  });

  it('returns non-object / null / array-without-content nodes unchanged', () => {
    // Non-object inputs are returned as-is (callers persist what they got).
    expect(stripHtmlEmbedNodes(null as any)).toBeNull();
    expect(stripHtmlEmbedNodes(undefined as any)).toBeUndefined();
    expect(stripHtmlEmbedNodes('not-a-node' as any)).toBe('not-a-node');
    expect(stripHtmlEmbedNodes(42 as any)).toBe(42);

    // An object node with no `content` array is returned shallow-cloned, equal.
    const leaf = { type: 'paragraph', attrs: { id: 'x' } };
    const out = stripHtmlEmbedNodes(leaf);
    expect(out).toEqual(leaf);
    expect(out).not.toBe(leaf); // new object, input not mutated
  });

  it('yields empty content (not null/undefined) for a doc whose only child is an htmlEmbed', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'htmlEmbed', attrs: { source: '<b>only</b>' } }],
    };
    const result = stripHtmlEmbedNodes(doc) as any;
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content).toHaveLength(0);
    expect(result.content).not.toBeNull();
    expect(result.content).not.toBeUndefined();
    expect(hasHtmlEmbedNode(result)).toBe(false);
  });
});

describe('hasHtmlEmbedNode (root/odd-shape detection)', () => {
  it('returns true when the ROOT node itself is an htmlEmbed (not only a child)', () => {
    const rootEmbed = { type: 'htmlEmbed', attrs: { source: '<script>r</script>' } };
    expect(hasHtmlEmbedNode(rootEmbed)).toBe(true);
  });

  it('returns false for a doc with embed-like TEXT but no htmlEmbed node', () => {
    // The literal string "htmlEmbed" appears only as text content, not as a
    // node type, so it must NOT be detected.
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'type: htmlEmbed <div data-type="htmlEmbed">' },
          ],
        },
      ],
    };
    expect(hasHtmlEmbedNode(doc)).toBe(false);
  });

  it('returns false for non-object / null / array inputs', () => {
    expect(hasHtmlEmbedNode(null)).toBe(false);
    expect(hasHtmlEmbedNode(undefined)).toBe(false);
    expect(hasHtmlEmbedNode('htmlEmbed')).toBe(false);
    // A bare array (no `content` wrapper) has no node `type`, so it's false.
    expect(hasHtmlEmbedNode([{ type: 'htmlEmbed' }] as any)).toBe(false);
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

// The htmlEmbed node renders inside a sandboxed iframe, so the per-write role
// gate has been removed. `stripHtmlEmbedNodes` + `isHtmlEmbedFeatureEnabled`
// remain ONLY to honor the workspace master toggle on the anonymous public-share
// read path — tested against the real share code in:
//   - core/share/share-html-embed.spec.ts
//
// The case below asserts that the REAL parse path (htmlToJson, the markdown/html
// form) produces an htmlEmbed node the master-toggle strip can detect & remove.
describe('htmlEmbed via the markdown/html form (real parse + real strip helper)', () => {
  it('the parsed node is detected and stripped by the real helper', () => {
    const source = '<script>track()</script>';
    const encoded = encodeHtmlEmbedSource(source);
    const html = `<div data-type="htmlEmbed" data-source="${encoded}"></div>`;
    const parsed = htmlToJson(html);
    expect(hasHtmlEmbedNode(parsed)).toBe(true);

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
