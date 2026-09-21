import { Job } from 'bullmq';
import { GeneralQueueProcessor } from './general-queue.processor';
import { QueueJob } from '../constants';
import { ICommentMarkUpdateJob } from '../constants/queue.interface';

/**
 * #399: the GENERAL_QUEUE worker replays the comment inline-mark op that used to
 * run synchronously on the HTTP path. It must call the SAME gateway handler with
 * the SAME semantics (resolve/unresolve → flip the `resolved` attribute; delete
 * → strip the anchor), and its timestamp race-guard must skip an event a newer,
 * opposite event already superseded.
 */
describe('GeneralQueueProcessor — COMMENT_MARK_UPDATE (#399)', () => {
  function makeProc() {
    const collaborationGateway: any = {
      handleYjsEvent: jest.fn(async () => undefined),
    };
    const commentRepo: any = { findById: jest.fn() };
    // #399: the processor resolves CollaborationGateway lazily via ModuleRef
    // (strict:false) to avoid a DI cycle; the fake returns our gateway spy.
    const moduleRef: any = { get: jest.fn(() => collaborationGateway) };
    const proc = new GeneralQueueProcessor(
      {} as any, // db
      {} as any, // backlinkRepo
      {} as any, // watcherRepo
      commentRepo,
      moduleRef,
    );
    return { proc, collaborationGateway, commentRepo };
  }

  const job = (data: ICommentMarkUpdateJob): Job =>
    ({ name: QueueJob.COMMENT_MARK_UPDATE, data }) as unknown as Job;

  const base = {
    documentName: 'page.page-1',
    commentId: 'c-1',
    userId: 'user-1',
  };

  it('resolve → resolveCommentMark with resolved:true and the same-shape args', async () => {
    const { proc, collaborationGateway, commentRepo } = makeProc();
    const ts = 1000;
    // Row reflects the resolve (source of truth), stamped at the same ts.
    commentRepo.findById.mockResolvedValue({
      id: 'c-1',
      resolvedAt: new Date(ts),
      updatedAt: new Date(ts),
    });

    await proc.process(job({ ...base, action: 'resolve', ts }));

    expect(collaborationGateway.handleYjsEvent).toHaveBeenCalledTimes(1);
    expect(collaborationGateway.handleYjsEvent).toHaveBeenCalledWith(
      'resolveCommentMark',
      'page.page-1',
      { commentId: 'c-1', resolved: true, user: { id: 'user-1' } },
    );
  });

  it('unresolve → resolveCommentMark with resolved:false', async () => {
    const { proc, collaborationGateway, commentRepo } = makeProc();
    const ts = 2000;
    commentRepo.findById.mockResolvedValue({
      id: 'c-1',
      resolvedAt: null,
      updatedAt: new Date(ts),
    });

    await proc.process(job({ ...base, action: 'unresolve', ts }));

    expect(collaborationGateway.handleYjsEvent).toHaveBeenCalledWith(
      'resolveCommentMark',
      'page.page-1',
      { commentId: 'c-1', resolved: false, user: { id: 'user-1' } },
    );
  });

  it('delete → deleteCommentMark (strip the anchor), no row lookup / no state guard', async () => {
    const { proc, collaborationGateway, commentRepo } = makeProc();

    await proc.process(job({ ...base, action: 'delete', ts: 123 }));

    expect(collaborationGateway.handleYjsEvent).toHaveBeenCalledWith(
      'deleteCommentMark',
      'page.page-1',
      { commentId: 'c-1', user: { id: 'user-1' } },
    );
    // Delete carries no state guard — the row is (being) removed.
    expect(commentRepo.findById).not.toHaveBeenCalled();
  });

  it('SKIPS a stale resolve superseded by a newer unresolve (row unresolved, job ts older)', async () => {
    const { proc, collaborationGateway, commentRepo } = makeProc();
    // A later unresolve already set the row: resolvedAt null, updatedAt = 5000.
    commentRepo.findById.mockResolvedValue({
      id: 'c-1',
      resolvedAt: null,
      updatedAt: new Date(5000),
    });

    // Stale resolve job enqueued at ts=1000 (< 5000), intends resolved=true,
    // but the row's authoritative state is unresolved → skip.
    await proc.process(job({ ...base, action: 'resolve', ts: 1000 }));

    expect(collaborationGateway.handleYjsEvent).not.toHaveBeenCalled();
  });

  it('SKIPS a stale unresolve superseded by a newer resolve', async () => {
    const { proc, collaborationGateway, commentRepo } = makeProc();
    commentRepo.findById.mockResolvedValue({
      id: 'c-1',
      resolvedAt: new Date(5000),
      updatedAt: new Date(5000),
    });

    await proc.process(job({ ...base, action: 'unresolve', ts: 1000 }));

    expect(collaborationGateway.handleYjsEvent).not.toHaveBeenCalled();
  });

  it('applies when the row state agrees even if ts is older (idempotent, not a stale flip)', async () => {
    const { proc, collaborationGateway, commentRepo } = makeProc();
    // Row is resolved and its updatedAt is newer than the job ts, but the state
    // AGREES with the job → this is a harmless idempotent replay, not a stale
    // opposite event, so it must still apply.
    commentRepo.findById.mockResolvedValue({
      id: 'c-1',
      resolvedAt: new Date(9000),
      updatedAt: new Date(9000),
    });

    await proc.process(job({ ...base, action: 'resolve', ts: 1000 }));

    expect(collaborationGateway.handleYjsEvent).toHaveBeenCalledWith(
      'resolveCommentMark',
      'page.page-1',
      { commentId: 'c-1', resolved: true, user: { id: 'user-1' } },
    );
  });

  it('reconcile (#496): comment row vanished → strips the orphan anchor mark', async () => {
    const { proc, collaborationGateway, commentRepo } = makeProc();
    commentRepo.findById.mockResolvedValue(undefined);

    await expect(
      proc.process(job({ ...base, action: 'resolve', ts: 1000 })),
    ).resolves.toBeUndefined();
    // A resolve/unresolve mark job whose comment row is gone leaves a silent
    // orphan; the worker self-heals by stripping the anchor instead of returning.
    expect(collaborationGateway.handleYjsEvent).toHaveBeenCalledWith(
      'deleteCommentMark',
      'page.page-1',
      { commentId: 'c-1', user: { id: 'user-1' } },
    );
  });
});
