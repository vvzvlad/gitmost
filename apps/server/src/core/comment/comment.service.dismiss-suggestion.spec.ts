import { BadRequestException } from '@nestjs/common';
import { CommentService } from './comment.service';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import { QueueJob } from '../../integrations/queue/constants';

// #399: the inline comment-mark op (resolve flip / ephemeral-suggestion anchor
// removal) is now enqueued as a COMMENT_MARK_UPDATE job instead of being awaited
// against the collab gateway on the HTTP path. Find that job by action.
const markJob = (generalQueue: any, action: string) =>
  generalQueue.add.mock.calls.find(
    (c: any[]) => c[0] === QueueJob.COMMENT_MARK_UPDATE && c[1]?.action === action,
  );

/**
 * Coverage for CommentService.dismissSuggestion (#329). Dismiss ("Не применять")
 * removes a suggested edit WITHOUT changing the page text: the comment
 * disappears (hard-delete + strip the inline anchor mark) unless the thread has
 * replies, in which case it is resolved to preserve the discussion.
 *
 * The permission gate (canComment, NOT canEdit) lives in the controller and is
 * covered in comment.controller.spec.ts; here we pin the service's own state
 * guards and the delete-vs-resolve fork.
 */
describe('CommentService — dismissSuggestion', () => {
  const UPDATED = { id: 'c-1', __updated: true } as any;

  function makeService(hasChildren = false, deletedRows = 1) {
    const commentRepo: any = {
      findById: jest.fn(async () => UPDATED),
      updateComment: jest.fn(async () => undefined),
      hasChildren: jest.fn(async () => hasChildren),
      deleteComment: jest.fn(async () => undefined),
      // #338 F1: the childless ephemeral delete is now atomic-conditional and
      // returns the number of rows removed (1 = deleted, 0 = a reply raced in).
      deleteCommentIfChildless: jest.fn(async () => deletedRows),
    };
    const pageRepo: any = {};
    const wsService: any = { emitCommentEvent: jest.fn() };
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
      wsService,
      collaborationGateway,
      generalQueue,
      auditService,
    };
  }

  const suggestionComment = (over?: Partial<any>): any => ({
    id: 'c-1',
    pageId: 'page-1',
    spaceId: 'space-1',
    workspaceId: 'ws-1',
    creatorId: 'user-1',
    parentCommentId: null,
    selection: 'old text',
    suggestedText: 'new text',
    suggestionAppliedAt: null,
    resolvedAt: null,
    ...over,
  });
  const user = (over?: Partial<any>): any => ({ id: 'user-1', ...over });

  it('no replies → hard-deletes, enqueues the anchor-mark removal, does NOT touch page text, audits DISMISSED, outcome=deleted', async () => {
    const {
      service,
      commentRepo,
      wsService,
      collaborationGateway,
      generalQueue,
      auditService,
    } = makeService(false);

    const result = await service.dismissSuggestion(suggestionComment(), user());

    // Never applies the suggestion to the document (no sync gateway call at all
    // now — the mark op is off the HTTP path, #399).
    expect(collaborationGateway.handleYjsEvent).not.toHaveBeenCalled();
    // Hard-delete (atomic-conditional) + enqueue the anchor-mark strip.
    expect(commentRepo.deleteCommentIfChildless).toHaveBeenCalledWith('c-1');
    const del = markJob(generalQueue, 'delete');
    expect(del).toBeDefined();
    expect(del[1]).toMatchObject({
      documentName: 'page.page-1',
      commentId: 'c-1',
      userId: 'user-1',
    });
    expect(wsService.emitCommentEvent).toHaveBeenCalledWith(
      'space-1',
      'page-1',
      expect.objectContaining({ operation: 'commentDeleted', commentId: 'c-1' }),
    );
    // #496: the row is hard-deleted, so the audit payload must carry the
    // decision's substance (what was suggested, the anchored text, who authored
    // it, who decided) — it is the only surviving record.
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: AuditEvent.COMMENT_SUGGESTION_DISMISSED,
        resourceType: AuditResource.COMMENT,
        resourceId: 'c-1',
        metadata: expect.objectContaining({
          pageId: 'page-1',
          suggestedText: 'new text',
          selection: 'old text',
          commentAuthor: 'user-1',
          decidedBy: 'user-1',
        }),
      }),
    );
    expect(result.outcome).toBe('deleted');
  });

  it('no replies → if the anchor-mark ENQUEUE FAILS, the row is NOT deleted and the error propagates (#329/#399: no orphan anchor)', async () => {
    const { service, commentRepo, wsService, generalQueue } = makeService(false);
    // #399: the mark removal now runs async in a worker, but the ENQUEUE is
    // awaited BEFORE the irreversible row delete — so the anchor-removal job is
    // durably scheduled before the row can vanish. If even the enqueue fails
    // (e.g. Redis down), the whole operation aborts, leaving row + mark
    // consistent — never a deleted row with an orphan anchor reporting success.
    generalQueue.add = jest.fn(async () => {
      throw new Error('queue add failed: no redis');
    });

    await expect(
      service.dismissSuggestion(suggestionComment(), user()),
    ).rejects.toThrow(/queue add failed/);

    expect(commentRepo.deleteCommentIfChildless).not.toHaveBeenCalled();
    expect(wsService.emitCommentEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ operation: 'commentDeleted' }),
    );
  });

  it('WITH replies → resolves (not delete), does NOT apply, audits DISMISSED, outcome=resolved', async () => {
    const {
      service,
      commentRepo,
      collaborationGateway,
      generalQueue,
      auditService,
    } = makeService(true);

    const result = await service.dismissSuggestion(suggestionComment(), user());

    // Resolved via resolveComment (resolve patch + enqueued resolve mark), NOT
    // deleted.
    const resolvePatch = commentRepo.updateComment.mock.calls
      .map((c: any[]) => c[0])
      .find((p: any) => 'resolvedAt' in p);
    expect(resolvePatch.resolvedAt).toBeInstanceOf(Date);
    expect(resolvePatch.resolvedById).toBe('user-1');
    expect(commentRepo.deleteComment).not.toHaveBeenCalled();
    // No sync gateway call; the resolve mark is enqueued (#399).
    expect(collaborationGateway.handleYjsEvent).not.toHaveBeenCalled();
    const res = markJob(generalQueue, 'resolve');
    expect(res).toBeDefined();
    expect(res[1]).toMatchObject({ documentName: 'page.page-1', commentId: 'c-1' });
    // No applied stamp — dismiss does not apply the edit.
    const appliedPatch = commentRepo.updateComment.mock.calls
      .map((c: any[]) => c[0])
      .find((p: any) => 'suggestionAppliedAt' in p);
    expect(appliedPatch).toBeUndefined();

    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: AuditEvent.COMMENT_SUGGESTION_DISMISSED,
      }),
    );
    expect(result.outcome).toBe('resolved');
  });

  it('reply races in after the childless read (conditional delete → 0 rows) → resolves instead, does NOT hard-delete, reply survives, outcome=resolved (#338 F1)', async () => {
    // hasChildren=false selects the ephemeral branch (the read saw no replies),
    // but the atomic delete matches 0 rows because a reply landed in the window
    // between that read and the delete. The parent must NOT be hard-deleted
    // (a cascade would destroy the just-added reply); the thread is resolved.
    const { service, commentRepo, wsService, generalQueue } = makeService(false, 0);

    const result = await service.dismissSuggestion(suggestionComment(), user());

    // The conditional delete was attempted (and matched nothing).
    expect(commentRepo.deleteCommentIfChildless).toHaveBeenCalledWith('c-1');
    // No commentDeleted broadcast — the row (and the racing reply) survive.
    expect(wsService.emitCommentEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ operation: 'commentDeleted' }),
    );
    // Fell back to resolving the thread.
    const resolvePatch = commentRepo.updateComment.mock.calls
      .map((c: any[]) => c[0])
      .find((p: any) => 'resolvedAt' in p);
    expect(resolvePatch.resolvedAt).toBeInstanceOf(Date);
    expect(resolvePatch.resolvedById).toBe('user-1');
    // A resolve mark job is enqueued (the anchor was already delete-marked; the
    // resolve mirror is idempotent — #399).
    expect(markJob(generalQueue, 'resolve')).toBeDefined();
    expect(result.outcome).toBe('resolved');
  });

  it('rejects a reply (non-top-level) comment', async () => {
    const { service, commentRepo } = makeService();
    await expect(
      service.dismissSuggestion(
        suggestionComment({ parentCommentId: 'parent-1' }),
        user(),
      ),
    ).rejects.toThrow(BadRequestException);
    expect(commentRepo.deleteComment).not.toHaveBeenCalled();
  });

  it('rejects a comment without a suggested edit', async () => {
    const { service, commentRepo } = makeService();
    await expect(
      service.dismissSuggestion(
        suggestionComment({ suggestedText: null }),
        user(),
      ),
    ).rejects.toThrow(BadRequestException);
    expect(commentRepo.deleteComment).not.toHaveBeenCalled();
  });

  it('rejects an already-applied suggestion', async () => {
    const { service, commentRepo } = makeService();
    await expect(
      service.dismissSuggestion(
        suggestionComment({ suggestionAppliedAt: new Date() }),
        user(),
      ),
    ).rejects.toThrow(BadRequestException);
    expect(commentRepo.deleteComment).not.toHaveBeenCalled();
  });

  it('rejects an already-resolved thread', async () => {
    const { service, commentRepo } = makeService();
    await expect(
      service.dismissSuggestion(
        suggestionComment({ resolvedAt: new Date() }),
        user(),
      ),
    ).rejects.toThrow(BadRequestException);
    expect(commentRepo.deleteComment).not.toHaveBeenCalled();
  });
});
