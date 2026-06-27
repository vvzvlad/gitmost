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
 * (`ImportService.importPage`). It exercises the REAL markdown -> HTML -> JSON
 * conversion and asserts that the stored page content has its footnotes
 * canonicalized — the gap that issue #228 fixes: the import path builds
 * ProseMirror JSON directly (never running the editor's footnoteSyncPlugin), so
 * before this wiring the stored footnotes kept the markdown's physical
 * definition order (out of order vs. references), retained orphan definitions,
 * and did not collapse reused references.
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
function footnoteListIds(content: any): string[] {
  const list = (content.content ?? []).find(
    (n: any) => n.type === 'footnotesList',
  );
  if (!list) return [];
  return (list.content ?? [])
    .filter((n: any) => n.type === 'footnoteDefinition')
    .map((n: any) => n.attrs?.id);
}

function definitionText(content: any, id: string): string | undefined {
  const list = (content.content ?? []).find(
    (n: any) => n.type === 'footnotesList',
  );
  const def = (list?.content ?? []).find(
    (n: any) => n.type === 'footnoteDefinition' && n.attrs?.id === id,
  );
  return def?.content?.[0]?.content?.[0]?.text;
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

    // Reference order is c, a, b (NOT the markdown definition order a, b, c).
    expect(footnoteListIds(content)).toEqual(['c', 'a', 'b']);

    // Definitions preserved and attached to the right ids.
    expect(definitionText(content, 'c')).toBe('note C');
    expect(definitionText(content, 'a')).toBe('note A');
    expect(definitionText(content, 'b')).toBe('note B');

    // Orphan definition [^z] is dropped.
    expect(footnoteListIds(content)).not.toContain('z');

    // Reused [^a] yields exactly ONE definition, and exactly one list.
    const lists = (content.content ?? []).filter(
      (n: any) => n.type === 'footnotesList',
    );
    expect(lists).toHaveLength(1);
    expect(footnoteListIds(content).filter((id) => id === 'a')).toHaveLength(1);
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
    expect(footnoteListIds(second)).toEqual(['c', 'a', 'b']);
  });
});
