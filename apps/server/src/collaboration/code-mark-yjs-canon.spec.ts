import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';
import { StarterKit } from '@tiptap/starter-kit';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { Code } from '@docmost/editor-ext';

import { tiptapExtensions } from './collaboration.util';

/**
 * #515 — the Yjs KEY canon of the inline `code` mark, on the SERVER schema that
 * actually reads and writes Y.Docs (`tiptapExtensions`, used by
 * persistence.extension.ts via TiptapTransformer.toYdoc / .fromYdoc).
 *
 * y-prosemirror derives the Yjs text-attribute key from the mark's SELF-exclusion
 * (`marksToAttributes`, y-prosemirror 1.3.7):
 *
 *   const isOverlapping = !mark.type.excludes(mark.type);
 *   pattrs[isOverlapping ? `${name}--${hashOfJSON(mark.toJSON())}` : name] = mark.attrs;
 *
 * A mark that does not exclude itself is assumed to be able to occur SEVERAL times
 * on one text run with different attrs (like `comment`) and is keyed by a hash.
 * #515 originally shipped `excludes: ""` ("exclude nothing, not even myself"), which
 * dropped inline code into that branch: every write persisted `code--<hash>` — a
 * second canon for a mark that has no attrs at all. `excludes: "code"` (exclude only
 * myself, ProseMirror's default) keeps the #515 behavior — code coexists with bold /
 * italic / … — on the stock Yjs representation.
 *
 * The parity test in packages/prosemirror-markdown pins the canonical mark and the
 * vendored markdown mirror; this spec pins the two things only the server can see:
 * the assembled `tiptapExtensions` schema, and the READ-BACK of documents that were
 * already persisted with the hashed key.
 */

const CODE_TEXT = 'inline code';

const docWithInlineCode = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [{ type: 'text', marks: [{ type: 'code' }], text: CODE_TEXT }],
    },
  ],
};

/**
 * The Yjs text-attribute keys as they are ACTUALLY persisted: the `default`
 * fragment's first paragraph, its first XmlText run, read through `toDelta()`
 * (the same shape the collab handler's mark helpers walk).
 */
function persistedMarkKeys(ydoc: Y.Doc): string[] {
  const fragment = ydoc.getXmlFragment('default');
  const paragraph = fragment.get(0) as Y.XmlElement;
  const text = paragraph.get(0) as unknown as Y.XmlText;
  const keys = new Set<string>();
  for (const op of text.toDelta()) {
    for (const key of Object.keys(op.attributes ?? {})) {
      keys.add(key);
    }
  }
  return [...keys];
}

describe('#515 server `code` mark: Yjs key canon (tiptapExtensions)', () => {
  const schema = getSchema(tiptapExtensions as any);
  const code = schema.marks.code;

  it('excludes ITSELF, so y-prosemirror keys it plainly (`code`, not `code--<hash>`)', () => {
    expect(code.excludes(code)).toBe(true);
  });

  it('excludes NO other mark (#515: inline code carries bold / italic / …)', () => {
    const evicted = Object.values(schema.marks)
      .filter((markType: any) => markType.name !== 'code')
      .filter((markType: any) => code.excludes(markType))
      .map((markType: any) => markType.name);
    expect(evicted).toEqual([]);
  });

  it('WRITE path (TiptapTransformer.toYdoc) persists inline code under the plain `code` key', () => {
    // The end-to-end statement of the invariant: not "the schema says X" but "the
    // bytes we hand to Yjs are keyed `code`".
    const ydoc = TiptapTransformer.toYdoc(
      docWithInlineCode,
      'default',
      tiptapExtensions as any,
    );
    expect(persistedMarkKeys(ydoc)).toEqual(['code']);
  });
});

describe('#515 back-compat: documents persisted with the hashed `code--<hash>` key', () => {
  // The `code` mark exactly as it was while the `excludes: ""` regression was live, so
  // the legacy key is REPRODUCED rather than hardcoded (a hand-copied hash would rot,
  // and would not prove that the hashed key was ever real). This is a MINIMAL schema,
  // not the full `tiptapExtensions` — equivalent for this purpose, because the hash
  // input is `mark.toJSON()` (`{type:'code'}`, no attrs), independent of which other
  // extensions are registered.
  const legacyExtensions = [
    StarterKit.configure({
      codeBlock: false,
      link: false,
      trailingNode: false,
      heading: false,
      code: false,
    }),
    Code.extend({ excludes: '' }),
  ];

  const legacyYdoc = () =>
    TiptapTransformer.toYdoc(
      docWithInlineCode,
      'default',
      legacyExtensions as any,
    );

  it('the `excludes: ""` schema really did persist a HASHED key (the regression, reproduced)', () => {
    const keys = persistedMarkKeys(legacyYdoc());
    expect(keys).toHaveLength(1);
    // y-prosemirror's `hashedMarkNameRegex`: /(.*)(--[a-zA-Z0-9+/=]{8})$/
    expect(keys[0]).toMatch(/^code--[A-Za-z0-9+/=]{8}$/);
    expect(keys[0]).not.toBe('code');
  });

  it('the READ path (TiptapTransformer.fromYdoc) still maps it back to a plain `code` mark', () => {
    // Pages edited during the `excludes: ""` window carry the hashed key on disk
    // FOREVER — no migration rewrites them. They keep rendering only because
    // y-prosemirror strips the suffix on the way out (`yattr2markname`). This is the
    // assertion that keeps that true: it is the exact call persistence.extension.ts
    // makes when it turns a loaded Y.Doc back into page content.
    const json: any = TiptapTransformer.fromYdoc(legacyYdoc(), 'default');

    const textNode = json.content[0].content[0];
    expect(textNode.text).toBe(CODE_TEXT);
    expect(textNode.marks.map((mark: any) => mark.type)).toEqual(['code']);
  });
});
