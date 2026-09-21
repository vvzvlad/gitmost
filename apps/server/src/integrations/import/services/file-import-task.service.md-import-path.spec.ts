// Importing FileImportTaskService transitively loads import-formatter.ts, which
// imports the ESM-only @sindresorhus/slugify package (not in jest's transform
// allowlist). slugify is irrelevant to the path under test, so it is mocked out
// to keep the module graph loadable under ts-jest (mirrors the sibling specs).
jest.mock('@sindresorhus/slugify', () => ({
  __esModule: true,
  default: (input: string) => String(input),
}));
// import-attachment.service.ts (loaded transitively for DI typing) imports the
// ESM-only `p-limit` / `image-dimensions`; neither is exercised here.
jest.mock('p-limit', () => ({
  __esModule: true,
  default: () => (fn: any) => fn(),
}));
jest.mock('image-dimensions', () => ({
  __esModule: true,
  imageDimensionsFromData: () => undefined,
}));
// FileImportTaskService -> PageService -> collaboration.gateway ->
// metrics.registry imports `prom-client`, which is not resolvable in this
// workspace's node_modules (types-only stub, no runtime entry).
jest.mock(
  'prom-client',
  () => ({
    collectDefaultMetrics: () => undefined,
    Registry: class {},
    Histogram: class {},
    Gauge: class {},
    Counter: class {},
    Summary: class {},
  }),
  { virtual: true },
);

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { canonicalizeFootnotes } from '@docmost/editor-ext';
import { FileImportTaskService } from './file-import-task.service';
import { ImportService } from './import.service';

/**
 * Zip `.md` import path (#555).
 *
 * The zip importer parses a `.md` entry with the canonical converter
 * (`markdownToProseMirror`, since #345) and then serializes the result to HTML
 * (`jsonToHtml`) so the entry joins the SHARED HTML pipeline that `.html`
 * entries use: `processAttachments` -> `formatImportHtml` -> `processHTML`.
 * That PM -> HTML -> PM hop was suspected of degrading `.md` content relative to
 * the single-file `.md` path (`ImportService.processMarkdown`, which parses
 * straight to ProseMirror with no HTML intermediate).
 *
 * This spec pins BOTH halves of the answer, because they pull in opposite
 * directions and a future "just call markdownToProseMirror directly" cleanup
 * would silently break the second half:
 *
 *  1. FIDELITY — for prose, the hop is faithful: a zip `.md` page ends up with
 *     the SAME ProseMirror as the single-file `.md` path (modulo the `id` /
 *     `indent` attrs that `htmlToJson`'s addUniqueIdsToDoc assigns by design).
 *     Footnotes, front matter, inline code, math, callouts, lists and code
 *     blocks all survive.
 *
 *  2. LOAD-BEARING — the hop is NOT redundant plumbing. It is the ONLY reason a
 *     zip `.md` gets attachment resolution, internal-page links + backlinks,
 *     provider embeds, and markdown-table column widths. Those come from the
 *     HTML pipeline and have no equivalent on the direct markdown -> PM path.
 *
 * The conversion is REAL (a real ImportService, its createYdoc stubbed); the
 * filesystem is a real temp dir standing in for the extracted zip; the DB
 * transaction is stubbed to capture the persisted pages.
 */

/** Permissive chainable stub for the `spaces` lookup. */
function chainable(result: any): any {
  const proxy: any = new Proxy(function () {}, {
    get: (_t, prop) => {
      if (prop === 'executeTakeFirst') return async () => result;
      if (prop === 'execute') return async () => [];
      return () => proxy;
    },
  });
  return proxy;
}

interface ZipRun {
  /** Persisted page rows, in insertion order. */
  pages: any[];
  /** Backlink rows handed to BacklinkRepo.insertBacklink. */
  backlinks: any[];
  /** The HTML each page handed to ImportAttachmentService.processAttachments. */
  attachmentHtml: Map<string, string>;
}

/**
 * Run a set of extracted zip files through the REAL generic zip import.
 * `files` maps a zip-relative path to its contents (directories are created).
 */
