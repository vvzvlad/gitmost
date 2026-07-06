// Stub collaboration.util so importing the extension does not drag in the
// editor-ext -> @tiptap/react -> react-dom graph (unloadable under jest's node
// env, same coupling the gitmost-datasource / mcp specs document). The
// extension only calls getPageId, jsonToText and isEmptyParagraphDoc from it on
// the store path; tiptapExtensions is unused by onStoreDocument.
jest.mock('../collaboration.util', () => ({
  tiptapExtensions: [],
  getPageId: (name: string) => name.replace(/^page\./, ''),
  jsonToText: () => 'text',
  isEmptyParagraphDoc: () => false,
  // The post-write mention extraction walks the doc via jsonToNode().descendants;
  // return a node-like stub with no descendants so no mentions are produced
  // (mention handling is out of scope here — we only assert provenance).
  jsonToNode: () => ({ descendants: () => undefined }),
}));

// Control the Yjs<->JSON bridge: fromYdoc returns the "incoming" doc the writer
// is storing. We keep it distinct from the page's persisted content so the
// no-op guard (isDeepStrictEqual) never short-circuits the write.
const INCOMING_JSON = { type: 'doc', content: [{ type: 'paragraph' }, { t: 1 }] };
jest.mock('@hocuspocus/transformer', () => ({
  TiptapTransformer: {
    fromYdoc: jest.fn(() => INCOMING_JSON),
    toYdoc: jest.fn(),
  },
}));

// Run the executeTx callback inline with a passthrough trx.
jest.mock('@docmost/db/utils', () => ({
  executeTx: jest.fn(async (_db: any, cb: any) => cb({} as any)),
}));

import * as Y from 'yjs';
import { PersistenceExtension } from './persistence.extension';
import {
  onChangePayload,
  onStoreDocumentPayload,
} from '@hocuspocus/server';

/**
 * Provenance-precedence coverage for PersistenceExtension.onStoreDocument
 * (test-strategy Module 4 / item #2): the contract `agent > git-sync > user`,
 * plus the negative that a git-sync store does NOT pin a boundary history
 * snapshot. We drive the precedence through the real public method (onChange to
 * arm the sticky agent marker, then onStoreDocument), mocking the repos / db /
 * Yjs bridge so no real database or collab server is needed. The store's
 * persisted `lastUpdatedSource` and the saveHistory call are the observable
 * outputs.
 */
