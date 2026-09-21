import { Logger } from '@nestjs/common';
import { CommentService } from './comment.service';
import { QueueJob } from '../../integrations/queue/constants';

// Flush pending microtasks so a fire-and-forget `.catch(...)` runs before we assert.
const flushMicrotasks = () => new Promise((r) => setImmediate(r));

/**
 * #399: the comment inline-mark update is moved OFF the HTTP critical path.
 * resolveComment / unresolve / the ephemeral-suggestion delete must NO LONGER
 * await CollaborationGateway.handleYjsEvent (which loaded the whole Y.Doc and
 * ran the store pipeline synchronously, ~4.5s p95). Instead they enqueue an
 * idempotent COMMENT_MARK_UPDATE job onto the GENERAL_QUEUE with the payload the
 * worker replays.
 *
 * The service is constructed directly with jest mocks (the @InjectQueue tokens
 * cannot be resolved by Test.createTestingModule — see comment.service.spec.ts).
 */
describe('CommentService — async comment mark (#399)', () => {
  function makeService() {
    const commentRepo: any = {
      findById: jest.fn(async (id: string) => ({
        id,
        content: {},
        spaceId: 'space-1',
        pageId: 'page-1',
      })),
      updateComment: jest.fn(async () => undefined),
      hasChildren: jest.fn(async () => false),
      deleteCommentIfChildless: jest.fn(async () => 1),
    };
    const pageRepo: any = {};
    const wsService: any = { emitCommentEvent: jest.fn() };
    // The gateway MUST NOT be touched on the HTTP path anymore.
    const collaborationGateway: any = {
      handleYjsEvent: jest.fn(async () => undefined),
    };
    const generalQueue: any = { add: jest.fn(() => Promise.resolve()) };
    const notificationQueue: any = { add: jest.fn(async () => undefined) };
    const auditService: any = { log: jest.fn() };

    const service = new CommentService(
      commentRepo,
      pageRepo,
      wsService,
      collaborationGateway,
      generalQueue,
      notificationQueue,
      auditService,
    );
    return {
      service,
      commentRepo,
      collaborationGateway,
      generalQueue,
      auditService,
    };
  }

  const comment = (over?: Partial<any>): any => ({
    id: 'c-1',
    creatorId: 'user-1',
    pageId: 'page-1',
    spaceId: 'space-1',
    workspaceId: 'ws-1',
    ...over,
  });
  const user = (over?: Partial<any>): any => ({ id: 'user-1', ...over });

  const markJob = (generalQueue: any) =>
    generalQueue.add.mock.calls.find(
      (c: any[]) => c[0] === QueueJob.COMMENT_MARK_UPDATE,
    );

  it('resolveComment does NOT call the gateway synchronously, and enqueues a resolve mark job', async () => {
    const { service, collaborationGateway, generalQueue } = makeService();

    await service.resolveComment(comment(), true, user());

    // The whole point of #399: the Y.Doc mark op is off the HTTP path.
    expect(collaborationGateway.handleYjsEvent).not.toHaveBeenCalled();

    const job = markJob(generalQueue);
    expect(job).toBeDefined();
    expect(job[0]).toBe(QueueJob.COMMENT_MARK_UPDATE);
    expect(job[1]).toMatchObject({
      documentName: 'page.page-1',
      commentId: 'c-1',
      action: 'resolve',
      userId: 'user-1',
    });
    expect(typeof job[1].ts).toBe('number');
    // ts equals the resolvedAt stamp written to the row (shared timestamp).
    const [patch] = (service as any).commentRepo.updateComment.mock.calls[0];
    expect(job[1].ts).toBe((patch.resolvedAt as Date).getTime());
    expect(job[1].ts).toBe((patch.updatedAt as Date).getTime());
  });

  it('unresolve enqueues an unresolve mark job (action mapped from resolved=false)', async () => {
    const { service, collaborationGateway, generalQueue } = makeService();

    await service.resolveComment(comment(), false, user());

    expect(collaborationGateway.handleYjsEvent).not.toHaveBeenCalled();
    const job = markJob(generalQueue);
    expect(job[1]).toMatchObject({
      documentName: 'page.page-1',
      commentId: 'c-1',
      action: 'unresolve',
      userId: 'user-1',
    });
  });

  it('dismissing a childless ephemeral suggestion enqueues a delete mark job (not a sync gateway call)', async () => {
    const { service, collaborationGateway, generalQueue } = makeService();

    await service.dismissSuggestion(
      comment({ suggestedText: 'new text', selection: 'old', resolvedAt: null }),
      user(),
    );

    // The anchor removal is queued, not awaited against the gateway.
    expect(collaborationGateway.handleYjsEvent).not.toHaveBeenCalled();
    const job = markJob(generalQueue);
    expect(job).toBeDefined();
    expect(job[1]).toMatchObject({
      documentName: 'page.page-1',
      commentId: 'c-1',
      action: 'delete',
      userId: 'user-1',
    });
    expect(typeof job[1].ts).toBe('number');
  });

  it('awaits the delete ENQUEUE before the irreversible row hard-delete (ordering preserved)', async () => {
    const { service, generalQueue, commentRepo } = makeService();
    const order: string[] = [];
    generalQueue.add.mockImplementation(async (name: string) => {
      order.push(`enqueue:${name}`);
    });
    commentRepo.deleteCommentIfChildless.mockImplementation(async () => {
      order.push('delete-row');
      return 1;
    });

    await service.dismissSuggestion(
      comment({ suggestedText: 'new text', selection: 'old', resolvedAt: null }),
      user(),
    );

    // The mark-removal job must be durably queued BEFORE the row disappears.
    expect(order).toEqual([
      `enqueue:${QueueJob.COMMENT_MARK_UPDATE}`,
      'delete-row',
    ]);
  });

  it('resolve is fire-and-forget: a queue-add rejection does NOT fail the HTTP call (best-effort warn)', async () => {
    const { service, generalQueue } = makeService();
    // The queue is unavailable — the whole point of #399 is that this must NOT
    // propagate out of resolveComment onto the HTTP request.
    const queueErr = new Error('queue is down');
    generalQueue.add.mockRejectedValue(queueErr);
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    // Must resolve, never throw, even though the enqueue rejects.
    await expect(service.resolveComment(comment(), true, user())).resolves.not.toThrow();

    // The rejection is swallowed on a microtask AFTER the method returns; flush it.
    await flushMicrotasks();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to enqueue comment mark update for comment c-1'),
      queueErr,
    );
    warnSpy.mockRestore();
  });
});
