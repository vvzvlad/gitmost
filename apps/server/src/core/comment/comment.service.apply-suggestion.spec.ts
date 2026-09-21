import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { CommentService } from './comment.service';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import { QueueJob } from '../../integrations/queue/constants';

// #399: the resolve/unresolve flip and the ephemeral anchor removal are enqueued
// as COMMENT_MARK_UPDATE jobs (off the HTTP path), NOT awaited against the collab
// gateway. applyCommentSuggestion (the document TEXT edit) is untouched — it
// still runs synchronously via the gateway.
const markJob = (generalQueue: any, action: string) =>
  generalQueue.add.mock.calls.find(
    (c: any[]) => c[0] === QueueJob.COMMENT_MARK_UPDATE && c[1]?.action === action,
  );

/**
 * Focused coverage for CommentService.applySuggestion (comment.service.ts).
 * The service is constructed directly with jest-mocked deps (the @InjectQueue
 * tokens can't be resolved by Test.createTestingModule — see the sibling specs).
 *
 * The collaboration gateway verdict is the pivot of the whole flow, so each test
 * pins a specific { applied, currentText } and asserts the DB persistence,
 * settle (ephemeral delete vs. resolve), audit, ws broadcast, and error mapping
 * that follow from it.
 *
 * Ephemeral rule (#329): once applied a suggestion DISAPPEARS (hard-delete +
 * strip the inline anchor mark) UNLESS the thread has replies, in which case it
 * is resolved to preserve the discussion. `hasChildren` selects the branch.
 */
