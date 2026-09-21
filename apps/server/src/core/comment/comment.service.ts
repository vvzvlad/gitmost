import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { CreateCommentDto, yjsSelectionSchema } from './dto/create-comment.dto';
import { CollaborationGateway } from '../../collaboration/collaboration.gateway';
import { UpdateCommentDto } from './dto/update-comment.dto';
import { CommentRepo } from '@docmost/db/repos/comment/comment.repo';
import { Comment, Page, User } from '@docmost/db/types/entity.types';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { CursorPaginationResult } from '@docmost/db/pagination/cursor-pagination';
import { QueueJob, QueueName } from '../../integrations/queue/constants';
import { extractUserMentionIdsFromJson } from '../../common/helpers/prosemirror/utils';
import {
  ICommentMarkUpdateJob,
  ICommentNotificationJob,
  ICommentResolvedNotificationJob,
} from '../../integrations/queue/constants/queue.interface';
import { WsService } from '../../ws/ws.service';
import {
  AuthProvenanceData,
  agentSourceFields,
} from '../../common/decorators/auth-provenance.decorator';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';

// Ephemeral-suggestion settle result (#329): 'deleted' → the comment vanished
// (hard-delete + anchor mark stripped); 'resolved' → the thread had replies and
// was resolved instead. Returned to the client so it can pick the optimistic
// cache action.
export type SuggestionOutcome = 'deleted' | 'resolved';

@Injectable()
export class CommentService {
  private readonly logger = new Logger(CommentService.name);

  constructor(
    private commentRepo: CommentRepo,
    private pageRepo: PageRepo,
    private wsService: WsService,
    private collaborationGateway: CollaborationGateway,
    @InjectQueue(QueueName.GENERAL_QUEUE)
    private generalQueue: Queue,
    @InjectQueue(QueueName.NOTIFICATION_QUEUE)
    private notificationQueue: Queue,
    @Inject(AUDIT_SERVICE) private auditService: IAuditService,
  ) {}

  async findById(commentId: string) {
    const comment = await this.commentRepo.findById(commentId, {
      includeCreator: true,
      includeResolvedBy: true,
    });
    if (!comment) {
      throw new NotFoundException('Comment not found');
    }
    return comment;
  }

