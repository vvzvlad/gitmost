import { TiptapTransformer } from '@hocuspocus/transformer';
import { PersistenceExtension } from './persistence.extension';
import { tiptapExtensions } from '../collaboration.util';

/**
 * Integration test for `onStoreDocument`'s Approach-A boundary snapshot.
 *
 * The data-loss risk: when an AGENT store lands over a page whose persisted
 * state was authored by a HUMAN, the agent overwrites that human content. If we
 * do not pin the human revision as its own history version BEFORE the agent's
 * updatePage, the last human edit is lost. This test pins the ordering
 * (saveHistory(oldHumanPage) strictly before updatePage) and the idempotency
 * skip when content is unchanged.
 *
 * We pass a REAL Y.Doc as the `document` arg (so TiptapTransformer.fromYdoc
 * yields real content) and stub repos/queues + an executeTx-compatible db whose
 * transaction().execute() invokes the callback with a trx stub.
 */

const PAGE_ID = '550e8400-e29b-41d4-a716-446655440000';
const USER_ID = 'human-1';

// Build a real Y.Doc carrying the given tiptap JSON in the 'default' fragment.
// hocuspocus augments the live document with broadcastStateless(); the bare
// Y.Doc lacks it, so stub it for the post-store broadcast.
const ydocFor = (json: any) => {
  const ydoc = TiptapTransformer.toYdoc(json, 'default', tiptapExtensions);
  (ydoc as any).broadcastStateless = jest.fn();
  return ydoc;
};

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

