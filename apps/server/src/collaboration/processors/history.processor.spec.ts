import { Job } from 'bullmq';
import { HistoryProcessor } from './history.processor';
import { QueueJob } from '../../integrations/queue/constants';

/**
 * Unit tests for `HistoryProcessor.process`. This worker is the last line of
 * defense for the page-history snapshot, so we pin the data-loss-sensitive
 * paths: duplicate/empty history skipping (isDeepStrictEqual), and — critically
 * — that a saveHistory failure RESTORES the contributors it popped (otherwise
 * the contributor set is silently lost) before rethrowing.
 */

const PAGE_ID = 'page-1';
const SPACE_ID = 'space-1';
const WORKSPACE_ID = 'ws-1';

// A non-empty content doc (distinct from the empty-paragraph doc).
const filledContent = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }],
};
const emptyContent = { type: 'doc', content: [{ type: 'paragraph' }] };

const buildPage = (overrides: Partial<any> = {}) => ({
  id: PAGE_ID,
  spaceId: SPACE_ID,
  workspaceId: WORKSPACE_ID,
  content: filledContent,
  ...overrides,
});

const buildJob = (overrides: Partial<any> = {}) =>
  ({
    name: QueueJob.PAGE_HISTORY,
    data: { pageId: PAGE_ID },
    ...overrides,
  }) as unknown as Job<any, void>;

