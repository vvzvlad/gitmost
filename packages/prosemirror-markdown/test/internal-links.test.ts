import { describe, expect, it } from 'vitest';
import {
  isInternalPagePath,
  markInternalLinks,
} from '../src/lib/internal-links.js';
import { markdownToProseMirrorSync } from '../src/lib/markdown-to-prosemirror.js';
import {
  canonicalizeContent,
  docsCanonicallyEqual,
} from '../src/lib/canonicalize.js';

// A LOCAL, illustrative copy of the server's INTERNAL_LINK_REGEX
// (apps/server/src/integrations/export/utils.ts) used only to document the
// subset boundary WITHIN this package (this layer cannot import the server).
// It is NOT the cross-package drift guard: a hand copy can silently go stale if
// the server regex is later narrowed. The real, mechanical drift guard lives in
// the top layer, `apps/server/src/integrations/export/internal-link-parity.spec.ts`,
// which imports BOTH the LIVE server `INTERNAL_LINK_REGEX` and the LIVE
// `isInternalPagePath` and reddens if the client ever ceases to be a subset.
const SERVER_INTERNAL_LINK_REGEX =
  /^(https?:\/\/)?([^\/]+)?(\/s\/([^\/]+)\/)?p\/([a-zA-Z0-9-]+)\/?$/;

// Walk a doc collecting every link mark (across all text nodes).
const linkMarks = (doc: any): any[] => {
  const out: any[] = [];
  const walk = (n: any): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (Array.isArray(n.marks))
      for (const m of n.marks) if (m?.type === 'link') out.push(m);
    if (Array.isArray(n.content)) walk(n.content);
  };
  walk(doc);
  return out;
};

describe('isInternalPagePath', () => {
  const ACCEPT = [
    '/s/eng/p/abc123',
    '/s/eng/p/abc123/', // trailing slash
    '/s/My-Space/p/A-b-C-9', // hyphens + mixed case in both segments
    '/s/x/p/z',
  ];
  const REJECT = [
    'https://example.com/p/x', // scheme + host
    'http://host/s/eng/p/abc', // scheme + host, even on the internal shape
    '//host/s/eng/p/abc', // protocol-relative host
    '/p/abc123', // space-less form (server does NOT backlink it)
    'p/abc123', // relative
    's/eng/p/abc123', // missing leading slash
    '/s/eng/p/abc#section', // anchor
    '/s/eng/p/abc?q=1', // query
    '/s/eng/p/abc/extra', // extra segment
    '/s//p/abc', // empty space segment
    '/s/eng/p/', // empty slug
    '/s/eng/p', // no slug at all
    '/api/pages/abc', // other internal route
    '/s/eng/x/abc', // wrong middle segment
    '/s/a/b/p/abc', // space contains slash -> extra segment
    '',
  ];
  // Structurally VALID `/s/<space>/p/<slug>` shapes whose ONLY defect is a
  // forbidden character in the slug segment. These pin the slug charset
  // `[a-zA-Z0-9-]` itself (not just the surrounding structure): drop them and a
  // mutation widening the charset (e.g. adding `.`) survives the suite. Each is
  // ALSO rejected by the server regex — documenting that the subset boundary
  // holds precisely on the charset, not just on structure.
  const REJECT_SLUG_CHARSET = [
    '/s/eng/p/abc.def', // dot
    '/s/eng/p/abc_def', // underscore
    '/s/eng/p/abc%20', // percent-encoded space
    '/s/eng/p/abc~x', // tilde
  ];

  it('accepts the space-qualified root-relative page path (+trailing slash)', () => {
    for (const href of ACCEPT)
      expect(isInternalPagePath(href), href).toBe(true);
  });

  it('rejects external URLs, ambiguous, and non-page forms', () => {
    for (const href of REJECT)
      expect(isInternalPagePath(href), href).toBe(false);
  });

  it('rejects a correctly-shaped path with a forbidden slug character', () => {
    // Pins the slug charset itself: a mutation widening `[a-zA-Z0-9-]` reddens.
    for (const href of REJECT_SLUG_CHARSET)
      expect(isInternalPagePath(href), href).toBe(false);
  });

  it('the forbidden-slug-char paths are rejected by the server regex too', () => {
    // The subset boundary holds on the charset, not just the structure: none of
    // these match the server regex, so the client must not accept them either.
    for (const href of REJECT_SLUG_CHARSET)
      expect(SERVER_INTERNAL_LINK_REGEX.test(href), href).toBe(false);
  });

  it('rejects non-string input (fail-toward-external)', () => {
    for (const v of [null, undefined, 123, {}, [], true])
      expect(isInternalPagePath(v as unknown)).toBe(false);
  });

  it('is a STRICT SUBSET of the server INTERNAL_LINK_REGEX', () => {
    // Every accepted href must also satisfy the server regex (so it is
    // guaranteed backlink-able / export-rewritable).
    for (const href of ACCEPT)
      expect(SERVER_INTERNAL_LINK_REGEX.test(href), href).toBe(true);
  });
});