  async create(
    opts: { page: Page; workspaceId: string; user: User },
    createCommentDto: CreateCommentDto,
    // Optional agent-edit provenance (from the signed access claim). When the
    // actor is 'agent', stamp created_source/ai_chat_id so an agent-authored
    // comment (incl. a reply) shows the AI marker (§15 C3). Normal user: default.
    provenance?: AuthProvenanceData,
  ) {
    const { page, workspaceId, user } = opts;
    const commentContent = JSON.parse(createCommentDto.content);

    if (createCommentDto.parentCommentId) {
      const parentComment = await this.commentRepo.findById(
        createCommentDto.parentCommentId,
      );

      if (!parentComment || parentComment.pageId !== page.id) {
        throw new BadRequestException('Parent comment not found');
      }

      if (parentComment.parentCommentId !== null) {
        throw new BadRequestException('You cannot reply to a reply');
      }
    }

    // Do NOT lossily truncate at 250: for a suggestion the client sends the RAW
    // anchored document substring (the exact text under the comment mark) as the
    // selection, which can be LONGER than the agent's <=250-char typed input
    // (normalization collapses whitespace/typographic runs, so the raw span can
    // exceed the normalized selection). Truncating it shorter than the mark span
    // would break the apply-time equality check and make the suggestion
    // un-appliable. Keep a generous 2000-char safety bound (matching
    // suggestedText) so a legitimate anchored substring is never cut.
    const selection = createCommentDto?.selection?.substring(0, 2000) ?? null;

    // A suggested edit rewrites the exact text under an inline comment mark, so
    // it is only meaningful on a top-level inline comment that carries a
    // selection, and only if the suggestion actually changes that text.
    let suggestedText: string | null = null;
    if (
      createCommentDto.suggestedText !== undefined &&
      createCommentDto.suggestedText !== null
    ) {
      if (createCommentDto.parentCommentId) {
        throw new BadRequestException(
          'A suggested edit can only be attached to a top-level comment, not a reply',
        );
      }
      if (!selection || selection.trim().length === 0) {
        throw new BadRequestException(
          'A suggested edit requires an inline comment with a non-empty text selection',
        );
      }
      const trimmed = createCommentDto.suggestedText.trim();
      if (trimmed.length === 0) {
        throw new BadRequestException('A suggested edit cannot be empty');
      }
      // A no-op suggestion (identical to the selection) is meaningless and would
      // make "apply" indistinguishable from "already applied".
      if (trimmed === selection.trim()) {
        throw new BadRequestException(
          'A suggested edit must differ from the selected text',
        );
      }
      suggestedText = trimmed;
    }

    const inserted = await this.commentRepo.insertComment({
      pageId: page.id,
      content: commentContent,
      selection,
      type: createCommentDto.type ?? 'page',
      parentCommentId: createCommentDto?.parentCommentId,
      creatorId: user.id,
      workspaceId: workspaceId,
      spaceId: page.spaceId,
      suggestedText,
      // Agent-edit provenance: the user stays creatorId; this only annotates the
      // source. Normal user requests leave the column default ('user'). #559 —
      // an external-MCP (api_key) comment also stamps created_api_key_id so it
      // shows the "External MCP" persona named after the key.
      ...agentSourceFields(
        provenance,
        'createdSource',
        'aiChatId',
        'createdApiKeyId',
      ),
    });

    if (createCommentDto.yjsSelection) {
      const parsed = yjsSelectionSchema.safeParse(
        createCommentDto.yjsSelection,
      );
      if (!parsed.success) {
        this.logger.warn(
          `Invalid yjsSelection for comment ${inserted.id}: ${parsed.error.message}`,
        );
      } else {
        const documentName = `page.${page.id}`;
        try {
          await this.collaborationGateway.handleYjsEvent(
            'setCommentMark',
            documentName,
            {
              yjsSelection: parsed.data,
              commentId: inserted.id,
              resolved: false,
              user,
            },
          );
        } catch (error) {
          this.logger.warn(
            `Failed to apply comment mark for comment ${inserted.id}, comment saved without inline highlight`,
            error,
          );
        }
      }
    }

    const comment = await this.commentRepo.findById(inserted.id, {
      includeCreator: true,
      includeResolvedBy: true,
    });

    this.generalQueue
      .add(QueueJob.ADD_PAGE_WATCHERS, {
        userIds: [user.id],
        pageId: page.id,
        spaceId: page.spaceId,
        workspaceId,
      })
      .catch((err) =>
        this.logger.warn(`Failed to queue add-page-watchers: ${err.message}`),
      );

    const isReply = !!createCommentDto.parentCommentId;

    await this.queueCommentNotification(
      commentContent,
      [],
      comment.id,
      page.id,
      page.spaceId,
      workspaceId,
      user.id,
      !isReply,
      createCommentDto.parentCommentId,
    );

    this.wsService.emitCommentEvent(page.spaceId, page.id, {
      operation: 'commentCreated',
      pageId: page.id,
      comment,
    });

    return comment;
  }

  async findByPageId(
    pageId: string,
    pagination: PaginationOptions,
  ): Promise<CursorPaginationResult<Comment>> {
    const page = await this.pageRepo.findById(pageId);

    if (!page) {
      throw new BadRequestException('Page not found');
    }

    return this.commentRepo.findPageComments(pageId, pagination);
  }