describe('PersistenceExtension.onStoreDocument — Approach-A boundary snapshot', () => {
  let ext: PersistenceExtension;
  let pageRepo: { findById: jest.Mock; updatePage: jest.Mock };
  let pageHistoryRepo: {
    saveHistory: jest.Mock;
    findPageLastHistory: jest.Mock;
  };
  let aiQueue: { add: jest.Mock };
  let historyQueue: { add: jest.Mock };
  let notificationQueue: { add: jest.Mock };
  let collabHistory: { addContributors: jest.Mock };
  let transclusionService: {
    syncPageTransclusions: jest.Mock;
    syncPageReferences: jest.Mock;
    syncPageTemplateReferences: jest.Mock;
  };
  let callOrder: string[];

  // db whose transaction().execute(fn) runs fn with a trx stub — this lets the
  // real executeTx() helper drive the callback without a database.
  const trxStub = { __trx: true };
  const db = {
    transaction: () => ({
      execute: (fn: (trx: any) => Promise<any>) => fn(trxStub),
    }),
  };

  // The persisted page row the transaction reads (OLD, human-authored state).
  const persistedHumanPage = (newAgentText: string) => ({
    id: PAGE_ID,
    slugId: 'slug-1',
    spaceId: 'space-1',
    workspaceId: 'ws-1',
    creatorId: 'creator-1',
    contributorIds: ['creator-1'],
    createdAt: new Date('2020-01-01T00:00:00Z'),
    lastUpdatedSource: 'user', // prior revision was human
    // content differs from the new agent doc so the update branch runs.
    content: doc('OLD HUMAN'),
    _newAgentText: newAgentText,
  });

  const buildData = (document: any, actor: 'user' | 'agent') => ({
    documentName: `page.${PAGE_ID}`,
    document,
    context: { user: { id: USER_ID, name: 'Alice' }, actor },
  });

  beforeEach(() => {
    callOrder = [];
    pageRepo = {
      findById: jest.fn(),
      updatePage: jest.fn().mockImplementation(async () => {
        callOrder.push('updatePage');
      }),
    };
    pageHistoryRepo = {
      saveHistory: jest.fn().mockImplementation(async () => {
        callOrder.push('saveHistory');
      }),
      findPageLastHistory: jest.fn().mockResolvedValue(null),
    };
    aiQueue = { add: jest.fn().mockResolvedValue(undefined) };
    historyQueue = { add: jest.fn().mockResolvedValue(undefined) };
    notificationQueue = { add: jest.fn().mockResolvedValue(undefined) };
    collabHistory = { addContributors: jest.fn().mockResolvedValue(undefined) };
    transclusionService = {
      syncPageTransclusions: jest.fn().mockResolvedValue(undefined),
      syncPageReferences: jest.fn().mockResolvedValue(undefined),
      syncPageTemplateReferences: jest.fn().mockResolvedValue(undefined),
    };

    ext = new PersistenceExtension(
      pageRepo as any,
      pageHistoryRepo as any,
      db as any,
      aiQueue as any,
      historyQueue as any,
      notificationQueue as any,
      collabHistory as any,
      transclusionService as any,
    );
    jest.spyOn(ext['logger'], 'debug').mockImplementation(() => undefined);
    jest.spyOn(ext['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(ext['logger'], 'error').mockImplementation(() => undefined);
  });

  it('agent store over a human page pins saveHistory(oldHumanPage) BEFORE updatePage', async () => {
    const document = ydocFor(doc('NEW AGENT CONTENT'));
    pageRepo.findById.mockResolvedValue(persistedHumanPage('NEW AGENT CONTENT'));
    // No human baseline snapshot exists yet → boundary snapshot must run.
    pageHistoryRepo.findPageLastHistory.mockResolvedValue(null);

    await ext.onStoreDocument(buildData(document, 'agent') as any);

    // Boundary snapshot fired, and strictly before the agent overwrite.
    expect(pageHistoryRepo.saveHistory).toHaveBeenCalledTimes(1);
    const saved = pageHistoryRepo.saveHistory.mock.calls[0][0];
    expect(saved.content).toEqual(doc('OLD HUMAN')); // the OLD human revision
    expect(callOrder).toEqual(['saveHistory', 'updatePage']);

    // The agent's new content is tagged 'agent' on the update.
    const update = pageRepo.updatePage.mock.calls[0][0];
    expect(update.lastUpdatedSource).toBe('agent');
  });

  it('skips the boundary snapshot when the human baseline is already pinned', async () => {
    const document = ydocFor(doc('NEW AGENT CONTENT'));
    pageRepo.findById.mockResolvedValue(persistedHumanPage('NEW AGENT CONTENT'));
    // Latest history already equals the current human state → no duplicate.
    pageHistoryRepo.findPageLastHistory.mockResolvedValue({
      content: doc('OLD HUMAN'),
    });

    await ext.onStoreDocument(buildData(document, 'agent') as any);

    expect(pageHistoryRepo.saveHistory).not.toHaveBeenCalled();
    expect(pageRepo.updatePage).toHaveBeenCalledTimes(1);
  });

  it('human store does NOT trigger the boundary snapshot (no source transition)', async () => {
    const document = ydocFor(doc('NEW HUMAN CONTENT'));
    pageRepo.findById.mockResolvedValue(persistedHumanPage('NEW HUMAN CONTENT'));

    await ext.onStoreDocument(buildData(document, 'user') as any);

    expect(pageHistoryRepo.saveHistory).not.toHaveBeenCalled();
    expect(pageRepo.updatePage).toHaveBeenCalledTimes(1);
    expect(pageRepo.updatePage.mock.calls[0][0].lastUpdatedSource).toBe('user');
  });

  it('idempotency: unchanged content → no updatePage, no history, no queues', async () => {
    // The Y.Doc content equals the persisted content deeply → early skip.
    // A Y.Doc round-trip normalizes attrs (e.g. paragraph indent), so derive
    // the persisted content from fromYdoc to make the deep-equal skip genuine.
    const document = ydocFor(doc('SAME CONTENT'));
    const normalized = TiptapTransformer.fromYdoc(document, 'default');
    pageRepo.findById.mockResolvedValue({
      ...persistedHumanPage('SAME CONTENT'),
      content: normalized,
    });

    await ext.onStoreDocument(buildData(document, 'agent') as any);

    expect(pageRepo.updatePage).not.toHaveBeenCalled();
    expect(pageHistoryRepo.saveHistory).not.toHaveBeenCalled();
    expect(historyQueue.add).not.toHaveBeenCalled();
  });

  // persist-1 — a transient DB failure during store must not silently lose the
  // edit. hocuspocus unloads (destroys) the in-memory Y.Doc right after this
  // hook resolves, so the store has to retry while it still holds the only copy.
  it('retries a transient DB failure and still persists the edit (persist-1)', async () => {
    const document = ydocFor(doc('NEW HUMAN CONTENT'));
    pageRepo.findById.mockResolvedValue(persistedHumanPage('NEW HUMAN CONTENT'));
    let attempts = 0;
    pageRepo.updatePage.mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('deadlock detected'); // transient
      callOrder.push('updatePage');
    });

    await ext.onStoreDocument(buildData(document, 'user') as any);

    // First attempt failed and rolled back; the retry persisted the edit.
    expect(pageRepo.updatePage).toHaveBeenCalledTimes(2);
    // The edit WAS saved, so the post-store success path runs as normal.
    expect((document as any).broadcastStateless).toHaveBeenCalledTimes(1);
    expect(historyQueue.add).toHaveBeenCalledTimes(1);
  });

  // #206 persist-6 / #248 — a momentarily-empty live Y.Doc must not overwrite
  // non-empty persisted content. The store-side empty-guard blocks an empty doc
  // (a client/agent glitch, a bad merge, an emptying transclusion) from wiping
  // the page silently when NO intentional-clear signal is present.
  it('does NOT overwrite non-empty content with a momentarily-empty live doc (persist-6)', async () => {
    const emptyDoc = { type: 'doc', content: [{ type: 'paragraph' }] };
    const document = ydocFor(emptyDoc);
    pageRepo.findById.mockResolvedValue({
      ...persistedHumanPage('IGNORED'),
      content: doc('IMPORTANT RICH CONTENT'),
    });

    await ext.onStoreDocument(buildData(document, 'user') as any);

    // The empty incoming doc is rejected and the rich page survives.
    expect(pageRepo.updatePage).not.toHaveBeenCalled();
  });

  // #248 — an empty-over-empty store is allowed (nothing to lose); the guard
  // only protects non-empty persisted content.
  it('allows an empty store over already-empty content (#248)', async () => {
    const liveEmptyDoc = { type: 'doc', content: [{ type: 'paragraph' }] };
    const document = ydocFor(liveEmptyDoc);
    // Stored content is empty per isEmptyParagraphDoc (paragraph with content:[])
    // but NOT deep-equal to the normalized live doc, so the unchanged
    // short-circuit is skipped and the empty-guard is genuinely reached.
    pageRepo.findById.mockResolvedValue({
      ...persistedHumanPage('IGNORED'),
      content: { type: 'doc', content: [{ type: 'paragraph', content: [] }] },
    });

    await ext.onStoreDocument(buildData(document, 'user') as any);

    expect(pageRepo.updatePage).toHaveBeenCalledTimes(1);
  });

  // #251 — REAL-PATH regression test. The intentional-clear signal is set via
  // the actual transport seam (ext.onStateless with the exact stateless payload
  // the client's IntentionalClear extension sends), NOT a hand-injected
  // context.intentionalClear poke. We then run the debounced store with an empty
  // live doc over non-empty persisted content and assert the empty write goes
  // through — i.e. the clear persists.
  it('persists an intentional clear signalled via the real stateless transport (#251)', async () => {
    const documentName = `page.${PAGE_ID}`;
    const emptyDoc = { type: 'doc', content: [{ type: 'paragraph' }] };
    const document = ydocFor(emptyDoc);
    pageRepo.findById.mockResolvedValue({
      ...persistedHumanPage('IGNORED'),
      content: doc('IMPORTANT RICH CONTENT'),
    });

    // The client signalled a deliberate clear over the live connection.
    await ext.onStateless({
      connection: { readOnly: false } as any,
      documentName,
      document: document as any,
      payload: JSON.stringify({ type: 'intentional-clear' }),
    } as any);

    await ext.onStoreDocument(buildData(document, 'user') as any);

    // The empty doc was written (the clear persisted). The persisted content is
    // the Y.Doc round-trip of the empty doc (attrs normalized), so compare
    // against fromYdoc rather than the raw literal.
    expect(pageRepo.updatePage).toHaveBeenCalledTimes(1);
    const expectedEmpty = TiptapTransformer.fromYdoc(document, 'default');
    expect(pageRepo.updatePage.mock.calls[0][0].content).toEqual(expectedEmpty);
  });

  // #251 — the signal is single-use: it is consumed by the first empty store,
  // so a SECOND accidental empty (no fresh signal) is still blocked.
  it('consumes the intentional-clear signal once; a later empty is blocked (#251)', async () => {
    const documentName = `page.${PAGE_ID}`;
    const emptyDoc = { type: 'doc', content: [{ type: 'paragraph' }] };
    pageRepo.findById.mockResolvedValue({
      ...persistedHumanPage('IGNORED'),
      content: doc('IMPORTANT RICH CONTENT'),
    });

    await ext.onStateless({
      connection: { readOnly: false } as any,
      documentName,
      document: ydocFor(emptyDoc) as any,
      payload: JSON.stringify({ type: 'intentional-clear' }),
    } as any);

    // First empty store consumes the signal and writes.
    await ext.onStoreDocument(buildData(ydocFor(emptyDoc), 'user') as any);
    expect(pageRepo.updatePage).toHaveBeenCalledTimes(1);

    // Re-arm findById to non-empty (as if content came back) and fire another
    // empty store WITHOUT a new signal — the guard must block it.
    pageRepo.updatePage.mockClear();
    pageRepo.findById.mockResolvedValue({
      ...persistedHumanPage('IGNORED'),
      content: doc('IMPORTANT RICH CONTENT'),
    });
    await ext.onStoreDocument(buildData(ydocFor(emptyDoc), 'user') as any);
    expect(pageRepo.updatePage).not.toHaveBeenCalled();
  });

  // #251 — a read-only connection cannot arm the clear, so its empty store is
  // still blocked (defends the guard against a read-only spoof).
  it('ignores an intentional-clear signal from a read-only connection (#251)', async () => {
    const documentName = `page.${PAGE_ID}`;
    const emptyDoc = { type: 'doc', content: [{ type: 'paragraph' }] };
    const document = ydocFor(emptyDoc);
    pageRepo.findById.mockResolvedValue({
      ...persistedHumanPage('IGNORED'),
      content: doc('IMPORTANT RICH CONTENT'),
    });

    await ext.onStateless({
      connection: { readOnly: true } as any,
      documentName,
      document: document as any,
      payload: JSON.stringify({ type: 'intentional-clear' }),
    } as any);

    await ext.onStoreDocument(buildData(document, 'user') as any);

    expect(pageRepo.updatePage).not.toHaveBeenCalled();
  });

  // #251 — a non-empty store between the signal and the empty store drops the
  // pending flag ("cleared then retyped" can't leave a usable signal behind).
  it('drops a pending clear when a non-empty store intervenes (#251)', async () => {
    const documentName = `page.${PAGE_ID}`;
    const emptyDoc = { type: 'doc', content: [{ type: 'paragraph' }] };

    await ext.onStateless({
      connection: { readOnly: false } as any,
      documentName,
      document: ydocFor(emptyDoc) as any,
      payload: JSON.stringify({ type: 'intentional-clear' }),
    } as any);

    // A non-empty store lands first → consumes/drops the stale flag.
    pageRepo.findById.mockResolvedValue(persistedHumanPage('NEW HUMAN TEXT'));
    await ext.onStoreDocument(
      buildData(ydocFor(doc('NEW HUMAN TEXT')), 'user') as any,
    );
    pageRepo.updatePage.mockClear();

    // Now an empty store with no fresh signal must be blocked.
    pageRepo.findById.mockResolvedValue({
      ...persistedHumanPage('IGNORED'),
      content: doc('IMPORTANT RICH CONTENT'),
    });
    await ext.onStoreDocument(buildData(ydocFor(emptyDoc), 'user') as any);
    expect(pageRepo.updatePage).not.toHaveBeenCalled();
  });

  // persist-1 — when every attempt fails the hook must NOT report a phantom
  // success: no "page.updated" badge broadcast and no history snapshot for
  // content that was never written.
  it('does not run post-store side effects when every store attempt fails (persist-1)', async () => {
    const document = ydocFor(doc('NEW HUMAN CONTENT'));
    pageRepo.findById.mockResolvedValue(persistedHumanPage('NEW HUMAN CONTENT'));
    pageRepo.updatePage.mockRejectedValue(new Error('connection reset'));

    await expect(
      ext.onStoreDocument(buildData(document, 'user') as any),
    ).resolves.toBeUndefined();

    // Bounded retry exhausted (MAX_STORE_ATTEMPTS).
    expect(pageRepo.updatePage).toHaveBeenCalledTimes(3);
    // No false-success: nothing downstream fires for the unsaved content.
    expect((document as any).broadcastStateless).not.toHaveBeenCalled();
    expect(historyQueue.add).not.toHaveBeenCalled();
    expect(aiQueue.add).not.toHaveBeenCalled();
  });
});
