// Exercises the REAL PageService htmlEmbed admin gate on its two non-collab
// write paths: PageService.create() and PageService.duplicatePage(). Both build
// content/textContent/ydoc directly and persist, bypassing the collab
// onStoreDocument strip, so each must run the incoming document through the
// toggle-AND-admin gate (`htmlEmbedAllowed(featureEnabled, role)` -> if not
// allowed, `stripHtmlEmbedNodes`) BEFORE persisting.
//
// This spec constructs the REAL PageService with every constructor dep mocked,
// feeds content containing an `htmlEmbed`, calls the real method, and asserts on
// the PERSISTED content (captured at the repo insert / db insert boundary) that
// the embed was actually stripped (member/unknown role) or preserved
// (admin/owner + toggle ON). Mirrors the GOOD pattern in
// transclusion/spec/transclusion-unsync-html-embed.spec.ts.
//
// page.service.ts pulls in the collaboration gateway (a transitive ESM chain
// `lib0/decoding.js` that jest's transformIgnorePatterns does not transpile), so
// that single module is mocked away — it is never used on the create/duplicate
// gate paths.
jest.mock('../../../collaboration/collaboration.gateway', () => ({
  CollaborationGateway: class {},
}));

import { PageService } from './page.service';
import { hasHtmlEmbedNode } from '../../../common/helpers/prosemirror/html-embed.util';

const WS = 'ws-1';
const SPACE = 'space-1';
const USER = 'u1';

const docWithEmbed = () => ({
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'body' }] },
    { type: 'htmlEmbed', attrs: { source: '<script>alert(1)</script>' } },
  ],
});

// Minimal chainable kysely stub. `nextPagePosition` (used by create) and
// duplicatePage's bulk insert go through `this.db`; only the calls those paths
// make need to resolve. `capturedInserts` collects every page row handed to
// `insertInto('pages').values(...)` so we can assert on the persisted content.
function buildDb(capturedInserts: any[]) {
  const selectChain: any = {
    select: () => selectChain,
    selectAll: () => selectChain,
    where: () => selectChain,
    orderBy: () => selectChain,
    limit: () => selectChain,
    execute: async () => [],
    executeTakeFirst: async () => undefined,
  };
  const db: any = {
    selectFrom: () => selectChain,
    insertInto: (table: string) => ({
      values: (rows: any) => {
        if (table === 'pages') {
          for (const row of Array.isArray(rows) ? rows : [rows]) {
            capturedInserts.push(row);
          }
        }
        return { execute: async () => undefined };
      },
    }),
    // executeTx -> db.transaction().execute(cb): run the callback with `db`
    // itself acting as the transaction so any in-tx inserts are captured too.
    transaction: () => ({ execute: async (cb: any) => cb(db) }),
  };
  return db;
}

// Build the REAL PageService with all 13 constructor deps mocked. `featureEnabled`
// drives the workspace toggle the gate reads via workspaceRepo.findById.
function buildService(opts: {
  featureEnabled: boolean;
  capturedInserts: any[];
  rootPage?: any; // for duplicatePage
}) {
  const { featureEnabled, capturedInserts } = opts;

  const pageRepo: any = {
    findById: jest.fn(async () => null), // no parent page in create tests
    // create() persists here; capture the row so we can inspect content.
    insertPage: jest.fn(async (row: any) => {
      capturedInserts.push(row);
      return { id: 'new-page', slugId: 'slug-1', ...row };
    }),
    getPageAndDescendants: jest.fn(async () => [opts.rootPage].filter(Boolean)),
  };

  const pagePermissionRepo: any = {
    // duplicatePage filters accessible pages; grant the root so it is copied.
    filterAccessiblePageIds: jest.fn(async () =>
      opts.rootPage ? [opts.rootPage.id] : [],
    ),
  };

  const workspaceRepo: any = {
    findById: jest.fn(async () => ({
      id: WS,
      settings: { htmlEmbed: featureEnabled },
    })),
  };

  const attachmentRepo: any = { findByIds: jest.fn(async () => []) };
  const storageService: any = { copy: jest.fn(async () => undefined) };
  const noopQueue: any = { add: jest.fn(async () => undefined) };
  const eventEmitter: any = { emit: jest.fn() };
  const collaborationGateway: any = {};
  const watcherService: any = {};
  // duplicatePage fires transclusion bulk inserts after persisting; they are
  // best-effort (wrapped in try/catch) and irrelevant to the gate.
  const transclusionService: any = {
    insertTransclusionsForPages: jest.fn(async () => undefined),
    insertReferencesForPages: jest.fn(async () => undefined),
    insertTemplateReferencesForPages: jest.fn(async () => undefined),
  };

  const db = buildDb(capturedInserts);

  const service = new PageService(
    pageRepo,
    pagePermissionRepo,
    attachmentRepo,
    db,
    storageService,
    noopQueue, // attachmentQueue
    noopQueue, // aiQueue
    noopQueue, // generalQueue
    eventEmitter,
    collaborationGateway,
    watcherService,
    transclusionService,
    workspaceRepo,
  );
  return service;
}

