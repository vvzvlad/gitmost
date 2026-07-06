import { TiptapTransformer } from '@hocuspocus/transformer';
import * as Y from 'yjs';
import {
  markdownToProseMirror,
  convertProseMirrorToMarkdown,
} from '@docmost/git-sync';

import { tiptapExtensions } from '../collaboration.util';
import { mergeXmlFragments, mergeXmlFragments3Way } from './yjs-body-merge';

/**
 * Regression for the QA #119 callout findings (body-duplication re-verify +
 * "callout strips the whole body"). These reproduce the ACTUAL live merge path:
 *
 *   live  = TiptapTransformer.toYdoc(editor JSON, tiptapExtensions)   (the
 *           collaboration server's materialization — schema defaults stamped)
 *   git   = toYdoc(markdownToProseMirror(convertProseMirrorToMarkdown(editor)))
 *           (the engine round-trip the push side feeds into writePageBody)
 *
 * A page containing a callout (with a neighbouring heading + paragraphs) must:
 *   - merge with ZERO ops on an unchanged resync (no duplication — bug #1), and
 *   - NEVER lose blocks / collapse to empty (no strip — bug #2),
 * across repeated cycles, for every editor-canonical callout type.
 */

const toYdoc = (content: unknown[]) =>
  TiptapTransformer.toYdoc(
    { type: 'doc', content },
    'default',
    tiptapExtensions as any,
  );

const blockTypes = (f: Y.XmlFragment) =>
  f.toArray().map((n: any) => n.nodeName);

function editorPage(calloutType: string) {
  return [
    {
      type: 'heading',
      attrs: { id: 'h1', level: 1 },
      content: [{ type: 'text', text: 'Title here' }],
    },
    {
      type: 'paragraph',
      attrs: { id: 'p1' },
      content: [{ type: 'text', text: 'Para before callout' }],
    },
    {
      type: 'callout',
      attrs: { type: calloutType },
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'pc' },
          content: [{ type: 'text', text: 'Inside the callout' }],
        },
      ],
    },
    {
      type: 'paragraph',
      attrs: { id: 'p2' },
      content: [{ type: 'text', text: 'Para after callout' }],
    },
  ];
}

async function gitRoundTrip(content: unknown[]): Promise<any[]> {
  const md = await convertProseMirrorToMarkdown({ type: 'doc', content });
  const json = await markdownToProseMirror(md);
  return json.content;
}

describe('git-sync callout merge is idempotent + non-destructive (QA #119)', () => {
  for (const type of ['info', 'note', 'warning', 'danger', 'success', 'default']) {
    it(`callout(${type}) resyncs with 0 ops and never strips the body`, async () => {
      const editor = editorPage(type);
      const gitContent = await gitRoundTrip(editor);

      const liveDoc = toYdoc(editor);
      const live = liveDoc.getXmlFragment('default');
      const before = live.toArray().length;
      expect(before).toBe(4);

      // 2-way: live vs the git round-trip -> no-op (no dup, no strip).
      let applied = -1;
      liveDoc.transact(() => {
        applied = mergeXmlFragments(live, toYdoc(gitContent).getXmlFragment('default'));
      });
      expect(applied).toBe(0);
      expect(live.toArray().length).toBe(before);

      // 3-way across 4 cycles with base == git (the steady-state) -> stable.
      for (let cycle = 0; cycle < 4; cycle++) {
        let a = -1;
        liveDoc.transact(() => {
          a = mergeXmlFragments3Way(
            live,
            toYdoc(gitContent).getXmlFragment('default'),
            toYdoc(gitContent).getXmlFragment('default'),
          );
        });
        expect(a).toBe(0);
        expect(live.toArray().length).toBe(before);
        expect(blockTypes(live)).toEqual([
          'heading',
          'paragraph',
          'callout',
          'paragraph',
        ]);
      }
    });
  }

  it('3-way with a stale base (callout JUST added) keeps the callout + neighbours', async () => {
    // base = the previously-synced version WITHOUT the callout (git round-trip);
    // the human just inserted the callout -> the merge must KEEP everything.
    const prev = [
      { type: 'heading', attrs: { id: 'h1', level: 1 }, content: [{ type: 'text', text: 'Title here' }] },
      { type: 'paragraph', attrs: { id: 'p1' }, content: [{ type: 'text', text: 'Para before callout' }] },
      { type: 'paragraph', attrs: { id: 'p2' }, content: [{ type: 'text', text: 'Para after callout' }] },
    ];
    const editor = editorPage('info');
    const baseContent = await gitRoundTrip(prev);
    const gitContent = await gitRoundTrip(editor);

    const liveDoc = toYdoc(editor);
    const live = liveDoc.getXmlFragment('default');
    liveDoc.transact(() => {
      mergeXmlFragments3Way(
        live,
        toYdoc(gitContent).getXmlFragment('default'),
        toYdoc(baseContent).getXmlFragment('default'),
      );
    });
    // Body survives in full — NOT stripped to empty / a lone paragraph.
    expect(blockTypes(live)).toEqual([
      'heading',
      'paragraph',
      'callout',
      'paragraph',
    ]);
  });
});

describe('git-sync callout type fidelity (QA "callout type -> [!info]")', () => {
  for (const type of ['info', 'note', 'warning', 'danger', 'success', 'default']) {
    it(`preserves callout type "${type}" across the engine round-trip`, async () => {
      const content = editorPage(type);
      const gitContent = await gitRoundTrip(content);
      const co = gitContent.find((b: any) => b.type === 'callout');
      expect(co?.attrs?.type).toBe(type);
    });
  }

  it('maps a known GitHub/Obsidian alias to the editor banner (tip -> success)', async () => {
    // `tip` is not a schema callout type — it is an input alias the editor itself
    // maps onto the supported set (GITHUB_ALERT_TYPE_MAP: tip -> success). git-sync
    // mirrors that so the ingest lands on the closest banner instead of flatly info.
    const content = editorPage('tip');
    const gitContent = await gitRoundTrip(content);
    const co = gitContent.find((b: any) => b.type === 'callout');
    expect(co?.attrs?.type).toBe('success');
  });

  it('flattens a genuinely unknown callout type to info', async () => {
    const content = editorPage('banana'); // not a type and not a known alias
    const gitContent = await gitRoundTrip(content);
    const co = gitContent.find((b: any) => b.type === 'callout');
    expect(co?.attrs?.type).toBe('info');
  });
});
