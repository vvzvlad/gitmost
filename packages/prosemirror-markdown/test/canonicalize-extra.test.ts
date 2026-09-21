import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
// Barrel import (R-Infra alias resolves this to packages/docmost-client/src so
// coverage measures the real source, not stale dist).
import { canonicalizeContent, docsCanonicallyEqual } from 'docmost-client';

// ---------------------------------------------------------------------------
// Gaps NOT covered by canonicalize.test.ts (test-strategy report §2 diff):
//   - the *.align family (drawio/excalidraw/video/youtube/embed AND image, whose
//     align default is unified to "center" per #293 canon #4): a "center"
//     default is dropped, a non-default value is kept;
//   - comment.resolved: TRUE is PRESERVED (only resolved:false is normalized);
//   - link.target / link.rel NON-default values are kept;
//   - property: canonicalizeContent is a fixpoint, docsCanonicallyEqual is
//     reflexive and symmetric.
// The base file already covers id-stripping, null-drop, link/comment/orderedList
// default-drop, key-order insensitivity, and a real-diff negative — not re-added.
// ---------------------------------------------------------------------------

describe('canonicalizeContent — *.align default family', () => {
  // Every diagram/media node whose schema `align` defaults to "center".
  const alignTypes = ['drawio', 'excalidraw', 'video', 'youtube', 'embed'];

  for (const type of alignTypes) {
    it(`${type}: align "center" (the schema default) is dropped`, () => {
      const out = canonicalizeContent({
        type,
        attrs: { id: 'n-1', src: '/x', align: 'center' },
      });
      // align==default removed; the meaningful src survives.
      expect(out.attrs).toEqual({ src: '/x' });
    });

    it(`${type}: a NON-default align (e.g. "right") is kept`, () => {
      const out = canonicalizeContent({
        type,
        attrs: { id: 'n-1', src: '/x', align: 'right' },
      });
      expect(out.attrs).toEqual({ src: '/x', align: 'right' });
    });
  }

  it('image align default is now "center" (#293 canon #4): center/null dropped, left kept', () => {
    // A real non-default value ("left") must be kept.
    const kept = canonicalizeContent({
      type: 'image',
      attrs: { id: 'i-1', src: '/a.png', align: 'left' },
    });
    expect(kept.attrs).toEqual({ src: '/a.png', align: 'left' });
    // #293 canon #4 unified the image align default to "center" (matching
    // editor-ext), so a center image now DROPS align exactly like the diagram/
    // media family — bare `![](src)` images stay canonically clean.
    const center = canonicalizeContent({
      type: 'image',
      attrs: { id: 'i-2', src: '/b.png', align: 'center' },
    });
    expect(center.attrs).toEqual({ src: '/b.png' });
    // A null align is likewise dropped (null-drop rule) and re-imports as center.
    const nullAlign = canonicalizeContent({
      type: 'image',
      attrs: { id: 'i-3', src: '/c.png', align: null },
    });
    expect(nullAlign.attrs).toEqual({ src: '/c.png' });
  });
});

describe('canonicalizeContent — comment.resolved:true preserved (SPEC §11 L66)', () => {
  it('keeps resolved:true (a legitimate change, not a default to normalize away)', () => {
    const out = canonicalizeContent({
      type: 'text',
      text: 'anchored',
      marks: [{ type: 'comment', attrs: { commentId: 'cmt-1', resolved: true } }],
    });
    // resolved:true is NON-default; it must survive alongside the commentId so a
    // resolve-vs-unresolved divergence is not falsely reported as equal.
    expect(out.marks).toEqual([
      { type: 'comment', attrs: { commentId: 'cmt-1', resolved: true } },
    ]);
  });

  it('a resolved:true comment is NOT canonically equal to an unresolved one', () => {
    const resolved = {
      type: 'text',
      text: 'x',
      marks: [{ type: 'comment', attrs: { commentId: 'c', resolved: true } }],
    };
    const open = {
      type: 'text',
      text: 'x',
      marks: [{ type: 'comment', attrs: { commentId: 'c' } }],
    };
    expect(docsCanonicallyEqual(resolved, open)).toBe(false);
  });
});

