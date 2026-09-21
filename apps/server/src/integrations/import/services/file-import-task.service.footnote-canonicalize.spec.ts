// Importing FileImportTaskService transitively loads import-formatter.ts, which
// imports the ESM-only @sindresorhus/slugify package (not in jest's transform
// allowlist). slugify is irrelevant to the path under test, so it is mocked out
// to keep the module graph loadable under ts-jest (mirrors the import.service spec).
jest.mock('@sindresorhus/slugify', () => ({
  __esModule: true,
  default: (input: string) => String(input),
}));
// import-attachment.service.ts (loaded transitively for DI typing) imports the
// ESM-only `p-limit` / `image-dimensions`; neither is exercised on the path under
// test, so stub them so the module graph loads under ts-jest.
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
// workspace's node_modules (types-only stub, no runtime entry). Metrics are
// disabled on this path, so a virtual no-op mock keeps the module graph loadable.
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
import { FileImportTaskService } from './file-import-task.service';
import { ImportService } from './import.service';

/**
 * Binding test for issue #228 / review #5: FileImportTaskService.processGenericImport
 * is a NON-editor write path, so a zip-imported `.md` page ends up with canonical
 * footnotes before persisting: ordered by first reference, reused refs deduped,
 * orphan definitions dropped.
 *
 * Since #345 the `.md` parse runs `normalizeForeignMarkdown` ->
 * `markdownToProseMirror` -> `jsonToHtml` (feeding the shared HTML attachment /
 * link pipeline) -> `processHTML` -> `canonicalizeFootnotes`. The parser assigns
 * fresh `fn-*` ids, so we assert by definition BODY order rather than the source
 * labels. The conversion is REAL (a real ImportService, its createYdoc stubbed);
 * the filesystem is a real temp dir with one .md file; the DB transaction is
 * stubbed to capture the persisted page content.
 */

// Out-of-order references (c, a, b), a REUSED reference ([^a] twice), and an
// ORPHAN definition ([^z], never referenced).
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

/** Definition body texts of the (single) footnotesList, in list order. */
function footnoteListBodies(content: any): string[] {
  const list = (content?.content ?? []).find(
    (n: any) => n.type === 'footnotesList',
  );
  return (list?.content ?? [])
    .filter((n: any) => n.type === 'footnoteDefinition')
    .map((n: any) => n.content?.[0]?.content?.[0]?.text);
}

// A permissive chainable stub for the spaces lookup (selectFrom(...).select(...)
// .where(...).executeTakeFirst()).
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

/**
 * Run one markdown file through the REAL zip-import pipeline
 * (`processGenericImport` -> `markdownToProseMirror` -> `jsonToHtml` ->
 * `processHTML`/`htmlToJson`) and return the persisted page `content`. This is
 * the server-specific PM->HTML->PM hop that the package's own PM<->MD tests do
 * NOT cover.
 */
async function runZipImport(markdown: string): Promise<any> {
  const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fit-canon-'));
  await fs.writeFile(path.join(extractDir, 'note.md'), markdown, 'utf-8');

  const importService = new ImportService(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  jest
    .spyOn(importService as any, 'createYdoc')
    .mockResolvedValue(Buffer.from([]) as any);

  let captured: any = null;
  const trx = {
    insertInto: (table: string) => ({
      values: (v: any) => {
        if (table === 'pages') captured = v;
        return { execute: async () => {} };
      },
    }),
  };
  const db: any = {
    selectFrom: () => chainable({ slug: 'space-slug' }),
    transaction: () => ({ execute: (fn: any) => fn(trx) }),
  };

  const importAttachmentService = {
    processAttachments: async ({ html }: any) => html,
  };
  const service = new FileImportTaskService(
    {} as any, // storageService
    importService as any,
    { nextPagePosition: async () => 'a0' } as any,
    { insertBacklink: jest.fn() } as any,
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
    expect(captured).toBeTruthy();
    return captured.content;
  } finally {
    await fs.rm(extractDir, { recursive: true, force: true });
  }
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

describe('FileImportTaskService.processGenericImport — footnote canonicalization (#228)', () => {
  it('orders footnotes by first reference, dedupes reuse, and drops orphans on zip import', async () => {
    const content = await runZipImport(MARKDOWN);
    // Definitions ordered by FIRST REFERENCE (C, A, B), NOT the markdown
    // definition order (A, B, C). Ids are the parser's fresh `fn-*`, so pin
    // the BODIES.
    expect(footnoteListBodies(content)).toEqual(['note C', 'note A', 'note B']);
    // Orphan [^z] dropped; reused [^a] collapses to one definition; one list.
    expect(footnoteListBodies(content)).not.toContain('orphan note');
    const lists = (content.content ?? []).filter(
      (n: any) => n.type === 'footnotesList',
    );
    expect(lists).toHaveLength(1);
    expect(
      footnoteListBodies(content).filter((b) => b === 'note A'),
    ).toHaveLength(1);
  });

  // #345 F4: the zip path routes markdown through jsonToHtml -> processHTML ->
  // htmlToJson (the shared HTML attachment pipeline). #345's headline is LOSSLESS
  // image width/align via the `<!--img {...}-->` comment; a callout carries its
  // `type`. This asserts those survive the PM->HTML->PM hop — the one hop the
  // package's PM<->MD suite does not exercise.
  it('preserves image width/align and callout type through the PM->HTML->PM hop', async () => {
    const md = [
      '# Doc',
      '',
      '![a picture](https://example.com/i.png) <!--img {"width":"320","align":"left"}-->',
      '',
      ':::warning',
      'Careful now.',
      ':::',
    ].join('\n');

    const content = await runZipImport(md);

    const image = findFirst(content, 'image');
    expect(image).toBeTruthy();
    // The lossless sizing/alignment must survive the HTML hop.
    expect(String(image.attrs?.width)).toBe('320');
    expect(image.attrs?.align).toBe('left');

    const callout = findFirst(content, 'callout');
    expect(callout).toBeTruthy();
    expect(callout.attrs?.type).toBe('warning');
  });
});
