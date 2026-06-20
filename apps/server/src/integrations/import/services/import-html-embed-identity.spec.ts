// Exercises the REAL htmlEmbed admin gate on the two import write paths:
//
//   (1) ImportService.importPage()            — single .html/.md upload
//   (2) FileImportTaskService.processGenericImport() — zip / multi-file import
//
// Both build content/textContent/ydoc directly and persist (bypassing the
// collab onStoreDocument strip), so each must run the imported document through
// the toggle-AND-admin gate: resolve the importer via userRepo.findById, read
// the workspace toggle, then `htmlEmbedAllowed(enabled, role)` -> if not allowed,
// `stripHtmlEmbedNodes` BEFORE persisting.
//
// This spec constructs the REAL services with deps mocked, feeds an imported
// HTML document that contains an `htmlEmbed` div (parsed into a real htmlEmbed
// node by the REAL htmlToJson), runs the real method, and asserts the PERSISTED
// content (captured at the insert boundary) is stripped for a non-admin /
// missing user and preserved for admin/owner + toggle ON. Mirrors the GOOD
// pattern in transclusion/spec/transclusion-unsync-html-embed.spec.ts.
//
// Three modules are mocked away because they pull transitive ESM deps that
// jest's transformIgnorePatterns does not transpile (`lib0/decoding.js` via the
// collab gateway, `@sindresorhus/slugify` via import-formatter, `p-limit` via
// import-attachment). None of them participate in the gate decision:
//   - import-formatter: contextless HTML cleanup + link rewriting; replaced with
//     faithful passthroughs (the embed div has no href/iframe, so the real
//     normalizer would leave it untouched anyway).
//   - import-attachment: attachment rewriting; passthrough returns html as-is.
jest.mock('../../../collaboration/collaboration.gateway', () => ({
  CollaborationGateway: class {},
}));
jest.mock('../utils/import-formatter', () => ({
  normalizeImportHtml: () => {},
  formatImportHtml: async (opts: any) => ({
    html: opts.html,
    backlinks: [],
    pageIcon: undefined,
  }),
}));
jest.mock('./import-attachment.service', () => ({
  ImportAttachmentService: class {},
}));

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ImportService } from './import.service';
import { FileImportTaskService } from './file-import-task.service';
import { hasHtmlEmbedNode } from '../../../common/helpers/prosemirror/html-embed.util';

const WS = 'ws-1';
const SPACE = 'space-1';
const USER = 'importer-1';

// HTML carrying the serialized htmlEmbed node. The REAL htmlToJson parses
// `<div data-type="htmlEmbed" data-source="BASE64">` into an htmlEmbed PM node
// (base64 below decodes to `<script>x</script>`).
const HTML_WITH_EMBED =
  '<p>imported body</p>' +
  '<div data-type="htmlEmbed" data-source="PHNjcmlwdD54PC9zY3JpcHQ+"></div>';

function workspaceRepoFor(featureEnabled: boolean) {
  return {
    findById: jest.fn(async () => ({
      id: WS,
      settings: { htmlEmbed: featureEnabled },
    })),
  };
}

// userRepo.findById resolves the importer's role (or undefined for a missing
// user -> fail closed).
function userRepoFor(user: { role?: string } | undefined) {
  return { findById: jest.fn(async () => user) };
}

describe('ImportService.importPage htmlEmbed admin gate (real code)', () => {
  // Run importPage with a single uploaded .html and return the persisted content
  // captured at pageRepo.insertPage.
  async function persistedContent(
    featureEnabled: boolean,
    user: { role?: string } | undefined,
  ) {
    const captured: any[] = [];
    const pageRepo: any = {
      insertPage: jest.fn(async (row: any) => {
        captured.push(row);
        return { id: 'p1', slugId: 's1', ...row };
      }),
    };
    // db is only used for getNewPagePosition (a select chain).
    const selectChain: any = {
      select: () => selectChain,
      where: () => selectChain,
      orderBy: () => selectChain,
      limit: () => selectChain,
      executeTakeFirst: async () => undefined,
    };
    const db: any = { selectFrom: () => selectChain };

    const service = new ImportService(
      pageRepo,
      userRepoFor(user) as any,
      { putBuffer: jest.fn() } as any, // storageService (unused on this path)
      db,
      { add: jest.fn() } as any, // fileTaskQueue (unused)
      workspaceRepoFor(featureEnabled) as any,
    );

    const file: any = {
      filename: 'doc.html',
      toBuffer: async () => Buffer.from(HTML_WITH_EMBED, 'utf-8'),
    };
    await service.importPage(Promise.resolve(file), USER, SPACE, WS);
    expect(captured).toHaveLength(1);
    return captured[0].content;
  }

  it('toggle ON + member: persisted content has htmlEmbed stripped', async () => {
    const content = await persistedContent(true, { role: 'member' });
    expect(hasHtmlEmbedNode(content)).toBe(false);
    expect(JSON.stringify(content)).toContain('imported body');
  });

  it('toggle ON + missing user (findById -> undefined): fails closed (stripped)', async () => {
    expect(hasHtmlEmbedNode(await persistedContent(true, undefined))).toBe(
      false,
    );
  });

  it('toggle ON + admin: persisted content keeps the htmlEmbed', async () => {
    expect(hasHtmlEmbedNode(await persistedContent(true, { role: 'admin' }))).toBe(
      true,
    );
  });

  it('toggle ON + owner: persisted content keeps the htmlEmbed', async () => {
    expect(hasHtmlEmbedNode(await persistedContent(true, { role: 'owner' }))).toBe(
      true,
    );
  });

  it('toggle OFF + admin: stripped (feature disabled for everyone)', async () => {
    expect(
      hasHtmlEmbedNode(await persistedContent(false, { role: 'admin' })),
    ).toBe(false);
  });
});

