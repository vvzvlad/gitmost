import * as Y from 'yjs';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { getExtensionField, getSchema } from '@tiptap/core';
import { Node } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { Logger } from '@nestjs/common';
// The server's real schema first, so `@docmost/editor-ext` resolves to its built
// CJS dist; `@docmost/git-sync` is mapped to its TS source by the jest config
// (see git-sync-converter-gate.spec.ts).
import { inEditorShape, tiptapExtensions } from './collaboration.util';
import {
  docsCanonicallyEqual,
  markdownToProseMirror,
  parseDocmostMarkdown,
  stabilizePageFile,
} from '@docmost/git-sync';
import { CollaborationHandler } from './collaboration.handler';

/**
 * A body git-sync writes (a created page, an ingested git edit) must already
 * carry the block ids the editor's UniqueID extension stamps on open. Otherwise
 * the first browser that opens the page assigns them, and that write is stored
 * as the viewer's edit (lastUpdatedSource=user plus a history boundary row).
 */

// The block types the editor gives an id, from the same UniqueID config.
const idTypes: string[] = (tiptapExtensions as any[]).find(
  (ext) => ext.name === 'uniqueID',
).options.types;

/** Every node of `doc` (depth-first), as `{ type, attrs }`. */
function nodes(doc: any): { type: string; attrs?: any }[] {
  const out: { type: string; attrs?: any }[] = [];
  const walk = (n: any) => {
    out.push(n);
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc);
  return out;
}

/** A Hocuspocus whose direct connection writes into `shared` (an empty shell). */
function fakeHocuspocus(shared: Y.Doc) {
  return {
    openDirectConnection: jest.fn(async () => ({
      transact: async (fn: (doc: Y.Doc) => void) => fn(shared),
      disconnect: jest.fn(async () => undefined),
    })),
  } as any;
}

const MARKDOWN = [
  '# Title',
  '',
  'Intro paragraph.',
  '',
  '## Section',
  '',
  '- item one',
  '- item two',
  '  - nested item',
  '',
  '1. first',
  '2. second',
  '',
  '- [ ] a task',
  '',
  '> a quote',
  '',
  '| a | b |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '<div data-type="transclusionSource"><p>shared text</p></div>',
  '',
].join('\n');