describe('CommentService — applySuggestion', () => {
  const UPDATED = { id: 'c-1', __updated: true } as any;

  function makeService(verdict: unknown, hasChildren = false, deletedRows = 1) {
    const commentRepo: any = {
      // Both the applied-stamp re-read and resolveComment's re-read go through
      // findById; return a recognizable enriched row.
      findById: jest.fn(async () => UPDATED),
      updateComment: jest.fn(async () => undefined),
      hasChildren: jest.fn(async () => hasChildren),
      deleteComment: jest.fn(async () => undefined),
      // #338 F1: the childless ephemeral delete is atomic-conditional and
      // returns the number of rows removed (1 = deleted, 0 = a reply raced in).
      deleteCommentIfChildless: jest.fn(async () => deletedRows),
    };
    const pageRepo: any = {};
    const wsService: any = { emitCommentEvent: jest.fn() };
    const collaborationGateway: any = {
      handleYjsEvent: jest.fn(async () => verdict),
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

  // Pull the updateComment patch that carries the applied stamps.
  const appliedPatch = (commentRepo: any) =>
    commentRepo.updateComment.mock.calls
      .map((c: any[]) => c[0])
      .find((patch: any) => 'suggestionAppliedAt' in patch);

  // --- no replies → ephemeral delete branch -------------------------------

  it('applied=true, no replies → replaces text, hard-deletes, enqueues the anchor-mark removal, audits APPLIED, outcome=deleted', async () => {
    const {
      service,
      commentRepo,
      wsService,
      collaborationGateway,
      generalQueue,
      auditService,
    } = makeService({ applied: true, currentText: 'new text' });

    const result = await service.applySuggestion(suggestionComment(), user());

    // The atomic replace was requested against the exact marked text.
    expect(collaborationGateway.handleYjsEvent).toHaveBeenCalledWith(
      'applyCommentSuggestion',
      'page.page-1',
      expect.objectContaining({
        commentId: 'c-1',
        expectedText: 'old text',
        newText: 'new text',
        user: expect.objectContaining({ id: 'user-1' }),
      }),
    );

    // Ephemeral: the redundant comment is hard-deleted (atomic-conditional) and
    // its inline anchor mark removal is ENQUEUED (#399), no longer a sync gateway
    // call. The gateway was only touched for the applyCommentSuggestion text edit.
    expect(commentRepo.deleteCommentIfChildless).toHaveBeenCalledWith('c-1');
    const del = markJob(generalQueue, 'delete');
    expect(del).toBeDefined();
    expect(del[1]).toMatchObject({
      documentName: 'page.page-1',
      commentId: 'c-1',
      userId: 'user-1',
    });
    expect(collaborationGateway.handleYjsEvent).not.toHaveBeenCalledWith(
      'deleteCommentMark',
      expect.anything(),
      expect.anything(),
    );
    // No applied stamps are written for a row about to be deleted.
    expect(appliedPatch(commentRepo)).toBeUndefined();

    // Broadcast a deletion, audit the (still-applied) suggestion, report outcome.
    expect(wsService.emitCommentEvent).toHaveBeenCalledWith(
      'space-1',
      'page-1',
      expect.objectContaining({ operation: 'commentDeleted', commentId: 'c-1' }),
    );
    // #496: hard-deleted row → the audit payload is the only surviving record.
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: AuditEvent.COMMENT_SUGGESTION_APPLIED,
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

  it('applied=false but currentText === suggestedText, no replies → idempotent delete (no 409)', async () => {
    const { service, commentRepo, auditService } = makeService({
      applied: false,
      currentText: 'new text',
    });

    const result = await service.applySuggestion(suggestionComment(), user());

    expect(commentRepo.deleteCommentIfChildless).toHaveBeenCalledWith('c-1');
    expect(auditService.log).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('deleted');
  });

  // --- has replies → resolve branch (discussion preserved) ----------------

  it('applied=true, WITH replies → resolves (not delete), persists applied stamps, audits, outcome=resolved', async () => {
    const { service, commentRepo, wsService, collaborationGateway, auditService } =
      makeService({ applied: true, currentText: 'new text' }, true);

    const result = await service.applySuggestion(suggestionComment(), user());

    // Applied stamps persisted.
    const patch = appliedPatch(commentRepo);
    expect(patch.suggestionAppliedAt).toBeInstanceOf(Date);
    expect(patch.suggestionAppliedById).toBe('user-1');

    // Auto-resolved (resolveComment writes the resolve patch + resolve mark).
    const resolvePatch = commentRepo.updateComment.mock.calls
      .map((c: any[]) => c[0])
      .find((p: any) => 'resolvedAt' in p);
    expect(resolvePatch.resolvedAt).toBeInstanceOf(Date);
    expect(resolvePatch.resolvedById).toBe('user-1');

    // NOT deleted.
    expect(commentRepo.deleteComment).not.toHaveBeenCalled();
    expect(collaborationGateway.handleYjsEvent).not.toHaveBeenCalledWith(
      'deleteCommentMark',
      expect.anything(),
      expect.anything(),
    );
    // #496 dedup: resolveComment broadcasts `commentResolved` with the enriched
    // row; finalize must NOT ALSO emit a redundant `commentUpdated`. So the
    // thread receives exactly ONE resolve broadcast and no update broadcast.
    expect(wsService.emitCommentEvent).toHaveBeenCalledWith(
      'space-1',
      'page-1',
      expect.objectContaining({ operation: 'commentResolved', comment: UPDATED }),
    );
    expect(wsService.emitCommentEvent).not.toHaveBeenCalledWith(
      'space-1',
      'page-1',
      expect.objectContaining({ operation: 'commentUpdated' }),
    );

    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: AuditEvent.COMMENT_SUGGESTION_APPLIED,
      }),
    );
    expect(result.id).toBe('c-1');
    expect(result.outcome).toBe('resolved');
  });

  it('re-entry: already applied+resolved WITH replies → emits commentUpdated (dedup does not over-suppress)', async () => {
    // suggestionAppliedAt set → idempotent finalize; resolvedAt set → resolveComment
    // is skipped, so there is NO commentResolved broadcast. The applied-stamp state
    // must still reach clients via a single commentUpdated.
    const { service, wsService } = makeService(
      { applied: false, currentText: 'new text' },
      true,
    );

    await service.applySuggestion(
      suggestionComment({
        suggestionAppliedAt: new Date(),
        resolvedAt: new Date(),
      }),
      user(),
    );

    expect(wsService.emitCommentEvent).toHaveBeenCalledWith(
      'space-1',
      'page-1',
      expect.objectContaining({ operation: 'commentUpdated', comment: UPDATED }),
    );
    // Nothing resolved this time (already resolved) → no resolve broadcast.
    expect(wsService.emitCommentEvent).not.toHaveBeenCalledWith(
      'space-1',
      'page-1',
      expect.objectContaining({ operation: 'commentResolved' }),
    );
  });

  // --- error / rejection branches -----------------------------------------

  it('applied=false and currentText differs → ConflictException with currentText in payload', async () => {
    const { service, commentRepo, auditService } = makeService({
      applied: false,
      currentText: 'someone else edited this',
    });

    const err = await service
      .applySuggestion(suggestionComment(), user())
      .catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      currentText: 'someone else edited this',
    });
    // No delete and no audit on a conflict.
    expect(commentRepo.deleteComment).not.toHaveBeenCalled();
    expect(auditService.log).not.toHaveBeenCalled();
  });

  it('already-applied WITH replies → idempotent success, no re-apply, resolve branch', async () => {
    const { service, collaborationGateway, commentRepo, auditService } =
      makeService({ applied: true, currentText: 'new text' }, true);

    const result = await service.applySuggestion(
      suggestionComment({
        suggestionAppliedAt: new Date(),
        resolvedAt: new Date(),
        resolvedById: 'user-1',
      }),
      user(),
    );

    // Idempotent SUCCESS. The suggestion is already applied, so the document is
    // never re-mutated (no applyCommentSuggestion) and nothing is re-stamped.
    expect(collaborationGateway.handleYjsEvent).not.toHaveBeenCalledWith(
      'applyCommentSuggestion',
      expect.anything(),
      expect.anything(),
    );
    expect(appliedPatch(commentRepo)).toBeUndefined();
    expect(commentRepo.deleteComment).not.toHaveBeenCalled();
    expect(auditService.log).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('resolved');
  });

  it('already-applied, no replies (double-click after a delete) → deletes idempotently', async () => {
    const { service, collaborationGateway, commentRepo } = makeService({
      applied: true,
      currentText: 'new text',
    });

    const result = await service.applySuggestion(
      suggestionComment({ suggestionAppliedAt: new Date(), resolvedAt: null }),
      user(),
    );

    // No re-apply to the document; the childless applied comment is removed.
    expect(collaborationGateway.handleYjsEvent).not.toHaveBeenCalledWith(
      'applyCommentSuggestion',
      expect.anything(),
      expect.anything(),
    );
    expect(commentRepo.deleteCommentIfChildless).toHaveBeenCalledWith('c-1');
    expect(result.outcome).toBe('deleted');
  });

  it('applied=true, no replies at read time but a reply races in (conditional delete → 0 rows) → resolves instead, no hard-delete, outcome=resolved (#338 F1)', async () => {
    // The suggested text is already applied to the document, but between the
    // hasChildren read and the atomic delete a reply landed. The parent must NOT
    // be hard-deleted (cascade would destroy the reply); resolve the thread.
    const { service, commentRepo, wsService, generalQueue } =
      makeService({ applied: true, currentText: 'new text' }, false, 0);

    const result = await service.applySuggestion(suggestionComment(), user());

    expect(commentRepo.deleteCommentIfChildless).toHaveBeenCalledWith('c-1');
    // No deletion broadcast — the row + the racing reply survive.
    expect(wsService.emitCommentEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ operation: 'commentDeleted' }),
    );
    // Fell back to resolving.
    const resolvePatch = commentRepo.updateComment.mock.calls
      .map((c: any[]) => c[0])
      .find((p: any) => 'resolvedAt' in p);
    expect(resolvePatch.resolvedAt).toBeInstanceOf(Date);
    // The resolve mark is enqueued (#399), not a sync gateway call.
    expect(markJob(generalQueue, 'resolve')).toBeDefined();
    expect(result.outcome).toBe('resolved');
  });

  it('rejects a comment with no suggestedText', async () => {
    const { service, collaborationGateway } = makeService({
      applied: true,
      currentText: 'x',
    });

    await expect(
      service.applySuggestion(
        suggestionComment({ suggestedText: null }),
        user(),
      ),
    ).rejects.toThrow(BadRequestException);
    expect(collaborationGateway.handleYjsEvent).not.toHaveBeenCalled();
  });

  it('gateway returning undefined → hard error, not a silent success', async () => {
    const { service, commentRepo, auditService } = makeService(undefined);

    await expect(
      service.applySuggestion(suggestionComment(), user()),
    ).rejects.toThrow(InternalServerErrorException);

    // Nothing deleted, nothing audited.
    expect(commentRepo.deleteComment).not.toHaveBeenCalled();
    expect(auditService.log).not.toHaveBeenCalled();
  });
});
