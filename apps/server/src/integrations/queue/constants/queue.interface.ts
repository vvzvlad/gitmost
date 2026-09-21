import { MentionNode } from '../../../common/helpers/prosemirror/utils';

export interface IPageBacklinkJob {
  pageId: string;
  workspaceId: string;
  mentions: MentionNode[];
  internalLinkSlugIds?: string[];
}

export interface IAddPageWatchersJob {
  userIds: string[];
  pageId: string;
  spaceId: string;
  workspaceId: string;
}

export interface IStripeSeatsSyncJob {
  workspaceId: string;
}

export interface IPageHistoryJob {
  pageId: string;
  // #370 — intentionality tier the worker stamps on the snapshot. All jobs on
  // this queue are trailing idle-flush autosnapshots, so this is 'idle' (absent
  // → treated as 'idle' by the processor).
  kind?: 'idle';
}

/**
 * AI_QUEUE payload for a content change that should trigger a RAG reindex
 * (§6.7 stage D / §14[M1]). Produced by the collab persistence extension on
 * `onStoreDocument` and by the page-delete path (the delete case carries the
 * ids of pages whose embeddings must be purged).
 */
export interface IPageContentUpdatedJob {
  pageIds: string[];
  workspaceId: string;
}

/**
 * AI_QUEUE payload for workspace-wide RAG embedding jobs
 * (WORKSPACE_CREATE_EMBEDDINGS / WORKSPACE_DELETE_EMBEDDINGS).
 */
export interface IWorkspaceEmbeddingsJob {
  workspaceId: string;
}

export interface INotificationCreateJob {
  userId: string;
  workspaceId: string;
  type: string;
  actorId?: string;
  pageId?: string;
  spaceId?: string;
  commentId?: string;
  data?: Record<string, unknown>;
}

export interface ICommentNotificationJob {
  commentId: string;
  parentCommentId?: string;
  pageId: string;
  spaceId: string;
  workspaceId: string;
  actorId: string;
  mentionedUserIds: string[];
  notifyWatchers: boolean;
}

/**
 * GENERAL_QUEUE payload for the off-critical-path comment inline-mark mirror
 * (#399). The comment DB row is the source of truth and is already updated
 * synchronously (ms); this job flips/removes the inline `comment` mark in the
 * collaborative Y.Doc for connected clients, OFF the HTTP response path, so
 * `POST /api/comments/resolve` no longer waits the whole Y.Doc load + store
 * pipeline (was ~4.5s p95). The mark op is idempotent, so BullMQ retries are
 * safe.
 *
 * `action`:
 *   - 'resolve' / 'unresolve' → flip the mark's `resolved` attribute (exactly
 *     what the synchronous resolveCommentMark path did);
 *   - 'delete' → strip the anchor mark entirely (ephemeral suggestion #329).
 * `ts` is the DB-mutation timestamp (ms). The worker's race-guard uses it (with
 * the row's authoritative resolved state) to skip a resolve/unresolve event
 * that a newer, opposite event has already superseded (out-of-order drain).
 * `userId` supplies the connection-context user the store pipeline attributes
 * the change to (persistence.extension reads context.user.id).
 */
export interface ICommentMarkUpdateJob {
  documentName: string;
  commentId: string;
  action: 'resolve' | 'unresolve' | 'delete';
  ts: number;
  userId: string;
}

export interface ICommentResolvedNotificationJob {
  commentId: string;
  commentCreatorId: string;
  pageId: string;
  spaceId: string;
  workspaceId: string;
  actorId: string;
}

export interface IPageMentionNotificationJob {
  userMentions: { userId: string; mentionId: string; creatorId: string }[];
  oldMentionedUserIds: string[];
  pageId: string;
  spaceId: string;
  workspaceId: string;
}

export interface IPageUpdateNotificationJob {
  pageId: string;
  spaceId: string;
  workspaceId: string;
  actorIds: string[];
}

export interface IPermissionGrantedNotificationJob {
  userIds: string[];
  pageId: string;
  spaceId: string;
  workspaceId: string;
  actorId: string;
  role: string;
}

export interface IVerificationExpiringNotificationJob {
  verificationId: string;
}

export interface IVerificationExpiredNotificationJob {
  verificationId: string;
}

export interface IVerificationReconcileJob {
  // no payload
}

export interface IPageVerifiedNotificationJob {
  pageId: string;
  spaceId: string;
  workspaceId: string;
  actorId: string;
  verifierIds: string[];
}

export interface IApprovalRequestedNotificationJob {
  pageId: string;
  spaceId: string;
  workspaceId: string;
  actorId: string;
  verifierIds: string[];
}

export interface IApprovalRejectedNotificationJob {
  pageId: string;
  spaceId: string;
  workspaceId: string;
  actorId: string;
  requestedById: string;
  comment?: string;
}
