import * as Y from 'yjs';

import { mergeXmlFragments, mergeXmlFragments3Way } from './yjs-body-merge';

/**
 * Regression for the HIGH-severity runaway whole-body duplication: a page body
 * was RE-APPENDED in full on every git-sync reconcile cycle, unbounded, with NO
 * client connected.
 *
 * ROOT CAUSE (confirmed in-process against the real failing page): the LIVE Yjs
 * document materializes the editor-schema default `indent: 0` on every
 * paragraph/heading (and on the paragraph inside every list item, callout, and
 * table cell), but a body re-imported from git — parsed from clean markdown —
 * carries NO indent attribute. So every live block's comparison key differed from
 * the same block coming back from git; the three-way merge could anchor on
 * NOTHING, and the trailing unit that git's export already contained (but the
 * merge could not match against the byte-identical live tail) was re-appended
 * each cycle. Each grown export then diverged from the last-pushed base by one
 * more unit — a self-sustaining loop.
 *
 * The fix normalizes the materialized default (`indent: 0`) out of the block key
 * (the schema-derived `serializeXmlNode` normalization in yjs-body-merge.ts drops
 * every attr equal to its ProseMirror-schema default; `indent: 0` is one such),
 * so a live block compares equal to its git-round-tripped twin and the resync is
 * a true no-op. The sibling `yjs-body-merge.schema-defaults.spec.ts` covers the
 * rest of the bug class (image.align, link mark internal, …).
 *
 * These tests model that EXACTLY at the Yjs level: a LIVE fragment whose blocks
 * carry `indent: 0` + block ids, versus a git-derived fragment of the SAME
 * content with neither — for a body built from BYTE-IDENTICAL units that each
 * contain a heading, a paragraph, a callout, and a table with empty cells (the
 * trigger). RED before the fix (the merge applies > 0 ops and the body grows),
 * GREEN after (0 ops, no growth).
 */

type Attrs = Record<string, string | number>;

function el(
  name: string,
  attrs: Attrs,
  children: (Y.XmlElement | Y.XmlText)[],
) {
  const e = new Y.XmlElement(name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v as string);
  if (children.length) e.insert(0, children);
  return e;
}

function text(s: string): Y.XmlText {
  const t = new Y.XmlText();
  if (s) t.insert(0, s);
  return t;
}

/**
 * One byte-identical content unit (heading / paragraph / callout / table-with-
 * empty-cells). `live` toggles the two things that exist ONLY in the live Yjs
 * doc and NOT in a git round-trip: the materialized `indent: 0` default and the
 * per-block `id`. `n` makes each unit's ids unique (as the editor would stamp)
 * while keeping the visible CONTENT byte-identical across units.
 */
function unit(
  live: boolean,
  n: number,
  headingText = 'Big Heading',
): Y.XmlElement[] {
  const ind: Attrs = live ? { indent: 0 } : {};
  const id = (base: string): Attrs => (live ? { id: `${base}${n}` } : {});
  const para = (attrs: Attrs, s: string) =>
    el('paragraph', { ...attrs, ...ind }, [text(s)]);

  const cell = (name: string) =>
    el(name, { colspan: 1, rowspan: 1 }, [para({}, '')]);

  return [
    el('heading', { ...id('h'), level: 1, ...ind }, [text(headingText)]),
    para(id('p'), 'Para with the same words'),
    el('callout', { type: 'info' }, [para(id('c'), 'CalloutText here')]),
    el('table', {}, [
      el('tableRow', {}, [cell('tableHeader'), cell('tableHeader')]),
      el('tableRow', {}, [cell('tableCell'), cell('tableCell')]),
    ]),
  ];
}

function fragmentOf(units: Y.XmlElement[][]): {
  doc: Y.Doc;
  frag: Y.XmlFragment;
} {
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment('default');
  const blocks = units.flat();
  if (blocks.length) frag.insert(0, blocks);
  return { doc, frag };
}