describe('canonicalizeContent — link non-default target/rel kept', () => {
  it('keeps a NON-default link.target (e.g. "_self")', () => {
    const out = canonicalizeContent({
      type: 'text',
      text: 'l',
      marks: [{ type: 'link', attrs: { href: 'https://e.com', target: '_self' } }],
    });
    // _self != the "_blank" default, so target must survive.
    expect(out.marks).toEqual([
      { type: 'link', attrs: { href: 'https://e.com', target: '_self' } },
    ]);
  });

  it('keeps a NON-default link.rel', () => {
    const out = canonicalizeContent({
      type: 'text',
      text: 'l',
      marks: [{ type: 'link', attrs: { href: 'https://e.com', rel: 'nofollow' } }],
    });
    expect(out.marks).toEqual([
      { type: 'link', attrs: { href: 'https://e.com', rel: 'nofollow' } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Property-based oracle checks (SPEC §11). The generated trees mix node/mark
// types, ids, null attrs, known-default attrs and meaningful attrs, so the
// invariants are exercised across the whole canonicalization surface.
// ---------------------------------------------------------------------------

// An attribute value: a meaningful value, a null/undefined, a block id, or a
// known schema default — so pruning, id-drop, null-drop and default-drop all
// fire during shrinking.
const attrValueArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 6 }),
  fc.integer({ min: 0, max: 9 }),
  fc.boolean(),
  fc.constant(null),
);

// A recursive ProseMirror-ish node arbitrary (bounded depth) with type, attrs
// (incl. an id and possibly a known default), optional marks and content.
const nodeArb: fc.Arbitrary<any> = fc.letrec((tie) => ({
  node: fc.record(
    {
      type: fc.constantFrom(
        'paragraph',
        'heading',
        'orderedList',
        'drawio',
        'video',
        'text',
      ),
      text: fc.option(fc.string({ minLength: 0, maxLength: 5 }), { nil: undefined }),
      attrs: fc.option(
        fc.dictionary(
          fc.constantFrom('id', 'level', 'start', 'align', 'src', 'indent', 'keep'),
          attrValueArb,
          { maxKeys: 4 },
        ),
        { nil: undefined },
      ),
      marks: fc.option(
        fc.array(
          fc.record({
            type: fc.constantFrom('bold', 'link', 'comment'),
            attrs: fc.option(
              fc.dictionary(
                fc.constantFrom('href', 'target', 'rel', 'commentId', 'resolved'),
                fc.oneof(attrValueArb, fc.constant('_blank')),
                { maxKeys: 3 },
              ),
              { nil: undefined },
            ),
          }),
          { maxLength: 2 },
        ),
        { nil: undefined },
      ),
      content: fc.option(fc.array(tie('node'), { maxLength: 2 }), { nil: undefined }),
    },
    { requiredKeys: ['type'] },
  ),
})).node;

describe('canonicalizeContent — property invariants (SPEC §11 oracle)', () => {
  it('is a fixpoint: f(f(x)) === f(x)', () => {
    fc.assert(
      fc.property(nodeArb, (node) => {
        const once = canonicalizeContent(node);
        const twice = canonicalizeContent(once);
        // The canonical form must already be stable under a second pass.
        expect(twice).toEqual(once);
      }),
      { numRuns: 300 },
    );
  });

  it('docsCanonicallyEqual is reflexive: equal(x, x) is always true', () => {
    fc.assert(
      fc.property(nodeArb, (node) => {
        expect(docsCanonicallyEqual(node, node)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('docsCanonicallyEqual is symmetric: equal(a, b) === equal(b, a)', () => {
    fc.assert(
      fc.property(nodeArb, nodeArb, (a, b) => {
        expect(docsCanonicallyEqual(a, b)).toBe(docsCanonicallyEqual(b, a));
      }),
      { numRuns: 300 },
    );
  });
});