describe('PersistenceExtension.onStoreDocument — provenance precedence (#2)', () => {
  const DOCUMENT_NAME = 'page.page-1';
  const PAGE_ID = 'page-1';

  // `page.content` differs from INCOMING_JSON so the write is never skipped.
  const persistedPage = (overrides?: { lastUpdatedSource?: string }) => ({
    id: PAGE_ID,
    slugId: 'slug-1',
    spaceId: 'space-1',
    workspaceId: 'ws-1',
    creatorId: 'creator-1',
    contributorIds: ['creator-1'],
    content: { type: 'doc', content: [{ type: 'paragraph', content: [] }] },
    lastUpdatedSource: overrides?.lastUpdatedSource ?? 'user',
    createdAt: new Date(),
  });

  const build = (pageOverrides?: { lastUpdatedSource?: string }) => {
    const pageRepo = {
      findById: jest.fn().mockResolvedValue(persistedPage(pageOverrides)),
      updatePage: jest.fn().mockResolvedValue({ numUpdatedRows: 1n }),
    };
    const pageHistoryRepo = {
      // No prior snapshot -> humanBaselineMissing is true, so the ONLY thing
      // gating the boundary snapshot in these tests is the source precedence.
      findPageLastHistory: jest.fn().mockResolvedValue(null),
      saveHistory: jest.fn().mockResolvedValue(undefined),
    };
    const aiQueue = { add: jest.fn().mockResolvedValue(undefined) };
    const historyQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      // develop's trailing-idle-flush (#370) removes the pending debounced job
      // before re-adding; the enqueue path calls historyQueue.remove(jobId).catch().
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const notificationQueue = { add: jest.fn().mockResolvedValue(undefined) };
    const collabHistory = {
      addContributors: jest.fn().mockResolvedValue(undefined),
    };
    const transclusionService = {
      syncPageTransclusions: jest.fn().mockResolvedValue(undefined),
      syncPageReferences: jest.fn().mockResolvedValue(undefined),
      syncPageTemplateReferences: jest.fn().mockResolvedValue(undefined),
    };

    const ext = new PersistenceExtension(
      pageRepo as any,
      pageHistoryRepo as any,
      {} as any, // db
      aiQueue as any,
      historyQueue as any,
      notificationQueue as any,
      collabHistory as any,
      transclusionService as any,
    );

    return { ext, pageRepo, pageHistoryRepo, historyQueue };
  };

  // A real Y.Doc is required for Y.encodeStateAsUpdate(document); broadcastStateless
  // is a no-op spy. The fromYdoc bridge is mocked, so the doc's contents are
  // irrelevant to the JSON path.
  const makeStorePayload = (context: any): onStoreDocumentPayload =>
    ({
      documentName: DOCUMENT_NAME,
      document: Object.assign(new Y.Doc(), {
        broadcastStateless: jest.fn(),
      }),
      context,
    }) as any;

  const makeChangePayload = (actor: string): onChangePayload =>
    ({
      documentName: DOCUMENT_NAME,
      context: { user: { id: 'user-1' }, actor },
    }) as any;

  const sourceOf = (pageRepo: { updatePage: jest.Mock }) =>
    pageRepo.updatePage.mock.calls[0][0].lastUpdatedSource;

  it("tags 'user' for a plain write (no agent touch, no git-sync actor)", async () => {
    const { ext, pageRepo } = build();

    await ext.onStoreDocument(
      makeStorePayload({ user: { id: 'user-1' }, actor: 'user' }),
    );

    expect(sourceOf(pageRepo)).toBe('user');
  });

  it("tags 'git-sync' when the writer's actor is 'git-sync' and no agent touched the window", async () => {
    const { ext, pageRepo } = build();

    await ext.onStoreDocument(
      makeStorePayload({ user: { id: 'svc-user' }, actor: 'git-sync' }),
    );

    expect(sourceOf(pageRepo)).toBe('git-sync');
  });

  it("keeps 'git-sync' for an explicit git-sync store even with a sticky agent marker (#14 loop-guard)", async () => {
    const { ext, pageRepo } = build();

    // An agent edit landed earlier in the coalescing window (sticky marker),
    // then a git-sync writer performs the store. Red-team finding #14: an
    // EXPLICIT current-write actor is authoritative for THIS write, so the
    // store must stay 'git-sync' — otherwise the PageChangeListener loop-guard
    // (keyed on lastUpdatedSource === 'git-sync') fails to recognize git-sync's
    // own write and re-exports it. Explicit 'agent' still wins (see below); the
    // sticky marker only promotes a plain human writer to 'agent'.
    await ext.onChange(makeChangePayload('agent'));
    await ext.onStoreDocument(
      makeStorePayload({ user: { id: 'svc-user' }, actor: 'git-sync' }),
    );

    expect(sourceOf(pageRepo)).toBe('git-sync');
  });

  it("tags 'agent' when the storing writer itself is the agent (no prior onChange)", async () => {
    const { ext, pageRepo } = build();

    await ext.onStoreDocument(
      makeStorePayload({ user: { id: 'agent-user' }, actor: 'agent' }),
    );

    expect(sourceOf(pageRepo)).toBe('agent');
  });

  // --- boundary snapshot for a git-sync store over a HUMAN baseline -----------
  // SPEC §9 observable-loss guard (bug #2): a git-sync body write is a block-level
  // 3-way merge whose same-block rule is "git wins". To keep a concurrent human
  // edit RECOVERABLE rather than silently overwritten, a git-sync store over a
  // prior NON-git-sync baseline pins that prior state to page history first —
  // exactly like the agent path. So saveHistory MUST be called here.
  it('DOES pin a boundary snapshot for a git-sync store over a prior human state', async () => {
    const { ext, pageHistoryRepo } = build({ lastUpdatedSource: 'user' });

    await ext.onStoreDocument(
      makeStorePayload({ user: { id: 'svc-user' }, actor: 'git-sync' }),
    );

    expect(pageHistoryRepo.saveHistory).toHaveBeenCalledTimes(1);
  });

  // --- negative: a git-sync store over a git-sync baseline does NOT re-pin -----
  // The boundary is pinned once on the transition INTO git-sync; a subsequent
  // git-sync store over an already-git-sync baseline must not churn history.
  it('does NOT re-pin a boundary snapshot for a git-sync store over a git-sync baseline', async () => {
    const { ext, pageHistoryRepo } = build({ lastUpdatedSource: 'git-sync' });

    await ext.onStoreDocument(
      makeStorePayload({ user: { id: 'svc-user' }, actor: 'git-sync' }),
    );

    expect(pageHistoryRepo.saveHistory).not.toHaveBeenCalled();
  });

  it('DOES pin a boundary snapshot for an agent store over a prior human state (control)', async () => {
    // Confirms the negative above is meaningful: under the SAME mocks, an agent
    // store over a 'user' baseline DOES trigger the boundary snapshot.
    const { ext, pageHistoryRepo } = build({ lastUpdatedSource: 'user' });

    await ext.onStoreDocument(
      makeStorePayload({ user: { id: 'agent-user' }, actor: 'agent' }),
    );

    expect(pageHistoryRepo.saveHistory).toHaveBeenCalledTimes(1);
  });

  it('does NOT pin a boundary snapshot for a plain user store', async () => {
    const { ext, pageHistoryRepo } = build({ lastUpdatedSource: 'user' });

    await ext.onStoreDocument(
      makeStorePayload({ user: { id: 'user-1' }, actor: 'user' }),
    );

    expect(pageHistoryRepo.saveHistory).not.toHaveBeenCalled();
  });
});