const blockCount = (frag: Y.XmlFragment): number => frag.toArray().length;

describe('git-sync reconcile import is idempotent (no whole-body duplication)', () => {
  const UNITS = 3;

  it('3-way: identical content, live carries indent:0, base stale-by-one -> 0 ops, no growth', () => {
    // LIVE: the editor-stamped Yjs doc (indent:0 + ids on every block).
    const { doc: liveDoc, frag: live } = fragmentOf(
      Array.from({ length: UNITS }, (_, i) => unit(true, i)),
    );
    // INCOMING (git export -> re-import): same content, NO indent / ids.
    const { frag: incoming } = fragmentOf(
      Array.from({ length: UNITS }, (_, i) => unit(false, i)),
    );
    // BASE = last-pushed file, lagging by ONE unit (the realistic divergence
    // that drives the trailing insert-vs-insert).
    const { frag: base } = fragmentOf(
      Array.from({ length: UNITS - 1 }, (_, i) => unit(false, i)),
    );

    const before = blockCount(live);
    let applied = -1;
    liveDoc.transact(() => {
      applied = mergeXmlFragments3Way(live, incoming, base);
    });

    expect(applied).toBe(0);
    expect(blockCount(live)).toBe(before);
  });

  it('3-way is a fixpoint across repeated cycles (does not grow)', () => {
    const { doc: liveDoc, frag: live } = fragmentOf(
      Array.from({ length: UNITS }, (_, i) => unit(true, i)),
    );
    const incomingUnits = () =>
      fragmentOf(Array.from({ length: UNITS }, (_, i) => unit(false, i))).frag;
    const baseUnits = () =>
      fragmentOf(Array.from({ length: UNITS - 1 }, (_, i) => unit(false, i)))
        .frag;

    const before = blockCount(live);
    for (let cycle = 0; cycle < 5; cycle++) {
      let applied = -1;
      liveDoc.transact(() => {
        applied = mergeXmlFragments3Way(live, incomingUnits(), baseUnits());
      });
      expect(applied).toBe(0);
      expect(blockCount(live)).toBe(before);
    }
  });

  it('2-way: identical content, live carries indent:0 -> 0 ops, no growth', () => {
    const { doc: liveDoc, frag: live } = fragmentOf(
      Array.from({ length: UNITS }, (_, i) => unit(true, i)),
    );
    const { frag: incoming } = fragmentOf(
      Array.from({ length: UNITS }, (_, i) => unit(false, i)),
    );

    const before = blockCount(live);
    let applied = -1;
    liveDoc.transact(() => {
      applied = mergeXmlFragments(live, incoming);
    });

    expect(applied).toBe(0);
    expect(blockCount(live)).toBe(before);
  });

  it('does NOT regress real edits: a git change to one block still lands', () => {
    const { doc: liveDoc, frag: live } = fragmentOf(
      Array.from({ length: UNITS }, (_, i) => unit(true, i)),
    );
    const base = fragmentOf(
      Array.from({ length: UNITS }, (_, i) => unit(false, i)),
    ).frag;
    // git edits the heading text of the LAST unit.
    const incoming = fragmentOf(
      Array.from({ length: UNITS }, (_, i) =>
        unit(false, i, i === UNITS - 1 ? 'EDITED Heading' : 'Big Heading'),
      ),
    ).frag;

    const before = blockCount(live);
    liveDoc.transact(() => {
      mergeXmlFragments3Way(live, incoming, base);
    });

    // The edit landed, and the body did NOT grow (one block changed in place).
    const headings = live
      .toArray()
      .filter((b) => (b as Y.XmlElement).nodeName === 'heading')
      .map((b) =>
        (b as Y.XmlElement)
          .toArray()
          .map((c) => (c as Y.XmlText).toString())
          .join(''),
      );
    expect(headings).toContain('EDITED Heading');
    expect(blockCount(live)).toBe(before);
  });
});
