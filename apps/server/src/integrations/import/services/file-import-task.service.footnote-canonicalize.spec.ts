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

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileImportTaskService } from './file-import-task.service';
import { ImportService } from './import.service';

/**
 * Binding test for issue #228 / review #5: FileImportTaskService.processGenericImport
 * is a NON-editor write path (markdownToHtml -> processHTML -> JSON, never runs
 * footnoteSyncPlugin), so it canonicalizes footnotes before persisting. This pins
 * that binding — the same one import.service has a spec for — which previously had
 * NO spec at all.
 *
 * The markdown -> HTML -> ProseMirror conversion is REAL (a real ImportService,
 * its createYdoc stubbed); the filesystem is a real temp dir with one .md file;
 * the DB transaction is stubbed to capture the persisted page content.
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

function footnoteListIds(content: any): string[] {
  const list = (content?.content ?? []).find(
    (n: any) => n.type === 'footnotesList',
  );
  return (list?.content ?? [])
    .filter((n: any) => n.type === 'footnoteDefinition')
    .map((n: any) => n.attrs?.id);
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

describe('FileImportTaskService.processGenericImport — footnote canonicalization (#228)', () => {
  it('orders footnotes by first reference, dedupes reuse, and drops orphans on zip import', async () => {
    const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fit-canon-'));
    await fs.writeFile(path.join(extractDir, 'note.md'), MARKDOWN, 'utf-8');

    // Real ImportService for the html -> JSON conversion; stub the yjs encode.
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
    const backlinkRepo = { insertBacklink: jest.fn() };
    const eventEmitter = { emit: jest.fn() };
    const auditService = { logBatchWithContext: jest.fn() };

    const pageService = { nextPagePosition: async () => 'a0' };

    const service = new FileImportTaskService(
      {} as any, // storageService
      importService as any,
      pageService as any,
      backlinkRepo as any,
      db,
      importAttachmentService as any,
      eventEmitter as any,
      auditService as any,
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
      const content = captured.content;
      // Reference order is c, a, b (NOT the markdown definition order a, b, c).
      expect(footnoteListIds(content)).toEqual(['c', 'a', 'b']);
      // Orphan [^z] dropped; reused [^a] collapses to one definition; one list.
      expect(footnoteListIds(content)).not.toContain('z');
      const lists = (content.content ?? []).filter(
        (n: any) => n.type === 'footnotesList',
      );
      expect(lists).toHaveLength(1);
      expect(footnoteListIds(content).filter((id) => id === 'a')).toHaveLength(1);
    } finally {
      await fs.rm(extractDir, { recursive: true, force: true });
    }
  });
});