  async update(
    comment: Comment,
    updateCommentDto: UpdateCommentDto,
    authUser: User,
  ): Promise<Comment> {
    const commentContent = JSON.parse(updateCommentDto.content);

    if (comment.creatorId !== authUser.id) {
      throw new ForbiddenException('You can only edit your own comments');
    }

    const oldMentionIds = extractUserMentionIdsFromJson(comment.content);

    const editedAt = new Date();

    await this.commentRepo.updateComment(
      {
        content: commentContent,
        editedAt: editedAt,
        updatedAt: editedAt,
      },
      comment.id,
    );

    await this.queueCommentNotification(
      commentContent,
      oldMentionIds,
      comment.id,
      comment.pageId,
      comment.spaceId,
      comment.workspaceId,
      authUser.id,
      false,
    );

    // Re-fetch the enriched comment before broadcasting, symmetric with
    // create()/resolveComment(). updateComment() above has already persisted the
    // new content/timestamps, so this single-row read reflects the edit AND
    // carries the same {agent,launcher} avatar stack (via includeCreator) as the
    // other two broadcasts. This deliberately does NOT reuse the caller's
    // pre-loaded `comment`: relying on the controller happening to load it with
    // includeCreator:true is exactly the fragile coupling that let the agent
    // stack silently vanish on edit once already (#300/#304) — a future caller
    // dropping that flag must not regress the broadcast.
    const updatedComment = await this.commentRepo.findById(comment.id, {
      includeCreator: true,
      includeResolvedBy: true,
    });

    this.wsService.emitCommentEvent(comment.spaceId, comment.pageId, {
      operation: 'commentUpdated',
      pageId: comment.pageId,
      comment: updatedComment,
    });

    return updatedComment;
  }

  async resolveComment(
    comment: Comment,
    resolved: boolean,
    authUser: User,
    // Optional agent-edit provenance (from the signed access claim). When the
    // actor is 'agent' and the thread is being resolved, stamp resolved_source
    // so the "resolved by" mark shows the AI marker (§15 C3). On unresolve the
    // source is cleared alongside resolvedAt/resolvedById.
    provenance?: AuthProvenanceData,
  ): Promise<Comment> {
    // One shared timestamp: it stamps resolvedAt AND updatedAt on the row and is
    // carried as the mark job's `ts`, so the worker's race-guard can order this
    // event against the row's authoritative resolve-state mutation time (#399).
    const now = new Date();
    const resolvedAt = resolved ? now : null;
    const resolvedById = resolved ? authUser.id : null;
    const isAgent = provenance?.actor === 'agent';
    // Set the agent marker only when resolving; on unresolve clear it back to
    // null so a reopened thread carries no stale source. A normal user resolve
    // leaves resolved_source null (no agent annotation).
    const resolvedSource = resolved && isAgent ? 'agent' : null;

    await this.commentRepo.updateComment(
      // Bump updatedAt (not editedAt — that drives the "edited" badge) so the
      // row records WHEN the resolve state last changed; the async mark worker
      // compares its job ts against this to skip a superseded out-of-order event.
      { resolvedAt, resolvedById, resolvedSource, updatedAt: now },
      comment.id,
    );

    // #399: mirror the resolved state onto the inline comment mark OFF the HTTP
    // critical path. The DB row above is the source of truth (updated in ms); the
    // mark is an eventual mirror for connected clients, and its failure was
    // ALREADY swallowed (best-effort warn) — so instead of awaiting the whole
    // Y.Doc load + immediate store pipeline (~4.5s p95), enqueue an idempotent,
    // retryable COMMENT_MARK_UPDATE job. (Store-pipeline cost itself is #348's
    // scope, not duplicated here.)
    const documentName = `page.${comment.pageId}`;
    void this.enqueueCommentMarkUpdate(
      documentName,
      comment.id,
      resolved ? 'resolve' : 'unresolve',
      now.getTime(),
      authUser.id,
    ).catch((error) =>
      this.logger.warn(
        `Failed to enqueue comment mark update for comment ${comment.id}`,
        error,
      ),
    );

    // Notify the comment author when someone else resolves their comment.
    if (resolved && comment.creatorId !== authUser.id) {
      const jobData: ICommentResolvedNotificationJob = {
        commentId: comment.id,
        commentCreatorId: comment.creatorId,
        pageId: comment.pageId,
        spaceId: comment.spaceId,
        workspaceId: comment.workspaceId,
        actorId: authUser.id,
      };
      await this.notificationQueue.add(
        QueueJob.COMMENT_RESOLVED_NOTIFICATION,
        jobData,
      );
    }

    const updatedComment = await this.commentRepo.findById(comment.id, {
      includeCreator: true,
      includeResolvedBy: true,
    });

    this.wsService.emitCommentEvent(comment.spaceId, comment.pageId, {
      operation: 'commentResolved',
      pageId: comment.pageId,
      comment: updatedComment,
    });

    return updatedComment;
  }

