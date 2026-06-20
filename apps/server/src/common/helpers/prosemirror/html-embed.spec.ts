import {
  canAuthorHtmlEmbed,
  hasHtmlEmbedNode,
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

// Replicates the write-path decision used by every non-admin persistence guard
// (collab store, single import, zip import, duplication, transclusion unsync):
//   if !canAuthorHtmlEmbed(role) && hasHtmlEmbedNode(json) -> strip, else keep.
const applyAdminGate = (json: any, role: string | null | undefined) => {
  if (!canAuthorHtmlEmbed(role) && hasHtmlEmbedNode(json)) {
    return stripHtmlEmbedNodes(json);
  }
  return json;
};

describe('admin-gate write-path decision (duplication / import / unsync)', () => {
  const docWithEmbed = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'keep' }] },
      { type: 'htmlEmbed', attrs: { source: '<script>alert(1)</script>' } },
    ],
  };

  it('strips the embed for a non-admin (member) author', () => {
    const result = applyAdminGate(docWithEmbed, 'member');
    expect(hasHtmlEmbedNode(result)).toBe(false);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].content[0].text).toBe('keep');
  });

  it('strips the embed for unknown/empty roles', () => {
    expect(hasHtmlEmbedNode(applyAdminGate(docWithEmbed, null))).toBe(false);
    expect(hasHtmlEmbedNode(applyAdminGate(docWithEmbed, undefined))).toBe(
      false,
    );
    expect(hasHtmlEmbedNode(applyAdminGate(docWithEmbed, 'viewer'))).toBe(
      false,
    );
  });

  it('keeps the embed for an admin author', () => {
    const result = applyAdminGate(docWithEmbed, 'admin');
    expect(hasHtmlEmbedNode(result)).toBe(true);
    expect(result).toBe(docWithEmbed);
  });

  it('keeps the embed for an owner author', () => {
    const result = applyAdminGate(docWithEmbed, 'owner');
    expect(hasHtmlEmbedNode(result)).toBe(true);
  });

  it('strips nested embeds (subtree/column duplication) for a non-admin', () => {
    const nested = {
      type: 'doc',
      content: [
        {
          type: 'columns',
          content: [
            {
              type: 'column',
              content: [
                { type: 'htmlEmbed', attrs: { source: '<script>x</script>' } },
                { type: 'paragraph', content: [{ type: 'text', text: 'ok' }] },
              ],
            },
          ],
        },
      ],
    };
    const result = applyAdminGate(nested, 'member');
    expect(hasHtmlEmbedNode(result)).toBe(false);
    const col = findFirstChild(result, 'column');
    expect(col.content).toHaveLength(1);
    expect(col.content[0].type).toBe('paragraph');
  });

  it('leaves a non-admin doc without embeds untouched (no needless rewrite)', () => {
    const clean = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }],
    };
    const result = applyAdminGate(clean, 'member');
    expect(result).toBe(clean);
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
