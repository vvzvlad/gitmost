// Importing ImportService transitively loads import-formatter.ts, which imports
// the ESM-only @sindresorhus/slugify package (not in jest's transform
// allowlist). slugify is irrelevant to the path under test, so it is mocked out
// to keep the module graph loadable under ts-jest.
jest.mock('@sindresorhus/slugify', () => ({
  __esModule: true,
  default: (input: string) => String(input),
}));

import { ImportService } from './import.service';
import { canonicalizeFootnotes } from '@docmost/editor-ext';

/**
 * Integration-ish test for the USER-FACING markdown import path
 * (`ImportService.importPage`). It exercises the REAL markdown -> ProseMirror
 * conversion and asserts the stored page's footnotes are canonical: ordered by
 * FIRST REFERENCE (not markdown definition order), reused references deduped to a
 * single definition, and orphan definitions dropped.
 *
 * Since #345 the markdown parse runs through the canonical package
 * (`normalizeForeignMarkdown` -> `markdownToProseMirror`), which owns this
 * canonicalization: the input's GFM `[^id]` reference footnotes are normalized to
 * inline `^[…]`, and the parser assigns fresh sequential ids (`fn-*`) in
 * reference order while merging identical bodies — so we assert by definition
 * BODY order, not by the source labels. `canonicalizeFootnotes` remains wired as
 * an idempotent safety net (issue #228) and is a no-op on this already-canonical
 * output.
 *
 * The DB/ydoc side-effects are stubbed: `getNewPagePosition` (DB query) and
 * `createYdoc` (Yjs encode) are spied, and `pageRepo.insertPage` captures the
 * persisted `content`. Everything between markdown and persistence is REAL.
 */

// Out-of-order references (c, a, b), a REUSED reference ([^a] twice -> one
// footnote), and an ORPHAN definition ([^z], never referenced).
const MARKDOWN = [
  '# Title',
  '',
  'Body refs [^c] and [^a] and [^b] and again [^a].',
  '',
  '[^a]: note A',
  '[^b]: note B',
  '[^c]: note C',
  '[^z]: orphan note',
].join('\n');

function makeFile(filename: string, contents: string) {
  return {
    filename,
    toBuffer: async () => Buffer.from(contents),
  } as any;
}

function makeService() {
  let captured: any = null;
  const pageRepo = {
    insertPage: jest.fn(async (values: any) => {
      captured = values;
      return { id: 'page-id', slugId: 'slug-id' };
    }),
  };
  const service = new ImportService(
    pageRepo as any,
    {} as any,
    {} as any,
    {} as any,
  );
  jest.spyOn(service as any, 'getNewPagePosition').mockResolvedValue('a0');
  jest
    .spyOn(service as any, 'createYdoc')
    .mockResolvedValue(Buffer.from([]) as any);
  return { service, pageRepo, getCaptured: () => captured };
}

/** List the footnote-definition ids of the (single) footnotesList, in order. */
/** Definition body texts of the (single) footnotesList, in list order. */
function footnoteListBodies(content: any): string[] {
  const list = (content.content ?? []).find(
    (n: any) => n.type === 'footnotesList',
  );
  return (list?.content ?? [])
    .filter((n: any) => n.type === 'footnoteDefinition')
    .map((n: any) => n.content?.[0]?.content?.[0]?.text);
}

describe('ImportService.importPage — footnote canonicalization (#228)', () => {
  it('orders footnotes by first reference, dedupes reuse, and drops orphans', async () => {
    const { service, getCaptured } = makeService();

    await service.importPage(
      Promise.resolve(makeFile('note.md', MARKDOWN)),
      'user-id',
      'space-id',
      'workspace-id',
    );

    const content = getCaptured().content;
    expect(content).toBeTruthy();

    // Definitions ordered by FIRST REFERENCE (C, A, B) — NOT the markdown
    // definition order (A, B, C) — with the orphan [^z] dropped and the reused
    // [^a] collapsed to a single definition. (Ids are the parser's fresh `fn-*`,
    // so we pin the BODIES.)
    expect(footnoteListBodies(content)).toEqual(['note C', 'note A', 'note B']);

    // Orphan definition [^z] is dropped.
    expect(footnoteListBodies(content)).not.toContain('orphan note');

    // Reused [^a] yields exactly ONE definition, and exactly one list.
    const lists = (content.content ?? []).filter(
      (n: any) => n.type === 'footnotesList',
    );
    expect(lists).toHaveLength(1);
    expect(
      footnoteListBodies(content).filter((b) => b === 'note A'),
    ).toHaveLength(1);
  });

  it('is idempotent: canonicalizing the stored output again is a no-op', async () => {
    const { service, getCaptured } = makeService();
    await service.importPage(
      Promise.resolve(makeFile('note.md', MARKDOWN)),
      'user-id',
      'space-id',
      'workspace-id',
    );
    const stored = getCaptured().content;

    // The stored content is already canonical; running the canonicalizer a second
    // time must not change it (safe to wire into every write path).
    const second = canonicalizeFootnotes(stored);
    expect(second).toEqual(stored);
    expect(footnoteListBodies(second)).toEqual(['note C', 'note A', 'note B']);
  });
});