  /**
   * Re-sync a suggestion's stored `selection` (== apply-time expectedText) to the
   * RAW substring the inline mark actually covers in the LIVE document (#496).
   *
   * The MCP client creates the comment from a DEBOUNCED REST snapshot, then
   * anchors the mark in the live collab doc. When the two disagree (the doc moved
   * on in the debounce window) the stored selection no longer equals the marked
   * text, so EVERY apply 409s ("the commented text changed"). After anchoring the
   * client re-reads the exact marked substring and calls this to store it, making
   * apply's strict equality hold.
   *
   * Only meaningful for an un-settled top-level suggestion authored by the
   * caller: applying/resolving freezes the anchor, and a reply-carrying thread is
   * preserved rather than mutated. The new text must still differ from the
   * suggestion (else "apply" would be a no-op), preserving create()'s invariant.
   */
  async resyncSuggestionAnchor(
    comment: Comment,
    selection: string,
    user: User,
  ): Promise<Comment> {
    if (comment.creatorId !== user.id) {
      throw new ForbiddenException(
        'You can only re-anchor your own suggestion',
      );
    }
    if (comment.parentCommentId) {
      throw new BadRequestException(
        'Only a top-level comment can carry a suggested edit',
      );
    }
    if (!comment.suggestedText) {
      throw new BadRequestException('This comment has no suggested edit');
    }
    // A settled suggestion's anchor is frozen: re-anchoring an applied/resolved
    // thread is meaningless and could resurrect a stale expectedText.
    if (comment.suggestionAppliedAt || comment.resolvedAt) {
      throw new BadRequestException(
        'Cannot re-anchor a suggestion that was already applied or resolved',
      );
    }
    const trimmed = selection.trim();
    if (trimmed.length === 0) {
      throw new BadRequestException(
        'The re-anchored selection cannot be empty',
      );
    }
    // Same no-op guard as create(): the suggestion must differ from the text it
    // replaces, or apply becomes indistinguishable from already-applied.
    if (trimmed === comment.suggestedText.trim()) {
      throw new BadRequestException(
        'A suggested edit must differ from the selected text',
      );
    }

    // Idempotent: nothing to persist when the anchor already matches.
    if (comment.selection === selection) {
      return comment;
    }

    await this.commentRepo.updateComment({ selection }, comment.id);

    const updatedComment = await this.commentRepo.findById(comment.id, {
      includeCreator: true,
      includeResolvedBy: true,
    });

    // Re-anchoring only corrects stored metadata; it does not change the page
    // text or the comment body, so no ws broadcast / notification is warranted.
    return updatedComment;
  }