describe('PageService.create htmlEmbed admin gate (real code)', () => {
  // Run create() and return the content actually persisted via insertPage.
  async function persistedContent(
    featureEnabled: boolean,
    callerRole: string | null | undefined,
  ) {
    const capturedInserts: any[] = [];
    const service = buildService({ featureEnabled, capturedInserts });
    await service.create(
      USER,
      WS,
      {
        spaceId: SPACE,
        title: 'p',
        // 'json' format is used as-is by parseProsemirrorContent (passed to the
        // real jsonToNode schema validation), so hand it the PM-JSON object.
        content: docWithEmbed(),
        format: 'json' as any,
      } as any,
      callerRole,
    );
    expect(capturedInserts).toHaveLength(1);
    return capturedInserts[0].content;
  }

  it('toggle ON + member: persisted content has htmlEmbed stripped', async () => {
    const content = await persistedContent(true, 'member');
    expect(hasHtmlEmbedNode(content)).toBe(false);
    // Non-embed content survives.
    expect(JSON.stringify(content)).toContain('body');
  });

  it('toggle ON + admin: persisted content keeps the htmlEmbed', async () => {
    expect(hasHtmlEmbedNode(await persistedContent(true, 'admin'))).toBe(true);
  });

  it('toggle ON + owner: persisted content keeps the htmlEmbed', async () => {
    expect(hasHtmlEmbedNode(await persistedContent(true, 'owner'))).toBe(true);
  });

  it('toggle OFF + admin: stripped (feature disabled for everyone)', async () => {
    expect(hasHtmlEmbedNode(await persistedContent(false, 'admin'))).toBe(false);
  });

  it('unknown/empty role: fails closed (stripped)', async () => {
    for (const role of [undefined, null, 'viewer'] as const) {
      expect(hasHtmlEmbedNode(await persistedContent(true, role))).toBe(false);
    }
  });
});

describe('PageService.duplicatePage htmlEmbed admin gate (real code)', () => {
  // Duplicate a single source page that contains an embed and return the content
  // persisted for the copy (captured at db.insertInto('pages').values(...)).
  async function persistedContent(
    featureEnabled: boolean,
    role: string | null | undefined,
  ) {
    const rootPage: any = {
      id: 'src-page',
      slugId: 'src-slug',
      title: 'Source',
      icon: null,
      position: 'a0',
      spaceId: SPACE,
      workspaceId: WS,
      parentPageId: null,
      content: docWithEmbed(),
    };
    const capturedInserts: any[] = [];
    const service = buildService({ featureEnabled, capturedInserts, rootPage });
    const authUser: any = { id: USER, workspaceId: WS, role };
    await service.duplicatePage(rootPage, undefined, authUser);
    // The bulk insert is the page persist boundary; one source page -> one copy.
    const pageRows = capturedInserts.filter((r) => r.content);
    expect(pageRows.length).toBeGreaterThanOrEqual(1);
    return pageRows[0].content;
  }

  it('toggle ON + member: persisted copy has htmlEmbed stripped', async () => {
    const content = await persistedContent(true, 'member');
    expect(hasHtmlEmbedNode(content)).toBe(false);
    expect(JSON.stringify(content)).toContain('body');
  });

  it('toggle ON + admin: persisted copy keeps the htmlEmbed', async () => {
    expect(hasHtmlEmbedNode(await persistedContent(true, 'admin'))).toBe(true);
  });

  it('toggle ON + owner: persisted copy keeps the htmlEmbed', async () => {
    expect(hasHtmlEmbedNode(await persistedContent(true, 'owner'))).toBe(true);
  });

  it('toggle OFF + admin: stripped (feature disabled for everyone)', async () => {
    expect(hasHtmlEmbedNode(await persistedContent(false, 'admin'))).toBe(false);
  });

  it('unknown/empty role: fails closed (stripped)', async () => {
    for (const role of [undefined, null, 'viewer'] as const) {
      expect(hasHtmlEmbedNode(await persistedContent(true, role))).toBe(false);
    }
  });
});