async function runZipImport(files: Record<string, string | Buffer>): Promise<ZipRun> {
  const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fit-md-path-'));

  for (const [relPath, body] of Object.entries(files)) {
    const abs = path.join(extractDir, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body as any);
  }

  const importService = new ImportService(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  jest
    .spyOn(importService as any, 'createYdoc')
    .mockResolvedValue(Buffer.from([]) as any);

  const pages: any[] = [];
  const trx = {
    insertInto: (table: string) => ({
      values: (row: any) => {
        if (table === 'pages') pages.push(row);
        return { execute: async () => {} };
      },
    }),
  };
  const db: any = {
    selectFrom: () => chainable({ slug: 'space-slug' }),
    transaction: () => ({ execute: (fn: any) => fn(trx) }),
  };

  const backlinks: any[] = [];
  const attachmentHtml = new Map<string, string>();

  // Pass the HTML through untouched, but record it: what reaches
  // processAttachments IS the attachment-resolution surface.
  const importAttachmentService = {
    processAttachments: async ({ html, pageRelativePath }: any) => {
      attachmentHtml.set(pageRelativePath, html);
      return html;
    },
  };

  const service = new FileImportTaskService(
    {} as any, // storageService
    importService as any,
    { nextPagePosition: async () => 'a0' } as any,
    {
      insertBacklink: async (rows: any[]) => {
        backlinks.push(...rows);
      },
    } as any,
    db,
    importAttachmentService as any,
    { emit: jest.fn() } as any,
    { logBatchWithContext: jest.fn() } as any,
  );

  const fileTask: any = {
    id: 'task-1',
    source: 'generic',
    spaceId: 'space-1',
    workspaceId: 'ws-1',
    creatorId: 'user-1',
  };

  try {
    await service.processGenericImport({ extractDir, fileTask });
    return { pages, backlinks, attachmentHtml };
  } finally {
    await fs.rm(extractDir, { recursive: true, force: true });
  }
}

/**
 * The single-file `.md` path: `ImportService.processMarkdown` (markdown -> PM
 * directly) + the same title / footnote post-processing `importPage` applies.
 * This is the canonical reference the zip path is compared against.
 */
async function runSingleFileImport(
  markdown: string,
): Promise<{ title: string | null; content: any }> {
  const svc = new ImportService({} as any, {} as any, {} as any, {} as any);
  const pm = await svc.processMarkdown(markdown);
  const { title, prosemirrorJson } = svc.extractTitleAndRemoveHeading(pm);
  return { title, content: canonicalizeFootnotes(prosemirrorJson) };
}

/**
 * Drop the `id` and `indent` attrs before comparing the two paths.
 *
 * They are NOT content: `htmlToJson` runs addUniqueIdsToDoc, so every block on
 * the zip path gets a fresh `id` and an explicit `indent: 0`, while the direct
 * markdown parse leaves both null. Everything else must match.
 */
function stripBlockAttrs(node: any): any {
  return JSON.parse(
    JSON.stringify(node, (key, value) => {
      if (key === 'attrs' && value && typeof value === 'object') {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { id, indent, ...rest } = value as Record<string, unknown>;
        return rest;
      }
      return value;
    }),
  );
}

/** Find the first node of a given type anywhere in a PM content tree. */
function findFirst(node: any, type: string): any {
  if (!node || typeof node !== 'object') return null;
  if (node.type === type) return node;
  for (const child of node.content ?? []) {
    const hit = findFirst(child, type);
    if (hit) return hit;
  }
  return null;
}

/**
 * Find the first TEXT node carrying a given mark type. Asserting on a bare
 * `text` node proves nothing (every non-empty document has one) — the mark is
 * what the fidelity claim is about.
 */
function findTextWithMark(node: any, mark: string): any {
  if (!node || typeof node !== 'object') return null;
  if (
    node.type === 'text' &&
    (node.marks ?? []).some((m: any) => m?.type === mark)
  ) {
    return node;
  }
  for (const child of node.content ?? []) {
    const hit = findTextWithMark(child, mark);
    if (hit) return hit;
  }
  return null;
}

/** Concatenate every text node in a PM content tree (document order). */
function allText(node: any): string {
  if (!node || typeof node !== 'object') return '';
  if (node.type === 'text') return typeof node.text === 'string' ? node.text : '';
  return (node.content ?? []).map((c: any) => allText(c)).join('');
}

/** Definition body texts of the (single) footnotesList, in list order. */
function footnoteListBodies(content: any): string[] {
  const list = (content?.content ?? []).find(
    (n: any) => n.type === 'footnotesList',
  );
  return (list?.content ?? [])
    .filter((n: any) => n.type === 'footnoteDefinition')
    .map((n: any) => n.content?.[0]?.content?.[0]?.text);
}

describe('zip .md import path — fidelity of the PM->HTML->PM hop (#555)', () => {
  /**
   * The headline claim. A prose-only `.md` (no attachments, no internal links,
   * no table — i.e. nothing the HTML pipeline is meant to rewrite) must come out
   * of the zip importer IDENTICAL to the single-file `.md` importer.
   *
   * Front matter, an ATX title, inline code (incl. code spans that contain
   * emphasis/underscore markers), inline + block math, a callout, a fenced code
   * block, a task list, a hard break and out-of-order/reused/orphan footnotes are
   * all exercised in one document, so a regression anywhere in the hop shows up
   * as a diff here.
   */
  it('produces the SAME ProseMirror as the single-file .md path for prose', async () => {
    const markdown = [
      '---',
      'title: Front Matter Title',
      'tags: alpha',
      '---',
      '',
      '# Doc Title',
      '',
      'Inline `a_b_c` and *`emphasized code`* stay code.',
      '',
      'Math $x^2$ inline, and a block:',
      '',
      '$$',
      'a + b',
      '$$',
      '',
      ':::warning',
      'Careful now.',
      ':::',
      '',
      '```js',
      'const a = 1;',
      '```',
      '',
      '- [ ] todo',
      '- [x] done',
      '',
      'line one  ',
      'line two',
      '',
      '> quoted',
      '',
      '1. first',
      '2. second',
      '   - nested bullet',
      '',
      'A ~~struck~~ word and an escaped \\*literal asterisk\\*.',
      '',
      '---',
      '',
      'Refs [^c] and [^a] and [^b] and again [^a].',
      '',
      '[^a]: note A',
      '[^b]: note B',
      '[^c]: note C',
      '[^z]: orphan note',
    ].join('\n');

    const single = await runSingleFileImport(markdown);
    const { pages } = await runZipImport({ 'note.md': markdown });

    expect(pages).toHaveLength(1);
    const zipPage = pages[0];

    // Title extraction behaves identically (the H1 becomes the page title and is
    // removed from the body; the front matter is stripped by the parser).
    expect(single.title).toBe('Doc Title');
    expect(zipPage.title).toBe('Doc Title');

    // The hop is faithful: same ProseMirror, modulo the id/indent attrs that
    // addUniqueIdsToDoc assigns on the HTML path by design.
    expect(stripBlockAttrs(zipPage.content)).toEqual(
      stripBlockAttrs(single.content),
    );

    // Sanity: the document really did carry the constructs we claim survive
    // (guards against the comparison passing on two equally-empty docs).
    expect(findFirst(zipPage.content, 'mathInline')).toBeTruthy();
    expect(findFirst(zipPage.content, 'callout')?.attrs?.type).toBe('warning');
    expect(findFirst(zipPage.content, 'codeBlock')).toBeTruthy();
    expect(findFirst(zipPage.content, 'taskList')).toBeTruthy();
    expect(findFirst(zipPage.content, 'hardBreak')).toBeTruthy();
    expect(findFirst(zipPage.content, 'orderedList')).toBeTruthy();
    expect(findFirst(zipPage.content, 'horizontalRule')).toBeTruthy();
    // A text node actually carrying the `code` MARK — not merely "some text
    // node" (which any non-empty document has, so it would assert nothing).
    expect(findTextWithMark(zipPage.content, 'code')?.text).toBe('a_b_c');
    // The strike mark and the escaped asterisk survive as content, not markup.
    expect(findTextWithMark(zipPage.content, 'strike')?.text).toBe('struck');
    expect(allText(zipPage.content)).toContain('*literal asterisk*');
  });

  /**
   * Footnote canonicalization (#228) still holds on the zip path: definitions are
   * ordered by FIRST REFERENCE (c, a, b — not the source's a, b, c), the reused
   * [^a] collapses to one definition, and the orphan [^z] is dropped.
   */
  it('canonicalizes footnotes for a zip .md (reference order, deduped, no orphans)', async () => {
    const markdown = [
      '# Title',
      '',
      'Body refs [^c] and [^a] and [^b] and again [^a].',
      '',
      '[^a]: note A',
      '[^b]: note B',
      '[^c]: note C',
      '[^z]: orphan note',
    ].join('\n');

    const { pages } = await runZipImport({ 'note.md': markdown });
    const content = pages[0].content;

    expect(footnoteListBodies(content)).toEqual(['note C', 'note A', 'note B']);
    expect(footnoteListBodies(content)).not.toContain('orphan note');
    expect(
      (content.content ?? []).filter((n: any) => n.type === 'footnotesList'),
    ).toHaveLength(1);

    // Same as the single-file path.
    const single = await runSingleFileImport(markdown);
    expect(footnoteListBodies(single.content)).toEqual(
      footnoteListBodies(content),
    );
  });
});

/**
 * These four behaviors exist ONLY because the zip `.md` entry is serialized to
 * HTML and pushed through the shared HTML pipeline. Dropping the hop in favor of
 * a direct `markdownToProseMirror` call — the "unification" #555 proposed — would
 * silently regress every one of them, so they are pinned here.
 */
describe('zip .md import path — behaviors the HTML pipeline provides (#555)', () => {
  it('resolves a relative image through the attachment pipeline', async () => {
    const { attachmentHtml } = await runZipImport({
      'note.md': '# Note\n\n![a pic](assets/pic.png)',
      'assets/pic.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]) as any,
    });

    // The markdown image must reach processAttachments as a real <img> with its
    // RELATIVE src — that is what gets uploaded and rewritten to /api/files/...
    // A direct markdown -> PM path would never hand it to the attachment service.
    const html = attachmentHtml.get('note.md');
    expect(html).toContain('<img');
    expect(html).toContain('src="assets/pic.png"');
  });

  it('rewrites an internal .md link to an internal page link and records a backlink', async () => {
    const { pages, backlinks } = await runZipImport({
      'note.md': '# Note\n\nGo to [Other](other.md) now.',
      'other.md': '# Other\n\nhi',
    });

    const note = pages.find((p) => p.title === 'Note');
    const other = pages.find((p) => p.title === 'Other');

    // The link mark now points at the imported page, not the raw file name.
    const linked = JSON.stringify(note.content);
    expect(linked).toContain('/s/space-slug/p/');
    expect(linked).not.toContain('href":"other.md"');
    expect(linked).toContain('"internal":true');

    // ...and the cross-page backlink was recorded.
    expect(backlinks).toHaveLength(1);
    expect(backlinks[0]).toMatchObject({
      sourcePageId: note.id,
      targetPageId: other.id,
      workspaceId: 'ws-1',
    });
  });

  it('turns a provider URL into an embed node', async () => {
    const { pages } = await runZipImport({
      'v.md': '# V\n\nWatch https://www.youtube.com/watch?v=abc123\n',
    });

    const embed = findFirst(pages[0].content, 'embed');
    expect(embed).toBeTruthy();
    expect(embed.attrs?.provider).toBe('youtube');
    expect(embed.attrs?.src).toBe('https://www.youtube.com/watch?v=abc123');
  });

  it('applies the default column width to a markdown-sourced table', async () => {
    const { pages } = await runZipImport({
      't.md': '# T\n\n| A | B |\n| --- | --- |\n| 1 | 2 |',
    });

    // normalizeTableColumnWidths deliberately widths markdown tables (150px per
    // column) so the table can overflow-scroll instead of being crammed.
    const header = findFirst(pages[0].content, 'tableHeader');
    expect(header?.attrs?.colwidth).toEqual([150]);

    // The direct markdown -> PM parse does NOT do this — proving the behavior is
    // owned by the HTML pipeline, not the converter.
    const single = await runSingleFileImport('# T\n\n| A | B |\n| --- | --- |\n| 1 | 2 |');
    expect(findFirst(single.content, 'tableHeader')?.attrs?.colwidth).toBeNull();
  });
});