  /**
   * Apply the suggested edit carried by a top-level inline comment: atomically
   * replace the text under the comment mark in the collaborative document with
   * the comment's suggestedText, then stamp the applied fields and auto-resolve
   * the thread. The controller authorizes (validateCanEdit); this re-checks the
   * comment's own state so the invariant holds regardless of caller.
   */
  async applySuggestion(
    comment: Comment,
    user: User,
    provenance?: AuthProvenanceData,
  ): Promise<Comment & { outcome: SuggestionOutcome }> {
    // Structural guards.
    if (comment.parentCommentId) {
      throw new BadRequestException(
        'Only a top-level comment can carry a suggested edit',
      );
    }
    if (!comment.suggestedText) {
      throw new BadRequestException(
        'This comment has no suggested edit to apply',
      );
    }
    // State guards. Order matters — the already-applied check precedes the
    // resolved check because an applied comment is normally also resolved.
    //
    // Already applied → IDEMPOTENT SUCCESS (issue #315 DoD: double-click /
    // two-user race → idempotent "already applied", NOT a 409). The suggestion
    // is already in the document, so do NOT call the collab gateway again.
    // finalizeAppliedSuggestion re-fetches/broadcasts the same success shape as
    // the applied branch and, when the thread is still open (the rare "applied
    // but not resolved" crash window), self-heals it via resolveComment.
    if (comment.suggestionAppliedAt) {
      return this.finalizeAppliedSuggestion(comment, user, provenance);
    }
    // Not-yet-applied on a resolved thread → reject. The client hides the apply
    // button once a thread is resolved; this is the defensive server check.
    if (comment.resolvedAt) {
      throw new BadRequestException(
        'Cannot apply a suggested edit on a resolved comment thread',
      );
    }

    // Derive the document name the same way create()/resolveComment() do for
    // the comment marks: `page.${pageId}`.
    const documentName = `page.${comment.pageId}`;

    let verdict: { applied: boolean; currentText: string | null } | undefined;
    try {
      verdict = await this.collaborationGateway.handleYjsEvent(
        'applyCommentSuggestion',
        documentName,
        {
          commentId: comment.id,
          expectedText: comment.selection,
          newText: comment.suggestedText,
          user,
        },
      );
    } catch (error) {
      // A throwing gateway (or the phase-3 fallback failing) is a hard error —
      // never silently succeed, the document may or may not have changed.
      this.logger.error(
        `Failed to apply suggested edit for comment ${comment.id}`,
        error,
      );
      throw new InternalServerErrorException(
        'Failed to apply the suggested edit',
      );
    }

    if (!verdict) {
      // Should not happen given the phase-3 fallback; treat as a hard error
      // rather than assuming success.
      throw new InternalServerErrorException(
        'Failed to apply the suggested edit',
      );
    }

    if (verdict.applied === true) {
      return this.finalizeAppliedSuggestion(comment, user, provenance);
    }

    // Idempotent branch: the mutation didn't run now, but the text under the
    // mark is ALREADY the suggested text (double-click, two-user race, or a
    // crash between the doc mutation and the DB write). Reconcile the DB /
    // resolved state and report success — do NOT 409.
    if (
      verdict.applied === false &&
      verdict.currentText === comment.suggestedText
    ) {
      return this.finalizeAppliedSuggestion(comment, user, provenance);
    }

    // The commented text changed since the suggestion was made. Surface the
    // current text so the client can tell the user what it is now.
    throw new ConflictException({
      message:
        'The commented text changed since this suggestion was made; it was not applied.',
      currentText: verdict.currentText,
    });
  }