describe('markInternalLinks', () => {
  const linkNode = (text: string, href: string, extraMarks: any[] = []) => ({
    type: 'text',
    text,
    marks: [
      {
        type: 'link',
        attrs: {
          href,
          internal: null,
          title: null,
          target: '_blank',
          rel: 'noopener noreferrer nofollow',
          class: null,
        },
      },
      ...extraMarks,
    ],
  });

  it('marks an internal-path link internal:true, target:null, rel:null', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [linkNode('hi', '/s/eng/p/abc123')] },
      ],
    };
    markInternalLinks(doc);
    const m = linkMarks(doc)[0];
    expect(m.attrs.internal).toBe(true);
    expect(m.attrs.target).toBeNull();
    expect(m.attrs.rel).toBeNull();
    expect(m.attrs.href).toBe('/s/eng/p/abc123'); // href untouched
  });

  it('leaves external links untouched', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [linkNode('ext', 'https://example.com/p/x')],
        },
      ],
    };
    markInternalLinks(doc);
    const m = linkMarks(doc)[0];
    expect(m.attrs.internal).toBeNull();
    expect(m.attrs.target).toBe('_blank');
    expect(m.attrs.rel).toBe('noopener noreferrer nofollow');
  });

  it('marks EVERY text node a multi-node link spans (incl. nested bold/italic)', () => {
    // A link `[**bold** plain *ital*](/s/x/p/abc)` stores the link mark on each
    // covered text node; some also carry bold/italic. All must become internal.
    const bold = { type: 'bold' };
    const italic = { type: 'italic' };
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            linkNode('bold', '/s/x/p/abc', [bold]),
            linkNode(' plain ', '/s/x/p/abc'),
            linkNode('ital', '/s/x/p/abc', [italic]),
          ],
        },
      ],
    };
    markInternalLinks(doc);
    const marks = linkMarks(doc);
    expect(marks).toHaveLength(3);
    for (const m of marks) {
      expect(m.attrs.internal).toBe(true);
      expect(m.attrs.target).toBeNull();
      expect(m.attrs.rel).toBeNull();
    }
    // Nested bold/italic marks are preserved alongside the promoted link.
    const nested = doc.content[0].content;
    expect(nested[0].marks.some((m: any) => m.type === 'bold')).toBe(true);
    expect(nested[2].marks.some((m: any) => m.type === 'italic')).toBe(true);
  });

  it('is idempotent', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [linkNode('hi', '/s/eng/p/abc')] },
      ],
    };
    markInternalLinks(doc);
    const once = JSON.stringify(doc);
    markInternalLinks(doc);
    expect(JSON.stringify(doc)).toBe(once);
  });
});

describe('markdown import (full converter) — #522 acceptance', () => {
  it('promotes an internal link and leaves an external one external', () => {
    const doc = markdownToProseMirrorSync(
      '[t](/s/eng/p/abc123) and [ext](https://example.com/p/x)',
    );
    const marks = linkMarks(doc);
    const internal = marks.find((m) => m.attrs.href === '/s/eng/p/abc123');
    const external = marks.find(
      (m) => m.attrs.href === 'https://example.com/p/x',
    );
    expect(internal.attrs).toMatchObject({
      internal: true,
      target: null,
      rel: null,
    });
    expect(external.attrs).toMatchObject({
      internal: null,
      target: '_blank',
      rel: 'noopener noreferrer nofollow',
    });
  });

  it('does NOT promote the space-less /p/<slug> form (documented limit)', () => {
    const doc = markdownToProseMirrorSync('[t](/p/abc123)');
    const m = linkMarks(doc)[0];
    expect(m.attrs.internal).toBeNull();
    expect(m.attrs.target).toBe('_blank');
  });

  it('the promoted link is backlink-extractable (matches server regex + true)', () => {
    // Mirrors extractInternalLinkSlugIds: internal flag AND server-regex match.
    const doc = markdownToProseMirrorSync('[t](/s/eng/p/my-page-abc123)');
    const m = linkMarks(doc)[0];
    expect(m.attrs.internal).toBe(true);
    const match = m.attrs.href.match(SERVER_INTERNAL_LINK_REGEX);
    expect(match).not.toBeNull();
    // group 5 is the slug segment the server feeds to extractPageSlugId.
    expect(match![5]).toBe('my-page-abc123');
  });

  it('comment-body markdown gets the same treatment (shared converter path)', () => {
    // Comment bodies go through the same markdownToProseMirrorSync; a spot-check
    // that the shared path (not a comment-only branch) does the promotion.
    const doc = markdownToProseMirrorSync('see [here](/s/team/p/xyz789)');
    const m = linkMarks(doc).find((x) => x.attrs.href === '/s/team/p/xyz789');
    expect(m.attrs.internal).toBe(true);
  });
});

describe('canonicalize — internal:false ≡ external (#522 §11)', () => {
  it('drops editor-authored internal:false so external stays canonically equal', () => {
    // Editor stores external links with internal:false; import leaves it absent.
    const stored = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'x',
              marks: [
                {
                  type: 'link',
                  attrs: {
                    href: 'https://example.com',
                    internal: false,
                    target: '_blank',
                    rel: 'noopener noreferrer nofollow',
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const reimport = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'x',
              marks: [
                {
                  type: 'link',
                  attrs: {
                    href: 'https://example.com',
                    internal: null, // import default
                    target: '_blank',
                    rel: 'noopener noreferrer nofollow',
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    expect(docsCanonicallyEqual(stored, reimport)).toBe(true);
    // internal:false / target / rel all drop as defaults; only the non-default
    // href survives.
    const canon = canonicalizeContent(stored);
    const mark = canon.content[0].content[0].marks[0];
    expect(mark.attrs).toEqual({ href: 'https://example.com' });
  });

  it('keeps internal:true through canonicalization (non-default, load-bearing)', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'x',
              marks: [
                {
                  type: 'link',
                  attrs: { href: '/s/x/p/abc', internal: true },
                },
              ],
            },
          ],
        },
      ],
    };
    const canon = canonicalizeContent(doc);
    const mark = canon.content[0].content[0].marks[0];
    expect(mark.attrs.internal).toBe(true);
    expect(mark.attrs.href).toBe('/s/x/p/abc');
  });
});