describe('HistoryProcessor.process', () => {
  let proc: HistoryProcessor;
  let pageHistoryRepo: { findPageLastHistory: jest.Mock; saveHistory: jest.Mock };
  let pageRepo: { findById: jest.Mock };
  let collabHistory: {
    clearContributors: jest.Mock;
    popContributors: jest.Mock;
    addContributors: jest.Mock;
  };
  let watcherService: { addPageWatchers: jest.Mock };
  let notificationQueue: { add: jest.Mock };
  let generalQueue: { add: jest.Mock };

  beforeEach(() => {
    pageHistoryRepo = {
      findPageLastHistory: jest.fn().mockResolvedValue(null),
      saveHistory: jest.fn().mockResolvedValue(undefined),
    };
    pageRepo = { findById: jest.fn().mockResolvedValue(buildPage()) };
    collabHistory = {
      clearContributors: jest.fn().mockResolvedValue(undefined),
      popContributors: jest.fn().mockResolvedValue(['u1', 'u2']),
      addContributors: jest.fn().mockResolvedValue(undefined),
    };
    watcherService = {
      addPageWatchers: jest.fn().mockResolvedValue(undefined),
    };
    notificationQueue = { add: jest.fn().mockResolvedValue(undefined) };
    generalQueue = { add: jest.fn().mockResolvedValue(undefined) };

    // WorkerHost's constructor reads `this.worker`; passing repos positionally
    // matches the constructor and avoids the Nest DI container.
    proc = new HistoryProcessor(
      pageHistoryRepo as any,
      pageRepo as any,
      collabHistory as any,
      watcherService as any,
      notificationQueue as any,
      generalQueue as any,
    );
    jest.spyOn(proc['logger'], 'debug').mockImplementation(() => undefined);
    jest.spyOn(proc['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(proc['logger'], 'error').mockImplementation(() => undefined);
  });

  it('ignores jobs whose name is not PAGE_HISTORY (no page lookup)', async () => {
    await proc.process(buildJob({ name: 'some.other.job' }));
    expect(pageRepo.findById).not.toHaveBeenCalled();
  });

  it('page not found → clearContributors and return (no save)', async () => {
    pageRepo.findById.mockResolvedValue(null);

    await proc.process(buildJob());

    expect(collabHistory.clearContributors).toHaveBeenCalledWith(PAGE_ID);
    expect(pageHistoryRepo.saveHistory).not.toHaveBeenCalled();
    expect(collabHistory.popContributors).not.toHaveBeenCalled();
  });

  it('first history + empty content → skip and clear contributors (no save)', async () => {
    pageHistoryRepo.findPageLastHistory.mockResolvedValue(null);
    pageRepo.findById.mockResolvedValue(buildPage({ content: emptyContent }));

    await proc.process(buildJob());

    expect(collabHistory.clearContributors).toHaveBeenCalledWith(PAGE_ID);
    expect(pageHistoryRepo.saveHistory).not.toHaveBeenCalled();
  });

  it('content unchanged vs last history → no save (isDeepStrictEqual skip)', async () => {
    // Last history holds a deep-equal-but-distinct copy of current content.
    pageHistoryRepo.findPageLastHistory.mockResolvedValue({
      content: JSON.parse(JSON.stringify(filledContent)),
    });

    await proc.process(buildJob());

    expect(pageHistoryRepo.saveHistory).not.toHaveBeenCalled();
    expect(collabHistory.popContributors).not.toHaveBeenCalled();
  });

  it('content changed → addPageWatchers + saveHistory + backlinks queue', async () => {
    pageHistoryRepo.findPageLastHistory.mockResolvedValue({
      content: { type: 'doc', content: [] },
    });

    await proc.process(buildJob());

    expect(collabHistory.popContributors).toHaveBeenCalledWith(PAGE_ID);
    expect(watcherService.addPageWatchers).toHaveBeenCalledWith(
      ['u1', 'u2'],
      PAGE_ID,
      SPACE_ID,
      WORKSPACE_ID,
    );
    expect(pageHistoryRepo.saveHistory).toHaveBeenCalledWith(
      expect.objectContaining({ id: PAGE_ID }),
      { contributorIds: ['u1', 'u2'] },
    );
    expect(generalQueue.add).toHaveBeenCalledWith(
      QueueJob.PAGE_BACKLINKS,
      expect.objectContaining({ pageId: PAGE_ID, workspaceId: WORKSPACE_ID }),
    );
  });

  it('first history (lastHistory null) with non-empty content → saves, no PAGE_UPDATED notification', async () => {
    // popContributors yields users, but lastHistory?.content is falsy so the
    // notification branch (needs a prior version) must be skipped.
    pageHistoryRepo.findPageLastHistory.mockResolvedValue(null);

    await proc.process(buildJob());

    expect(pageHistoryRepo.saveHistory).toHaveBeenCalled();
    expect(notificationQueue.add).not.toHaveBeenCalled();
  });

  it('changed content WITH prior history + contributors → queues PAGE_UPDATED notification', async () => {
    pageHistoryRepo.findPageLastHistory.mockResolvedValue({
      content: { type: 'doc', content: [] },
    });

    await proc.process(buildJob());

    expect(notificationQueue.add).toHaveBeenCalledWith(
      QueueJob.PAGE_UPDATED,
      expect.objectContaining({
        pageId: PAGE_ID,
        actorIds: ['u1', 'u2'],
      }),
    );
  });

  it('saveHistory throws → contributors RESTORED (addContributors) AND error rethrown', async () => {
    // The data-loss guard: if the snapshot save fails after popContributors,
    // the popped ids MUST be returned to the pending set, then the error
    // propagates so BullMQ retries. Assert BOTH halves.
    pageHistoryRepo.findPageLastHistory.mockResolvedValue({
      content: { type: 'doc', content: [] },
    });
    const boom = new Error('db down');
    pageHistoryRepo.saveHistory.mockRejectedValue(boom);

    await expect(proc.process(buildJob())).rejects.toThrow('db down');
    expect(collabHistory.addContributors).toHaveBeenCalledWith(PAGE_ID, [
      'u1',
      'u2',
    ]);
  });

  it('backlinks + notification queue failures are swallowed (history still committed)', async () => {
    pageHistoryRepo.findPageLastHistory.mockResolvedValue({
      content: { type: 'doc', content: [] },
    });
    generalQueue.add.mockRejectedValue(new Error('redis backlinks down'));
    notificationQueue.add.mockRejectedValue(new Error('redis notif down'));

    // The downstream queue failures are caught internally; process resolves.
    await expect(proc.process(buildJob())).resolves.toBeUndefined();
    expect(pageHistoryRepo.saveHistory).toHaveBeenCalled();
  });
});
