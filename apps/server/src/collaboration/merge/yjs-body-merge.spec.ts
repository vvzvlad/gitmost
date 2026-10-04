import * as Y from 'yjs';

import {
  mergeXmlFragments,
  mergeXmlFragments3Way,
  mergeXmlFragments3WayWithStats,
  cloneXmlNode,
  diffBlocks,
} from './yjs-body-merge';

// Build a Y.XmlFragment('default') in `doc` from a list of paragraph specs.
// Each spec is the paragraph's plain text (a single XmlText child).
function buildFragment(doc: Y.Doc, paragraphs: string[]): Y.XmlFragment {
  const frag = doc.getXmlFragment('default');
  const blocks = paragraphs.map((text) => {
    const el = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    if (text) t.insert(0, text);
    el.insert(0, [t]);
    return el;
  });
  if (blocks.length) frag.insert(0, blocks);
  return frag;
}

function texts(frag: Y.XmlFragment): string[] {
  return frag.toArray().map((el) => (el as Y.XmlElement).toArray()
    .map((c) => (c as Y.XmlText).toString())
    .join(''));
}

describe('yjs-body-merge', () => {
  describe('diffBlocks (LCS edit script)', () => {
    it('identical sequences produce only keeps (no edits)', () => {
      const ops = diffBlocks(['a', 'b', 'c'], ['a', 'b', 'c']);
      expect(ops.every((o) => o.op === 'keep')).toBe(true);
    });

    it('a single changed middle element is one del + one ins', () => {
      const ops = diffBlocks(['a', 'b', 'c'], ['a', 'B', 'c']);
      expect(ops.filter((o) => o.op === 'del')).toHaveLength(1);
      expect(ops.filter((o) => o.op === 'ins')).toHaveLength(1);
      expect(ops.filter((o) => o.op === 'keep')).toHaveLength(2);
    });
  });

  describe('mergeXmlFragments', () => {
    it('identical content is a complete no-op (0 ops) — never clobbers an unchanged resync', () => {
      const live = new Y.Doc();
      const target = new Y.Doc();
      const liveFrag = buildFragment(live, ['one', 'two', 'three']);
      const targetFrag = buildFragment(target, ['one', 'two', 'three']);

      // Capture block identities to prove they are left untouched.
      const before = liveFrag.toArray();
      let applied = -1;
      live.transact(() => {
        applied = mergeXmlFragments(liveFrag, targetFrag);
      });

      expect(applied).toBe(0);
      // Same Y.XmlElement instances — nothing was deleted/recreated.
      expect(liveFrag.toArray()).toEqual(before);
      expect(texts(liveFrag)).toEqual(['one', 'two', 'three']);
    });

    it('a human edit to one block survives a git change to a DIFFERENT block', () => {
      // Live: the human has the doc open; block 0 holds their edit. Git changed
      // only block 2. The merge must touch ONLY block 2 and leave block 0 (and
      // its in-flight edit) exactly as-is.
      const live = new Y.Doc();
      const target = new Y.Doc();
      const liveFrag = buildFragment(live, ['HUMAN EDIT', 'shared', 'old tail']);
      const targetFrag = buildFragment(target, [
        'HUMAN EDIT',
        'shared',
        'new tail from git',
      ]);

      const block0Before = liveFrag.get(0); // the human's block instance
      const block1Before = liveFrag.get(1);

      let applied = -1;
      live.transact(() => {
        applied = mergeXmlFragments(liveFrag, targetFrag);
      });

      // Only block 2 was replaced: one del + one ins.
      expect(applied).toBe(2);
      // The human's block and the shared block are the SAME instances (untouched).
      expect(liveFrag.get(0)).toBe(block0Before);
      expect(liveFrag.get(1)).toBe(block1Before);
      // Block 2 now carries git's content.
      expect(texts(liveFrag)).toEqual([
        'HUMAN EDIT',
        'shared',
        'new tail from git',
      ]);
    });

    it('appends a new trailing block without disturbing existing ones', () => {
      const live = new Y.Doc();
      const target = new Y.Doc();
      const liveFrag = buildFragment(live, ['a', 'b']);
      const targetFrag = buildFragment(target, ['a', 'b', 'c']);
      const a = liveFrag.get(0);
      const b = liveFrag.get(1);

      let applied = -1;
      live.transact(() => {
        applied = mergeXmlFragments(liveFrag, targetFrag);
      });

      expect(applied).toBe(1); // single insert
      expect(liveFrag.get(0)).toBe(a);
      expect(liveFrag.get(1)).toBe(b);
      expect(texts(liveFrag)).toEqual(['a', 'b', 'c']);
    });

    it('deletes a removed block, keeping its neighbours', () => {
      const live = new Y.Doc();
      const target = new Y.Doc();
      const liveFrag = buildFragment(live, ['a', 'b', 'c']);
      const targetFrag = buildFragment(target, ['a', 'c']);
      const a = liveFrag.get(0);

      let applied = -1;
      live.transact(() => {
        applied = mergeXmlFragments(liveFrag, targetFrag);
      });

      expect(applied).toBe(1); // single delete
      expect(liveFrag.get(0)).toBe(a);
      expect(texts(liveFrag)).toEqual(['a', 'c']);
    });

    it('a fully different body is replaced (and stays valid)', () => {
      const live = new Y.Doc();
      const target = new Y.Doc();
      const liveFrag = buildFragment(live, ['x', 'y']);
      const targetFrag = buildFragment(target, ['p', 'q', 'r']);
      live.transact(() => mergeXmlFragments(liveFrag, targetFrag));
      expect(texts(liveFrag)).toEqual(['p', 'q', 'r']);
    });
  });

  describe('mergeXmlFragments3Way', () => {
    it('keeps a human edit to one block while applying a git change to another (3-way)', () => {
      // base (last synced): [a, b, c]. Human edited block 0 in the live doc; git
      // changed block 2 in the incoming file. 3-way must keep BOTH — the 2-way
      // merge would instead revert the human's block 0 to git's stale version.
      const base = new Y.Doc();
      const live = new Y.Doc();
      const target = new Y.Doc();
      const baseFrag = buildFragment(base, ['a', 'b', 'c']);
      const liveFrag = buildFragment(live, ['HUMAN', 'b', 'c']);
      const targetFrag = buildFragment(target, ['a', 'b', 'GIT']);

      const humanBlock = liveFrag.get(0); // the human's live instance
      live.transact(() =>
        mergeXmlFragments3Way(liveFrag, targetFrag, baseFrag),
      );

      // Human's block preserved as the SAME instance; git's change applied.
      expect(liveFrag.get(0)).toBe(humanBlock);
      expect(texts(liveFrag)).toEqual(['HUMAN', 'b', 'GIT']);
    });

    it('a block both sides changed resolves to git (conflict policy)', () => {
      const base = new Y.Doc();
      const live = new Y.Doc();
      const target = new Y.Doc();
      const baseFrag = buildFragment(base, ['a', 'b', 'c']);
      const liveFrag = buildFragment(live, ['a', 'HUMAN', 'c']);
      const targetFrag = buildFragment(target, ['a', 'GIT', 'c']);

      live.transact(() =>
        mergeXmlFragments3Way(liveFrag, targetFrag, baseFrag),
      );
      expect(texts(liveFrag)).toEqual(['a', 'GIT', 'c']);
    });

    // Bug #2 observability: the stats variant reports the same-block conflict so
    // the handler can log it + the persistence layer can pin the human baseline.
    it('reports the same-block conflict count via mergeXmlFragments3WayWithStats', () => {
      const base = new Y.Doc();
      const live = new Y.Doc();
      const target = new Y.Doc();
      const baseFrag = buildFragment(base, ['a', 'b', 'c']);
      const liveFrag = buildFragment(live, ['a', 'HUMAN', 'c']);
      const targetFrag = buildFragment(target, ['a', 'GIT', 'c']);

      let result!: { applied: number; conflicts: number };
      live.transact(() => {
        result = mergeXmlFragments3WayWithStats(liveFrag, targetFrag, baseFrag);
      });
      expect(result.conflicts).toBe(1);
      expect(texts(liveFrag)).toEqual(['a', 'GIT', 'c']);
    });

    it('reports 0 conflicts for a clean different-block 3-way merge', () => {
      const base = new Y.Doc();
      const live = new Y.Doc();
      const target = new Y.Doc();
      const baseFrag = buildFragment(base, ['a', 'b', 'c']);
      const liveFrag = buildFragment(live, ['HUMAN', 'b', 'c']);
      const targetFrag = buildFragment(target, ['a', 'b', 'GIT']);

      let result!: { applied: number; conflicts: number };
      live.transact(() => {
        result = mergeXmlFragments3WayWithStats(liveFrag, targetFrag, baseFrag);
      });
      expect(result.conflicts).toBe(0);
      expect(texts(liveFrag)).toEqual(['HUMAN', 'b', 'GIT']);
    });

    it('git change with no concurrent human edit (live == base) applies cleanly', () => {
      const base = new Y.Doc();
      const live = new Y.Doc();
      const target = new Y.Doc();
      const baseFrag = buildFragment(base, ['a', 'b']);
      const liveFrag = buildFragment(live, ['a', 'b']);
      const targetFrag = buildFragment(target, ['a', 'B2']);

      live.transact(() =>
        mergeXmlFragments3Way(liveFrag, targetFrag, baseFrag),
      );
      expect(texts(liveFrag)).toEqual(['a', 'B2']);
    });
  });

  // Regression: start-of-document content duplicating on every two-way sync.
  //
  // The LIVE Docmost doc stamps a per-block UniqueID on every heading/paragraph;
  // a body arriving FROM git is parsed from clean markdown and carries NO block
  // ids. If the merge comparison key includes that `id`, an unchanged live block
  // never matches the SAME block coming from git, so the three-way merge cannot
  // anchor on it — and an incoming block with no anchor (content inserted at the
  // TOP of the page) is RE-ADDED on every cycle, an unbounded duplication loop.
  // These tests model that exact id-asymmetry and assert the reconciliation is
  // IDEMPOTENT (no block growth). They are RED before excluding `id` from the
  // key in `serializeXmlNode`.
  describe('idempotent reconciliation with live block ids (start-of-doc dup)', () => {
    // Build a fragment from block specs. `id` is set only when provided, mirroring
    // the live doc (ids present) vs a git-parsed body (ids absent).
    type Spec = { tag: 'heading' | 'paragraph'; text: string; id?: string };
    function buildDoc(doc: Y.Doc, specs: Spec[]): Y.XmlFragment {
      const frag = doc.getXmlFragment('default');
      const blocks = specs.map((s) => {
        const el = new Y.XmlElement(s.tag);
        if (s.id) el.setAttribute('id', s.id);
        if (s.tag === 'heading') el.setAttribute('level', '2');
        const t = new Y.XmlText();
        if (s.text) t.insert(0, s.text);
        el.insert(0, [t]);
        return el;
      });
      if (blocks.length) frag.insert(0, blocks);
      return frag;
    }
    const textsOf = (frag: Y.XmlFragment): string[] =>
      frag.toArray().map((el) =>
        (el as Y.XmlElement)
          .toArray()
          .map((c) => (c as Y.XmlText).toString())
          .join(''),
      );

    it('re-merging the SAME git body does NOT re-add the top block (idempotent)', () => {
      // last-synced base (from git markdown): NO block ids.
      const base = new Y.Doc();
      const baseFrag = buildDoc(base, [
        { tag: 'heading', text: 'Title' },
        { tag: 'paragraph', text: 'Some paragraph.' },
        { tag: 'paragraph', text: 'End block.' },
      ]);
      // live Docmost doc: SAME content, but every block carries a UniqueID.
      const live = new Y.Doc();
      const liveFrag = buildDoc(live, [
        { tag: 'heading', text: 'Title', id: 'ida' },
        { tag: 'paragraph', text: 'Some paragraph.', id: 'idb' },
        { tag: 'paragraph', text: 'End block.', id: 'idc' },
      ]);
      // incoming git body: the user inserted a heading at the very TOP.
      const buildTarget = (): Y.XmlFragment =>
        buildDoc(new Y.Doc(), [
          { tag: 'heading', text: 'TOPDUP' },
          { tag: 'heading', text: 'Title' },
          { tag: 'paragraph', text: 'Some paragraph.' },
          { tag: 'paragraph', text: 'End block.' },
        ]);

      // First sync: the top block is added once.
      live.transact(() =>
        mergeXmlFragments3Way(liveFrag, buildTarget(), baseFrag),
      );
      expect(textsOf(liveFrag)).toEqual([
        'TOPDUP',
        'Title',
        'Some paragraph.',
        'End block.',
      ]);

      // Subsequent sync of the SAME git body against the SAME base must be a
      // NO-OP — not a second copy of the top block. Before the fix this re-adds
      // 'TOPDUP', growing the doc on every cycle.
      live.transact(() =>
        mergeXmlFragments3Way(liveFrag, buildTarget(), baseFrag),
      );
      expect(textsOf(liveFrag)).toEqual([
        'TOPDUP',
        'Title',
        'Some paragraph.',
        'End block.',
      ]);
      expect(textsOf(liveFrag).filter((t) => t === 'TOPDUP')).toHaveLength(1);
    });

    it('an unchanged git body (live ids, none in git) is a complete no-op', () => {
      // base == git body (no pending git change); live is the same content with
      // ids. With `id` in the key the whole body looks rewritten; the merge must
      // still leave live byte-identical (block instances untouched).
      const base = new Y.Doc();
      const baseFrag = buildDoc(base, [
        { tag: 'heading', text: 'Title' },
        { tag: 'paragraph', text: 'Body.' },
      ]);
      const live = new Y.Doc();
      const liveFrag = buildDoc(live, [
        { tag: 'heading', text: 'Title', id: 'ida' },
        { tag: 'paragraph', text: 'Body.', id: 'idb' },
      ]);
      const before = liveFrag.toArray();
      let applied = -1;
      live.transact(() => {
        applied = mergeXmlFragments3Way(
          liveFrag,
          buildDoc(new Y.Doc(), [
            { tag: 'heading', text: 'Title' },
            { tag: 'paragraph', text: 'Body.' },
          ]),
          baseFrag,
        );
      });
      expect(applied).toBe(0);
      // Same live block instances (ids preserved) — nothing recreated.
      expect(liveFrag.toArray()).toEqual(before);
    });
  });

  // Regression: a line appended at the END of a page in git landed in the MIDDLE
  // of the live page, replacing one of the empty paragraphs there (wb, page with
  // images). The live images store numeric attrs (`width: 652`) while the git
  // body carries them as strings ("652"), and the editor leaves an empty XmlText
  // in a paragraph the user typed into and erased — so neither the images nor the
  // trailing empty paragraph matched their git twins, and the merge anchored the
  // git-side trailing paragraph (which became the new line) on an empty
  // paragraph in the middle of the page.
  describe('anchoring a live page edited in the browser', () => {
    type B =
      | { p: string }
      | { img: string }
      | { pdf: string }
      | { empty: 'bare' | 'erased' };
    function build(doc: Y.Doc, blocks: B[], numericAttrs: boolean) {
      const frag = doc.getXmlFragment('default');
      frag.insert(
        0,
        blocks.map((b) => {
          if ('pdf' in b) {
            // Default-sized pdf: the schema defaults are numbers (800x600).
            const el = new Y.XmlElement('pdf');
            el.setAttribute('attachmentId', b.pdf);
            el.setAttribute('width', (numericAttrs ? 800 : '800') as any);
            el.setAttribute('height', (numericAttrs ? 600 : '600') as any);
            return el;
          }
          if ('img' in b) {
            const el = new Y.XmlElement('image');
            el.setAttribute('attachmentId', b.img);
            el.setAttribute('width', (numericAttrs ? 652 : '652') as any);
            el.setAttribute(
              'aspectRatio',
              (numericAttrs ? 3.142857142857143 : '3.142857142857143') as any,
            );
            return el;
          }
          const el = new Y.XmlElement('paragraph');
          if ('p' in b) {
            const t = new Y.XmlText();
            t.insert(0, b.p);
            el.insert(0, [t]);
          } else if (b.empty === 'erased') {
            el.insert(0, [new Y.XmlText()]);
          }
          return el;
        }),
      );
      return frag;
    }
    const shape = (frag: Y.XmlFragment): string[] =>
      frag.toArray().map((el) => {
        const e = el as Y.XmlElement;
        if (e.nodeName === 'image') return `img:${e.getAttribute('attachmentId')}`;
        if (e.nodeName === 'pdf') return `pdf:${e.getAttribute('attachmentId')}`;
        const text = e.toArray().map((c) => (c as Y.XmlText).toString()).join('');
        return text || '_';
      });

    it('a line appended in git lands at the end, not in place of a middle empty paragraph', () => {
      // git body (base): no empty paragraphs (the export drops them) except the
      // trailing one the editor shape adds after a final image.
      const gitBlocks: B[] = [
        { p: 'one' }, { img: 'a' }, { img: 'b' }, { p: 'two' }, { img: 'c' },
        { img: 'd' }, { img: 'e' }, { img: 'f' },
      ];
      const baseFrag = build(new Y.Doc(), [...gitBlocks, { empty: 'bare' }], false);
      const targetFrag = build(new Y.Doc(), [...gitBlocks, { p: 'NEW' }], false);
      const live = new Y.Doc();
      const liveFrag = build(
        live,
        [
          { p: 'one' }, { img: 'a' }, { img: 'b' }, { p: 'two' }, { img: 'c' },
          { empty: 'erased' }, { empty: 'bare' }, { empty: 'bare' }, { empty: 'bare' },
          { img: 'd' }, { img: 'e' }, { img: 'f' },
          { empty: 'erased' },
        ],
        true,
      );

      let res: { applied: number; conflicts: number } | undefined;
      live.transact(() => {
        res = mergeXmlFragments3WayWithStats(liveFrag, targetFrag, baseFrag);
      });

      expect(shape(liveFrag)).toEqual([
        'one', 'img:a', 'img:b', 'two', 'img:c', '_', '_', '_', '_',
        'img:d', 'img:e', 'img:f', 'NEW',
      ]);
      expect(res!.conflicts).toBe(0);
    });

    it.each(['bare', 'erased'] as const)(
      'a page ending in a default-sized pdf anchors on it (%s middle empty paragraph)',
      (middle) => {
        const gitBlocks: B[] = [{ p: 'one' }, { p: 'two' }, { pdf: 'p' }];
        const baseFrag = build(new Y.Doc(), [...gitBlocks, { empty: 'bare' }], false);
        const targetFrag = build(new Y.Doc(), [...gitBlocks, { p: 'NEW' }], false);
        const live = new Y.Doc();
        const liveFrag = build(
          live,
          [{ p: 'one' }, { p: 'two' }, { empty: middle }, { pdf: 'p' }, { empty: 'erased' }],
          true,
        );

        live.transact(() =>
          mergeXmlFragments3WayWithStats(liveFrag, targetFrag, baseFrag),
        );

        expect(shape(liveFrag)).toEqual(['one', 'two', '_', 'pdf:p', 'NEW']);
      },
    );
  });

  describe('cloneXmlNode', () => {
    it('preserves text marks (XmlText delta) across docs', () => {
      const src = new Y.Doc();
      const srcFrag = src.getXmlFragment('default');
      const el = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'plain ');
      t.insert(6, 'bold', { bold: true });
      el.insert(0, [t]);
      srcFrag.insert(0, [el]);

      const dst = new Y.Doc();
      const dstFrag = dst.getXmlFragment('default');
      dstFrag.insert(0, [cloneXmlNode(srcFrag.get(0) as Y.XmlElement)]);

      const clonedText = (dstFrag.get(0) as Y.XmlElement).get(0) as Y.XmlText;
      expect(clonedText.toDelta()).toEqual([
        { insert: 'plain ' },
        { insert: 'bold', attributes: { bold: true } },
      ]);
    });
  });
});