describe('gitSyncWriteBody — block ids (opening a git-written page is not an edit)', () => {
  it('a git-sync-written doc carries an id on every block type the editor would give one', async () => {
    const shared = new Y.Doc();
    const handlers = new CollaborationHandler().getHandlers(
      fakeHocuspocus(shared),
    );

    await handlers.gitSyncWriteBody('page.p1', {
      prosemirrorJson: await markdownToProseMirror(MARKDOWN),
      userId: 'svc-user',
    });

    const written = nodes(TiptapTransformer.fromYdoc(shared, 'default'));
    // The corpus exercises every id-carrying type, nested ones included.
    const present = new Set(written.map((n) => n.type));
    for (const t of idTypes) expect(present).toContain(t);

    const idBlocks = written.filter((n) => idTypes.includes(n.type));
    const missing = idBlocks.filter(
      (n) => typeof n.attrs?.id !== 'string' || n.attrs.id.length === 0,
    );
    expect(missing).toEqual([]);
    const ids = idBlocks.map((n) => n.attrs.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/**
 * The editor's TrailingNode plugin (the real one, from the same extension
 * list): true when it would append a block on the first transaction after the
 * page is opened — a change stored as the viewer's edit.
 */
const schema = getSchema(tiptapExtensions);
const trailingNode = (tiptapExtensions as any[]).find(
  (ext) => ext.name === 'trailingNode',
);
function editorWouldAppend(json: any): boolean {
  const [plugin] = getExtensionField<() => any[]>(
    trailingNode,
    'addProseMirrorPlugins',
    {
      name: trailingNode.name,
      options: trailingNode.options,
      storage: trailingNode.storage,
      editor: { schema },
    } as any,
  )();
  const state = EditorState.create({
    doc: Node.fromJSON(schema, json),
    plugins: [plugin],
  });
  return state.applyTransaction(state.tr).transactions.length > 1;
}

/** Write `markdown` through gitSyncWriteBody into a fresh shell; the stored doc. */
async function writeFresh(markdown: string): Promise<any> {
  const shared = new Y.Doc();
  await new CollaborationHandler()
    .getHandlers(fakeHocuspocus(shared))
    .gitSyncWriteBody('page.p1', {
      prosemirrorJson: await markdownToProseMirror(markdown),
      userId: 'svc-user',
    });
  return TiptapTransformer.fromYdoc(shared, 'default');
}

/** The markdown body git-sync exports for `content`. */
async function exportedBody(content: any): Promise<string> {
  const file = await stabilizePageFile(content, {
    version: 1,
    pageId: 'p1',
    slugId: 's1',
    title: 'Page',
    spaceId: 'space-1',
    parentPageId: null,
  });
  return parseDocmostMarkdown(file).body;
}

/** Bodies ending in each block type the editor puts a paragraph after. */
const ENDINGS: Record<string, string> = {
  list: 'Intro.\n\n- one\n- two\n',
  table: '| a | b |\n| --- | --- |\n| 1 | 2 |\n',
  code: '```js\nconst a = 1;\n```\n',
  heading: 'Intro.\n\n## Last\n',
};

describe('gitSyncWriteBody — trailing paragraph (opening a git-written page is not an edit)', () => {
  it.each(Object.entries(ENDINGS))(
    'a doc ending in a %s is stored ending in the trailing paragraph, with its id',
    async (_kind, markdown) => {
      // Control: unshaped, the editor would append the paragraph on open.
      expect(editorWouldAppend(await markdownToProseMirror(markdown))).toBe(
        true,
      );

      const written = await writeFresh(markdown);

      const last = written.content[written.content.length - 1];
      expect(last.type).toBe(trailingNode.options.node);
      expect(last.content ?? []).toEqual([]);
      expect(typeof last.attrs?.id).toBe('string');
      expect(editorWouldAppend(written)).toBe(false);
    },
  );

  it('a doc ending in a paragraph gets no extra paragraph', async () => {
    const markdown = '- one\n\nLast words.\n';
    const written = await writeFresh(markdown);

    expect(written.content).toHaveLength(
      (await markdownToProseMirror(markdown)).content.length,
    );
    expect(editorWouldAppend(written)).toBe(false);
  });

  it('an empty body over a fresh shell is stored as one empty paragraph with its id', async () => {
    const written = await writeFresh('');

    expect(written.content).toHaveLength(1);
    expect(written.content[0].type).toBe('paragraph');
    expect(written.content[0].content ?? []).toEqual([]);
    expect(typeof written.content[0].attrs?.id).toBe('string');
    expect(editorWouldAppend(written)).toBe(false);
  });

  it('a git edit over a stored doc merges against the base in the stored shape: no conflict, no stray paragraph', async () => {
    const shared = new Y.Doc();
    const handlers = new CollaborationHandler().getHandlers(
      fakeHocuspocus(shared),
    );
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const write = async (markdown: string, base?: string) =>
      handlers.gitSyncWriteBody('page.p1', {
        prosemirrorJson: await markdownToProseMirror(markdown),
        baseProsemirrorJson:
          base === undefined ? undefined : await markdownToProseMirror(base),
        userId: 'svc-user',
      });

    try {
      await write('- one\n- two\n');
      // git appends a paragraph after the list, on top of the synced base.
      await write('- one\n- two\n\nAppended.\n', '- one\n- two\n');

      const written = TiptapTransformer.fromYdoc(shared, 'default');
      expect(written.content.map((n: any) => n.type)).toEqual([
        'bulletList',
        'paragraph',
      ]);
      expect(written.content[1].content[0].text).toBe('Appended.');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it.each(Object.entries(ENDINGS))(
    'a stored doc ending in a %s exports without the trailing paragraph, and its re-import is a no-op',
    async (_kind, markdown) => {
      const written = await writeFresh(markdown);
      const body = await exportedBody(written);

      // The trailing paragraph never reaches git: same export as git's own doc.
      expect(body).toBe(await exportedBody(await markdownToProseMirror(markdown)));
      // Export -> re-import is a fixpoint: the re-imported body, in the shape a
      // write stores, equals the stored doc (importPageMarkdown's no-op guard).
      expect(
        docsCanonicallyEqual(
          inEditorShape(await markdownToProseMirror(body)),
          written,
        ),
      ).toBe(true);
    },
  );
});