  /**
   * Dismiss ("Не применять") a suggested edit without touching the page text:
   * the suggestion disappears. Ephemeral rule (#329) — a top-level suggestion
   * comment is transient UI, so dismissing it hard-deletes the comment AND strips
   * its inline anchor mark UNLESS the thread has replies, in which case the
   * discussion is preserved by resolving it instead.
   *
   * Dismiss does NOT change the document text, so the controller authorizes it
   * with canComment (NOT canEdit). This re-checks the comment's own state so the
   * invariant holds regardless of caller.
   */
  async dismissSuggestion(
    comment: Comment,
    user: User,
    provenance?: AuthProvenanceData,
  ): Promise<Comment & { outcome: SuggestionOutcome }> {
    // Structural guards (mirror applySuggestion).
    if (comment.parentCommentId) {
      throw new BadRequestException(
        'Only a top-level comment can carry a suggested edit',
      );
    }
    if (!comment.suggestedText) {
      throw new BadRequestException(
        'This comment has no suggested edit to dismiss',
      );
    }
    // State guards: dismissing an already-applied or already-resolved thread is
    // meaningless. On an apply↔dismiss race the loser sees the comment already
    // gone (404 at the controller) or already resolved (this 400); the client
    // treats both as "already resolved".
    if (comment.suggestionAppliedAt) {
      throw new BadRequestException(
        'Cannot dismiss a suggested edit that was already applied',
      );
    }
    if (comment.resolvedAt) {
      throw new BadRequestException(
        'Cannot dismiss a suggested edit on a resolved comment thread',
      );
    }

    const hasChildren = await this.commentRepo.hasChildren(comment.id);

    if (hasChildren) {
      // Preserve the discussion: resolve (never delete) a thread with replies.
      const updatedComment = await this.resolveComment(
        comment,
        true,
        user,
        provenance,
      );
      this.auditService.log({
        event: AuditEvent.COMMENT_SUGGESTION_DISMISSED,
        resourceType: AuditResource.COMMENT,
        resourceId: comment.id,
        spaceId: comment.spaceId,
        metadata: this.suggestionAuditMetadata(comment, user),
      });
      return { ...updatedComment, outcome: 'resolved' };
    }

    // Ephemeral: no replies → the suggestion vanishes entirely. The atomic
    // conditional delete may still fall back to a resolve if a reply raced in
    // (see deleteEphemeralSuggestion), so the outcome is whatever it settled on.
    const settled = await this.deleteEphemeralSuggestion(
      comment,
      user,
      provenance,
    );
    this.auditService.log({
      event: AuditEvent.COMMENT_SUGGESTION_DISMISSED,
      resourceType: AuditResource.COMMENT,
      resourceId: comment.id,
      spaceId: comment.spaceId,
      metadata: this.suggestionAuditMetadata(comment, user),
    });
    return settled;
  }

  /**
   * Persist the applied stamps (idempotently), then settle the suggestion under
   * the ephemeral rule (#329): a suggestion whose thread has NO replies
   * DISAPPEARS after apply (hard-delete + strip the inline anchor mark), since
   * the suggested text is now in the document and a stand-alone resolved thread
   * would only pile up an orphan anchor. A thread WITH replies is preserved by
   * auto-resolving it (the historical behaviour). Shared by the applied and the
   * idempotent "already-applied" branches of applySuggestion.
   *
   * Returns the comment augmented with `outcome` so the client can pick the
   * optimistic action ('deleted' → drop it, 'resolved' → move to the resolved
   * tab).
   */
  private async finalizeAppliedSuggestion(
    comment: Comment,
    user: User,
    provenance?: AuthProvenanceData,
  ): Promise<Comment & { outcome: SuggestionOutcome }> {
    const hasChildren = await this.commentRepo.hasChildren(comment.id);

    if (hasChildren) {
      // Thread has replies → preserve the discussion: stamp applied + resolve.
      if (!comment.suggestionAppliedAt) {
        await this.commentRepo.updateComment(
          {
            suggestionAppliedAt: new Date(),
            suggestionAppliedById: user.id,
          },
          comment.id,
        );
      }

      // Auto-resolve the thread. resolveComment handles the resolve mark, its ws
      // broadcast and the resolve notification. Stay defensive on re-entry.
      let didResolveBroadcast = false;
      if (!comment.resolvedAt) {
        await this.resolveComment(comment, true, user, provenance);
        didResolveBroadcast = true;
      }

      const updatedComment = await this.commentRepo.findById(comment.id, {
        includeCreator: true,
        includeResolvedBy: true,
      });

      // #496 dedup: resolveComment already broadcast `commentResolved` carrying
      // the fully-enriched row (the applied stamps were persisted above, before
      // that call, so its re-read reflects them). Emitting `commentUpdated` here
      // too made the client receive TWO events for one apply. Broadcast the
      // update ONLY when we did NOT resolve — i.e. the rare re-entry on an
      // already-resolved thread, where the applied-stamp change still needs a
      // broadcast and resolveComment did not run.
      if (!didResolveBroadcast) {
        this.wsService.emitCommentEvent(comment.spaceId, comment.pageId, {
          operation: 'commentUpdated',
          pageId: comment.pageId,
          comment: updatedComment,
        });
      }

      this.auditService.log({
        event: AuditEvent.COMMENT_SUGGESTION_APPLIED,
        resourceType: AuditResource.COMMENT,
        resourceId: comment.id,
        spaceId: comment.spaceId,
        metadata: this.suggestionAuditMetadata(comment, user),
      });

      return { ...updatedComment, outcome: 'resolved' };
    }

    // No replies → ephemeral: the suggested text is already in the document, so
    // the comment is redundant. Hard-delete it and strip its inline anchor. We
    // deliberately do NOT write the applied stamps first (the row is about to be
    // deleted); the audit event still records that the suggestion was applied.
    // The delete is atomic-conditional: if a reply raced in after the
    // hasChildren read, it falls back to resolving instead (outcome 'resolved').
    const settled = await this.deleteEphemeralSuggestion(
      comment,
      user,
      provenance,
    );

    this.auditService.log({
      event: AuditEvent.COMMENT_SUGGESTION_APPLIED,
      resourceType: AuditResource.COMMENT,
      resourceId: comment.id,
      spaceId: comment.spaceId,
      metadata: this.suggestionAuditMetadata(comment, user),
    });

    return settled;
  }

