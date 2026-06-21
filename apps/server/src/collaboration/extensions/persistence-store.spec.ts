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
});