describe('FileImportTaskService.processGenericImport htmlEmbed admin gate (real code)', () => {
  let extractDir: string;

  beforeEach(async () => {
    // Real temp dir holding a single .html page that carries the embed; the
    // method reads it from disk via fs.readFile.
    extractDir = await fs.mkdtemp(path.join(os.tmpdir(), 'html-embed-import-'));
    await fs.writeFile(path.join(extractDir, 'page.html'), HTML_WITH_EMBED);
  });

  afterEach(async () => {
    await fs.rm(extractDir, { recursive: true, force: true });
  });

  // Run processGenericImport over the temp dir and return the content persisted
  // for the imported page (captured at trx.insertInto('pages').values(...)).
  async function persistedContent(
    featureEnabled: boolean,
    user: { role?: string } | undefined,
  ) {
    const captured: any[] = [];
    const trxInsertChain = (table: string) => ({
      values: (row: any) => {
        if (table === 'pages') captured.push(row);
        return { execute: async () => undefined };
      },
    });
    const trx: any = { insertInto: trxInsertChain };
    const db: any = {
      // spaces lookup at the top of processGenericImport
      selectFrom: () => ({
        select: () => ({
          where: () => ({ executeTakeFirst: async () => ({ slug: 'sp' }) }),
        }),
      }),
      // executeTx -> db.transaction().execute(cb)
      transaction: () => ({ execute: async (cb: any) => cb(trx) }),
    };

    // importService stub: only the real, gate-relevant helpers are used. We give
    // it the REAL implementations by delegating to a real ImportService for
    // processHTML/extractTitleAndRemoveHeading/createYdoc so the embed parse and
    // strip path runs for real.
    const realImport = new ImportService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const importService: any = {
      processHTML: (html: string) => realImport.processHTML(html),
      extractTitleAndRemoveHeading: (s: any) =>
        realImport.extractTitleAndRemoveHeading(s),
      createYdoc: (j: any) => realImport.createYdoc(j),
    };

    const importAttachmentService: any = {
      // passthrough: no attachment rewriting, return html unchanged
      processAttachments: jest.fn(async (opts: any) => opts.html),
    };

    const service = new FileImportTaskService(
      { putBuffer: jest.fn() } as any, // storageService
      importService,
      { nextPagePosition: jest.fn(async () => 'a0') } as any, // pageService (position only)
      { insertBacklink: jest.fn() } as any, // backlinkRepo
      db,
      importAttachmentService,
      userRepoFor(user) as any,
      workspaceRepoFor(featureEnabled) as any,
      { emit: jest.fn() } as any, // eventEmitter
      { logBatchWithContext: jest.fn() } as any, // auditService
    );

    const fileTask: any = {
      id: 'task-1',
      creatorId: USER,
      workspaceId: WS,
      spaceId: SPACE,
      source: 'generic',
    };

    await service.processGenericImport({ extractDir, fileTask });
    expect(captured.length).toBeGreaterThanOrEqual(1);
    return captured[0].content;
  }

  it('toggle ON + member: persisted page has htmlEmbed stripped', async () => {
    const content = await persistedContent(true, { role: 'member' });
    expect(hasHtmlEmbedNode(content)).toBe(false);
    expect(JSON.stringify(content)).toContain('imported body');
  });

  it('toggle ON + missing user (creatorId resolves to undefined): fails closed', async () => {
    expect(hasHtmlEmbedNode(await persistedContent(true, undefined))).toBe(
      false,
    );
  });

  it('toggle ON + admin: persisted page keeps the htmlEmbed', async () => {
    expect(hasHtmlEmbedNode(await persistedContent(true, { role: 'admin' }))).toBe(
      true,
    );
  });

  it('toggle ON + owner: persisted page keeps the htmlEmbed', async () => {
    expect(hasHtmlEmbedNode(await persistedContent(true, { role: 'owner' }))).toBe(
      true,
    );
  });

  it('toggle OFF + admin: stripped (feature disabled for everyone)', async () => {
    expect(
      hasHtmlEmbedNode(await persistedContent(false, { role: 'admin' })),
    ).toBe(false);
  });
});
