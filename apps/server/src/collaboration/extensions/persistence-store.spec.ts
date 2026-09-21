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
    updateHistoryKind: jest.Mock;
  };
  let aiQueue: { add: jest.Mock };
  let historyQueue: { add: jest.Mock; remove: jest.Mock };
  let notificationQueue: { add: jest.Mock };
  let collabHistory: { addContributors: jest.Mock; popContributors: jest.Mock };
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
        return { id: 'history-1' };
      }),
      findPageLastHistory: jest.fn().mockResolvedValue(null),
      updateHistoryKind: jest.fn().mockResolvedValue(undefined),
    };
    aiQueue = { add: jest.fn().mockResolvedValue(undefined) };
    historyQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      // #370 — enqueuePageHistory now removes any pending idle job before re-adding.
      remove: jest.fn().mockResolvedValue(undefined),
    };
    notificationQueue = { add: jest.fn().mockResolvedValue(undefined) };
    collabHistory = {
      addContributors: jest.fn().mockResolvedValue(undefined),
      popContributors: jest.fn().mockResolvedValue([]),
    };
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
    pageRepo.findById.mockResolvedValue(
      persistedHumanPage('NEW AGENT CONTENT'),
    );
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
    pageRepo.findById.mockResolvedValue(
      persistedHumanPage('NEW AGENT CONTENT'),
    );
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
    pageRepo.findById.mockResolvedValue(
      persistedHumanPage('NEW HUMAN CONTENT'),
    );

    await ext.onStoreDocument(buildData(document, 'user') as any);

    expect(pageHistoryRepo.saveHistory).not.toHaveBeenCalled();
    expect(pageRepo.updatePage).toHaveBeenCalledTimes(1);
    expect(pageRepo.updatePage.mock.calls[0][0].lastUpdatedSource).toBe('user');
  });

  // #370 review round-1 SUGGESTION: the boundary was GENERALIZED from a
  // user→agent special-case to ANY lastUpdatedSource transition. These pin the
  // generalized behaviour it was rebuilt for.
  describe('generalized boundary — any source transition', () => {
    // Same persisted page but with an explicit prior source.
    const pageWithPriorSource = (prior: string | null) => ({
      ...persistedHumanPage('NEW CONTENT'),
      lastUpdatedSource: prior,
    });

    it('agent→user transition fires the boundary (pins the prior agent revision)', async () => {
      const document = ydocFor(doc('NEW CONTENT'));
      pageRepo.findById.mockResolvedValue(pageWithPriorSource('agent'));
      pageHistoryRepo.findPageLastHistory.mockResolvedValue(null);

      await ext.onStoreDocument(buildData(document, 'user') as any);

      expect(pageHistoryRepo.saveHistory).toHaveBeenCalledTimes(1);
      expect(callOrder).toEqual(['saveHistory', 'updatePage']);
      expect(pageRepo.updatePage.mock.calls[0][0].lastUpdatedSource).toBe(
        'user',
      );
    });

    it('git→user transition fires the boundary (git-sync overwrite is a source change)', async () => {
      const document = ydocFor(doc('NEW CONTENT'));
      pageRepo.findById.mockResolvedValue(pageWithPriorSource('git'));
      pageHistoryRepo.findPageLastHistory.mockResolvedValue(null);

      await ext.onStoreDocument(buildData(document, 'user') as any);

      expect(pageHistoryRepo.saveHistory).toHaveBeenCalledTimes(1);
      expect(callOrder).toEqual(['saveHistory', 'updatePage']);
    });

    it('a null prior source (first-ever edit) does NOT fire the boundary', async () => {
      const document = ydocFor(doc('NEW CONTENT'));
      pageRepo.findById.mockResolvedValue(pageWithPriorSource(null));

      await ext.onStoreDocument(buildData(document, 'agent') as any);

      expect(pageHistoryRepo.saveHistory).not.toHaveBeenCalled();
      expect(pageRepo.updatePage).toHaveBeenCalledTimes(1);
    });
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
    pageRepo.findById.mockResolvedValue(
      persistedHumanPage('NEW HUMAN CONTENT'),
    );
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

  // #251 — retry correctness: a transient DB failure on the FIRST attempt must
  // not silently drop the clear. The intentional-clear flag is consumed ONCE
  // before the retry loop, so when attempt 1's updatePage throws (tx rolls back,
  // but the in-memory flag delete cannot roll back) the retry on attempt 2 still
  // sees the clear as allowed and writes the empty doc. On the pre-fix code
  // (consumeIntentionalClear called INSIDE the loop) attempt 1 consumed the flag,
  // attempt 2 re-read it as absent and the empty-guard BLOCKED the write — so
  // updatePage would be called once and the clear would be lost. This test fails
  // on that ordering and passes after the hoist.
  it('persists an intentional clear even when the first store attempt fails transiently (#251)', async () => {
    const documentName = `page.${PAGE_ID}`;
    const emptyDoc = { type: 'doc', content: [{ type: 'paragraph' }] };
    const document = ydocFor(emptyDoc);
    // The page stays non-empty in the DB across both attempts (the rolled-back
    // first attempt never changed it), exactly the failure scenario the WARNING
    // describes.
    pageRepo.findById.mockResolvedValue({
      ...persistedHumanPage('IGNORED'),
      content: doc('IMPORTANT RICH CONTENT'),
    });

    let attempts = 0;
    pageRepo.updatePage.mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('deadlock detected'); // transient
      callOrder.push('updatePage');
    });

    // The client signalled a deliberate clear over the live connection.
    await ext.onStateless({
      connection: { readOnly: false } as any,
      documentName,
      document: document as any,
      payload: JSON.stringify({ type: 'intentional-clear' }),
    } as any);

    await ext.onStoreDocument(buildData(document, 'user') as any);

    // First attempt failed and rolled back; the retry still honoured the clear
    // and wrote the empty doc (the clear survived the retry).
    expect(pageRepo.updatePage).toHaveBeenCalledTimes(2);
    const expectedEmpty = TiptapTransformer.fromYdoc(document, 'default');
    expect(pageRepo.updatePage.mock.calls[1][0].content).toEqual(expectedEmpty);
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
    pageRepo.findById.mockResolvedValue(
      persistedHumanPage('NEW HUMAN CONTENT'),
    );
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

  // #260 — when the collab doc name carries a SLUGID (`page.<slugId>`) the
  // post-store side effects must use the resolved page.id (a UUID), NOT the
  // slugId. The transclusion sync + embedding reindex write uuid-typed columns,
  // so a slugId there threw Postgres 22P02; the contributors key must also match
  // the PAGE_HISTORY job, which is enqueued with page.id.
  it('uses the canonical page.id (not the slugId doc name) for post-store side effects (#260)', async () => {
    const SLUG = 'slug-1'; // persistedHumanPage.slugId; findById resolves it
    const document = ydocFor(doc('NEW AGENT CONTENT'));
    // #348 — the transclusion sync now runs only when the new OR the previously
    // persisted content carries a transclusion-family node. Give the persisted
    // (old) content a pageEmbed so the sync path is exercised and the #260
    // UUID-vs-slugId contract asserted below is still verified.
    pageRepo.findById.mockResolvedValue({
      ...persistedHumanPage('NEW AGENT CONTENT'),
      content: {
        type: 'doc',
        content: [{ type: 'pageEmbed', attrs: { sourcePageId: 'src-1' } }],
      },
    });
    pageHistoryRepo.findPageLastHistory.mockResolvedValue(null);

    // A `page.<slugId>` document name (the bug's smoking gun), agent store over
    // a human page so the in-tx history-boundary read is also exercised.
    await ext.onStoreDocument({
      documentName: `page.${SLUG}`,
      document,
      context: { user: { id: USER_ID, name: 'Alice' }, actor: 'agent' },
    } as any);

    // findById was queried with the slugId (it resolves either id or slugId).
    expect(pageRepo.findById).toHaveBeenCalledWith(SLUG, expect.anything());

    // The in-tx history-boundary read uses the canonical UUID, never the slugId.
    expect(pageHistoryRepo.findPageLastHistory).toHaveBeenCalledWith(
      PAGE_ID,
      expect.anything(),
    );

    // Transclusion sync (uuid-typed columns) must receive the UUID.
    expect(transclusionService.syncPageTransclusions.mock.calls[0][0]).toBe(
      PAGE_ID,
    );
    expect(transclusionService.syncPageReferences.mock.calls[0][0]).toBe(
      PAGE_ID,
    );
    expect(
      transclusionService.syncPageTemplateReferences.mock.calls[0][0],
    ).toBe(PAGE_ID);

    // Embedding reindex job keyed by the UUID (slugId there threw 22P02).
    expect(aiQueue.add).toHaveBeenCalledTimes(1);
    expect(aiQueue.add.mock.calls[0][1].pageIds).toEqual([PAGE_ID]);

    // Contributors keyed by the UUID so they match the PAGE_HISTORY job (page.id).
    expect(collabHistory.addContributors.mock.calls[0][0]).toBe(PAGE_ID);
  });

  // #370 — explicit save-version (Cmd+S / agent save tool) over the stateless
  // seam. The tier is derived from the SIGNED connection actor, the store path
  // is reused, and promote-not-dup avoids duplicating heavy content rows.
  describe('save-version (#370)', () => {
    const emitSave = (document: any, actor: 'user' | 'agent') =>
      ext.onStateless({
        connection: {
          readOnly: false,
          context: { user: { id: USER_ID, name: 'Alice' }, actor },
        } as any,
        documentName: `page.${PAGE_ID}`,
        document: document as any,
        payload: JSON.stringify({ type: 'save-version' }),
      } as any);

    // findById returns a page whose content already equals the live doc, so the
    // store path is a no-op and we isolate the versioning decision.
    const pageMatchingDoc = (document: any) => ({
      ...persistedHumanPage('IGNORED'),
      content: TiptapTransformer.fromYdoc(document, 'default'),
    });

    it('human save with no prior snapshot → writes a manual version + broadcasts', async () => {
      const document = ydocFor(doc('VERSION ME'));
      pageRepo.findById.mockResolvedValue(pageMatchingDoc(document));
      pageHistoryRepo.findPageLastHistory.mockResolvedValue(null);

      await emitSave(document, 'user');

      expect(pageHistoryRepo.saveHistory).toHaveBeenCalledTimes(1);
      expect(pageHistoryRepo.saveHistory.mock.calls[0][1]).toEqual(
        expect.objectContaining({ kind: 'manual' }),
      );
      // The pending idle autosnapshot is cancelled by the explicit version.
      expect(historyQueue.remove).toHaveBeenCalledWith(PAGE_ID);
      const msg = JSON.parse(
        (document as any).broadcastStateless.mock.calls[
          (document as any).broadcastStateless.mock.calls.length - 1
        ][0],
      );
      expect(msg).toMatchObject({
        type: 'version.saved',
        kind: 'manual',
        alreadySaved: false,
      });
    });

    it('agent save derives kind=agent from the signed actor', async () => {
      const document = ydocFor(doc('AGENT VERSION'));
      pageRepo.findById.mockResolvedValue(pageMatchingDoc(document));
      pageHistoryRepo.findPageLastHistory.mockResolvedValue(null);

      await emitSave(document, 'agent');

      expect(
        pageHistoryRepo.saveHistory.mock.calls[
          pageHistoryRepo.saveHistory.mock.calls.length - 1
        ][1],
      ).toEqual(expect.objectContaining({ kind: 'agent' }));
    });

    it('promote-not-dup: latest snapshot is an autosave with identical content → upgrades in place', async () => {
      const document = ydocFor(doc('SAME'));
      const page = pageMatchingDoc(document);
      pageRepo.findById.mockResolvedValue(page);
      pageHistoryRepo.findPageLastHistory.mockResolvedValue({
        id: 'auto-1',
        content: page.content,
        kind: 'idle',
      });

      await emitSave(document, 'user');

      // No heavy new content row — the existing autosave is promoted to manual.
      expect(pageHistoryRepo.updateHistoryKind).toHaveBeenCalledWith(
        'auto-1',
        'manual',
        expect.anything(),
      );
      expect(pageHistoryRepo.saveHistory).not.toHaveBeenCalled();
      const msg = JSON.parse(
        (document as any).broadcastStateless.mock.calls[
          (document as any).broadcastStateless.mock.calls.length - 1
        ][0],
      );
      expect(msg).toMatchObject({ historyId: 'auto-1', alreadySaved: false });
    });

    it('no-op when the latest snapshot is already a manual version of this content', async () => {
      const document = ydocFor(doc('ALREADY SAVED'));
      const page = pageMatchingDoc(document);
      pageRepo.findById.mockResolvedValue(page);
      pageHistoryRepo.findPageLastHistory.mockResolvedValue({
        id: 'ver-1',
        content: page.content,
        kind: 'manual',
      });

      await emitSave(document, 'user');

      expect(pageHistoryRepo.updateHistoryKind).not.toHaveBeenCalled();
      expect(pageHistoryRepo.saveHistory).not.toHaveBeenCalled();
      const msg = JSON.parse(
        (document as any).broadcastStateless.mock.calls[
          (document as any).broadcastStateless.mock.calls.length - 1
        ][0],
      );
      expect(msg).toMatchObject({ alreadySaved: true, kind: 'manual' });
    });

    it('a read-only connection cannot save a version', async () => {
      const document = ydocFor(doc('READER'));
      pageRepo.findById.mockResolvedValue(pageMatchingDoc(document));

      await ext.onStateless({
        connection: {
          readOnly: true,
          context: { user: { id: USER_ID }, actor: 'user' },
        } as any,
        documentName: `page.${PAGE_ID}`,
        document: document as any,
        payload: JSON.stringify({ type: 'save-version' }),
      } as any);

      expect(pageHistoryRepo.saveHistory).not.toHaveBeenCalled();
      expect(pageHistoryRepo.updateHistoryKind).not.toHaveBeenCalled();
    });

    // #370 F8-twin — a COMMIT abort (serialization/deadlock/conn-drop) rejects
    // OUTSIDE the tx callback, AFTER the destructive popContributors (SPOP) and
    // saveHistory ran but the INSERT rolled back. onStateless has no retry, so
    // the outer catch MUST re-add (SADD) the popped set or attribution is lost
    // irrecoverably. MUTATION: drop the outer catch → addContributors is never
    // called → this reddens.
    it('restores popped contributors when the commit aborts after the callback', async () => {
      const document = ydocFor(doc('VERSION ME'));
      pageRepo.findById.mockResolvedValue(pageMatchingDoc(document));
      // No matching snapshot → fresh version branch → pops contributors.
      pageHistoryRepo.findPageLastHistory.mockResolvedValue(null);
      collabHistory.popContributors.mockResolvedValue(['u1', 'u2']);

      // A db whose commit REJECTS after the callback body resolved: the SPOP and
      // saveHistory already ran, then the tx aborts. onStoreDocument's flush uses
      // the same db but its content matches (no-op branch) and its own retry loop
      // swallows the throw, so only the versioning tx exercises the restore.
      const commitFailingDb = {
        transaction: () => ({
          execute: async (fn: (trx: any) => Promise<any>) => {
            await fn(trxStub);
            throw new Error('commit aborted (serialization_failure)');
          },
        }),
      };
      const ext2 = new PersistenceExtension(
        pageRepo as any,
        pageHistoryRepo as any,
        commitFailingDb as any,
        aiQueue as any,
        historyQueue as any,
        notificationQueue as any,
        collabHistory as any,
        transclusionService as any,
      );
      jest.spyOn(ext2['logger'], 'debug').mockImplementation(() => undefined);
      jest.spyOn(ext2['logger'], 'warn').mockImplementation(() => undefined);
      jest.spyOn(ext2['logger'], 'error').mockImplementation(() => undefined);

      await expect(
        ext2.onStateless({
          connection: {
            readOnly: false,
            context: { user: { id: USER_ID, name: 'Alice' }, actor: 'user' },
          } as any,
          documentName: `page.${PAGE_ID}`,
          document: document as any,
          payload: JSON.stringify({ type: 'save-version' }),
        } as any),
      ).rejects.toThrow();

      // Attribution preserved: the popped set is SADD-restored, keyed by the page
      // UUID it was popped under.
      expect(collabHistory.addContributors).toHaveBeenCalledWith(PAGE_ID, [
        'u1',
        'u2',
      ]);
    });

    // #370 #260 — for a `page.<slugId>` document the idle job is armed under the
    // page UUID (computeHistoryJob's jobId = page.id), so the supersede-remove
    // must target page.id, not the raw slugId doc-name id, or it silently misses.
    it('cancels the superseded idle job by the page UUID for a slugId doc', async () => {
      const SLUG = 'slug-1'; // persistedHumanPage.slugId
      const document = ydocFor(doc('VERSION ME'));
      pageRepo.findById.mockResolvedValue(pageMatchingDoc(document));
      pageHistoryRepo.findPageLastHistory.mockResolvedValue(null);

      await ext.onStateless({
        connection: {
          readOnly: false,
          context: { user: { id: USER_ID, name: 'Alice' }, actor: 'user' },
        } as any,
        documentName: `page.${SLUG}`,
        document: document as any,
        payload: JSON.stringify({ type: 'save-version' }),
      } as any);

      // remove() keyed by the UUID (the real jobId), never the slugId.
      expect(historyQueue.remove).toHaveBeenCalledWith(PAGE_ID);
      expect(historyQueue.remove).not.toHaveBeenCalledWith(SLUG);
    });

    // #370 F2 — an effectively-empty page is a REACHABLE no-op (agent calls
    // save_page_version on a blank page): the version tx short-circuits with
    // nothing to pin. The handler MUST still broadcast a TERMINAL reply
    // (version.skipped, reason:'empty') so the client resolves at once instead of
    // waiting out its 20s ack timeout and misreporting a healthy server as
    // unreachable. MUTATION: drop the `else if (skipped)` broadcast → no terminal
    // reply is sent → this reddens.
    it('empty page → no version written, broadcasts a terminal version.skipped(empty)', async () => {
      const emptyDoc = { type: 'doc', content: [{ type: 'paragraph' }] };
      const document = ydocFor(emptyDoc);
      pageRepo.findById.mockResolvedValue({
        ...persistedHumanPage('IGNORED'),
        content: emptyDoc,
      });

      await emitSave(document, 'agent');

      // Nothing pinned.
      expect(pageHistoryRepo.saveHistory).not.toHaveBeenCalled();
      expect(pageHistoryRepo.updateHistoryKind).not.toHaveBeenCalled();
      // But a terminal reply WAS sent so the client never times out. The flush
      // (onStoreDocument) emits its own `page.updated`; the version.skipped is the
      // LAST broadcast (dropping the skip branch leaves page.updated last → reds).
      const calls = (document as any).broadcastStateless.mock.calls;
      const msg = JSON.parse(calls[calls.length - 1][0]);
      expect(msg).toEqual({ type: 'version.skipped', reason: 'empty' });
    });

    // #370 F2 — the page row is gone (deleted / never persisted). Same rule: a
    // terminal reply MUST be sent (version.skipped, reason:'page-not-found') so the
    // client surfaces a truthful "not found" immediately rather than a health
    // timeout. onStoreDocument's own `!page` guard returns early without throwing,
    // so the handler reaches the version tx and its `!page` skip branch.
    it('page not found → broadcasts a terminal version.skipped(page-not-found)', async () => {
      const document = ydocFor(doc('GONE'));
      pageRepo.findById.mockResolvedValue(null);

      await emitSave(document, 'agent');

      expect(pageHistoryRepo.saveHistory).not.toHaveBeenCalled();
      expect((document as any).broadcastStateless).toHaveBeenCalledTimes(1);
      const msg = JSON.parse(
        (document as any).broadcastStateless.mock.calls[0][0],
      );
      expect(msg).toEqual({
        type: 'version.skipped',
        reason: 'page-not-found',
      });
    });
  });

  // #559 — the external-MCP api_key behind a content edit must be threaded from
  // the connection context all the way to pageRepo.updatePage's
  // `lastUpdatedApiKeyId`, so the persona ("External MCP" / <key name>) survives
  // the collab/page edit path. This is the WRITE hop the review flagged as
  // silently dropping the id (the middle of the auth→DB→history→read chain).
  describe('external-MCP api_key threading (#559)', () => {
    // Same shape as buildData, but carries an api_key id on the context.
    const buildDataWithApiKey = (
      document: any,
      actor: 'user' | 'agent',
      apiKeyId: string | undefined,
    ) => ({
      documentName: `page.${PAGE_ID}`,
      document,
      context: { user: { id: USER_ID, name: 'Alice' }, actor, apiKeyId },
    });

    it('writes context.apiKeyId to updatePage.lastUpdatedApiKeyId', async () => {
      const document = ydocFor(doc('NEW CONTENT'));
      pageRepo.findById.mockResolvedValue(persistedHumanPage('NEW CONTENT'));

      await ext.onStoreDocument(
        buildDataWithApiKey(document, 'agent', 'key-1') as any,
      );

      expect(pageRepo.updatePage).toHaveBeenCalledTimes(1);
      // The write hop at persistence.extension updatePage(...): the api_key id
      // must land on lastUpdatedApiKeyId. NON-VACUITY: reverting the source hop
      // (e.g. hardcoding `lastUpdatedApiKeyId: null` or dropping the field)
      // makes this assertion RED.
      expect(pageRepo.updatePage.mock.calls[0][0].lastUpdatedApiKeyId).toBe(
        'key-1',
      );
    });

    it('writes null lastUpdatedApiKeyId for a human/internal-agent edit (no apiKeyId)', async () => {
      const document = ydocFor(doc('NEW CONTENT'));
      pageRepo.findById.mockResolvedValue(persistedHumanPage('NEW CONTENT'));

      // A context with NO apiKeyId (a human, or the internal AI agent) must
      // resolve to null per the code's `context?.apiKeyId ?? null`, never
      // undefined — so the column is explicitly cleared, not left absent.
      await ext.onStoreDocument(
        buildDataWithApiKey(document, 'user', undefined) as any,
      );

      expect(pageRepo.updatePage).toHaveBeenCalledTimes(1);
      expect(
        pageRepo.updatePage.mock.calls[0][0].lastUpdatedApiKeyId,
      ).toBeNull();
    });
  });

  // #370 — the in-memory idle-burst marker must be dropped on doc unload (like
  // its sibling per-document maps) or it grows unbounded for every page that was
  // edited but never manually saved. MUTATION: drop the afterUnloadDocument
  // delete → the entry survives → this reddens.
  describe('idleBurstStart housekeeping', () => {
    it('afterUnloadDocument clears the idle-burst marker armed by a store', async () => {
      const document = ydocFor(doc('EDIT'));
      pageRepo.findById.mockResolvedValue(persistedHumanPage('EDIT'));

      await ext.onStoreDocument(buildData(document, 'user') as any);

      const map = ext['idleBurstStart'] as Map<string, number>;
      // Keyed by documentName (buildData uses `page.${PAGE_ID}`).
      expect(map.has(`page.${PAGE_ID}`)).toBe(true);

      await ext.afterUnloadDocument({
        documentName: `page.${PAGE_ID}`,
      } as any);

      expect(map.has(`page.${PAGE_ID}`)).toBe(false);
    });
  });
});