  /**
   * Settle an ephemeral suggestion whose thread looked childless: remove its
   * inline `comment` anchor mark, then ATOMICALLY hard-delete the row only if it
   * is still childless. Shared by the apply/dismiss no-replies branches (#329).
   *
   * ORDER MATTERS (updated #399 → #496): what runs FIRST and FATALLY here is the
   * mark-removal ENQUEUE (a fast, durable Redis add), NOT the mark op itself.
   * deleteCommentMark awaits only the enqueue, so a failed add throws BEFORE the
   * irreversible row delete — the row + mark stay consistent and the operation is
   * repeatable. The actual anchor strip then runs off the HTTP path in the worker
   * (idempotent, 3 retries). Only an EXHAUSTED-retries job could leave the doc
   * with an orphan anchor pointing at a hard-deleted comment (the data-integrity
   * bug #329 targets); that residual divergence is now self-healed by the
   * resolve/unresolve mark worker, which strips an orphan mark whenever its
   * comment row is gone (#496), and it is meanwhile VISIBLE via BullMQ failed-job
   * metrics rather than a silently-swallowed warn.
   *
   * RACE (#338 F4): the caller read `hasChildren` BEFORE the (slow) mark
   * removal, so a reply can land in that window. `comments.parent_comment_id` is
   * ON DELETE CASCADE, so an unconditional delete here would cascade-destroy the
   * just-added reply forever. Instead we use `deleteCommentIfChildless`, which
   * re-checks childlessness under a FOR UPDATE lock inside a transaction (a plain
   * anti-join DELETE is NOT race-safe under READ COMMITTED — see the repo method
   * docstring). If it removes the row (outcome 'deleted') we broadcast the
   * deletion as before. If it removes 0 rows (a reply interleaved) we do NOT
   * hard-delete — we resolve the thread instead (outcome 'resolved'), preserving
   * the discussion and the new reply. The anchor mark is already gone by then, an
   * accepted degradation: the thread lands in the resolved tab without its inline
   * highlight — far better than losing a reply.
   */
  private async deleteEphemeralSuggestion(
    comment: Comment,
    user: User,
    provenance?: AuthProvenanceData,
  ): Promise<Comment & { outcome: SuggestionOutcome }> {
    await this.deleteCommentMark(comment, user);

    const deletedRows = await this.commentRepo.deleteCommentIfChildless(
      comment.id,
    );

    if (deletedRows > 0) {
      this.wsService.emitCommentEvent(comment.spaceId, comment.pageId, {
        operation: 'commentDeleted',
        pageId: comment.pageId,
        commentId: comment.id,
      });
      return { ...comment, outcome: 'deleted' };
    }

    // A reply interleaved between the hasChildren read and this delete, so the
    // conditional delete matched nothing. Preserve the discussion + the new
    // reply by resolving the thread instead of hard-deleting it. resolveComment
    // handles the resolve patch, its ws broadcast and the resolve notification;
    // its collab call is best-effort, so the already-stripped mark is fine.
    const resolvedComment = await this.resolveComment(
      comment,
      true,
      user,
      provenance,
    );
    return { ...resolvedComment, outcome: 'resolved' };
  }

  /**
   * Schedule removal of the inline `comment` anchor mark from the collaborative
   * document (ephemeral suggestion #329), OFF the HTTP critical path (#399).
   *
   * ORDERING PRESERVED: we `await` the ENQUEUE (a fast Redis add), not the mark
   * op, and the caller only proceeds to the irreversible row hard-delete after
   * this resolves. So the anchor-removal job is DURABLY queued before the row
   * vanishes — a queue-add failure throws here and aborts the delete (row + mark
   * stay consistent), preserving the invariant the old FATAL sync call gave. The
   * mark op itself now runs async in the worker: it is idempotent and retried
   * (3 attempts), so a transient collab failure self-heals; only an exhausted-
   * retries job leaves a DB↔mark divergence, now VISIBLE via BullMQ failed-job
   * metrics (was a hard 5xx before). Delete carries no state guard — the row is
   * being removed, and stripping an absent mark is a no-op.
   */
  private async deleteCommentMark(comment: Comment, user: User): Promise<void> {
    const documentName = `page.${comment.pageId}`;
    await this.enqueueCommentMarkUpdate(
      documentName,
      comment.id,
      'delete',
      Date.now(),
      user.id,
    );
  }

  /**
   * Enqueue an idempotent COMMENT_MARK_UPDATE job (#399) — the single path that
   * mirrors a comment's inline-mark state into the collab Y.Doc off the HTTP
   * response. The worker (GeneralQueueProcessor) runs the SAME handleYjsEvent
   * the sync code used, so the mark op is byte-identical.
   */
  private enqueueCommentMarkUpdate(
    documentName: string,
    commentId: string,
    action: 'resolve' | 'unresolve' | 'delete',
    ts: number,
    userId: string,
  ): Promise<unknown> {
    const jobData: ICommentMarkUpdateJob = {
      documentName,
      commentId,
      action,
      ts,
      userId,
    };
    return this.generalQueue.add(QueueJob.COMMENT_MARK_UPDATE, jobData);
  }

  /**
   * Build the audit metadata for a suggestion apply/dismiss decision (#496).
   * The subject comment is HARD-DELETED on the childless path, so the audit row
   * is the only surviving record — capture the decision's substance (what was
   * suggested, the anchored text it replaced, who authored it, who decided)
   * before the row can vanish. `decidedBy` is the acting user; `commentAuthor`
   * is the suggestion's creator.
   */
  private suggestionAuditMetadata(
    comment: Comment,
    user: User,
  ): Record<string, any> {
    return {
      pageId: comment.pageId,
      suggestedText: comment.suggestedText ?? null,
      selection: comment.selection ?? null,
      commentAuthor: comment.creatorId ?? null,
      decidedBy: user.id,
    };
  }

  private async queueCommentNotification(
    content: any,
    oldMentionIds: string[],
    commentId: string,
    pageId: string,
    spaceId: string,
    workspaceId: string,
    actorId: string,
    notifyWatchers: boolean,
    parentCommentId?: string,
  ) {
    const mentionedUserIds = extractUserMentionIdsFromJson(content);
    const newMentionIds = mentionedUserIds.filter(
      (id) => id !== actorId && !oldMentionIds.includes(id),
    );

    if (newMentionIds.length === 0 && !notifyWatchers && !parentCommentId)
      return;

    const jobData: ICommentNotificationJob = {
      commentId,
      parentCommentId,
      pageId,
      spaceId,
      workspaceId,
      actorId,
      mentionedUserIds: newMentionIds,
      notifyWatchers,
    };

    await this.notificationQueue.add(QueueJob.COMMENT_NOTIFICATION, jobData);
  }
}
