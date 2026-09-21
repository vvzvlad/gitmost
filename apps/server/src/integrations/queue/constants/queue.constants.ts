export enum QueueName {
  EMAIL_QUEUE = '{email-queue}',
  ATTACHMENT_QUEUE = '{attachment-queue}',
  GENERAL_QUEUE = '{general-queue}',
  BILLING_QUEUE = '{billing-queue}',
  FILE_TASK_QUEUE = '{file-task-queue}',
  AI_QUEUE = '{ai-queue}',
  HISTORY_QUEUE = '{history-queue}',
  NOTIFICATION_QUEUE = '{notification-queue}',
  AUDIT_QUEUE = '{audit-queue}',
}

export enum QueueJob {
  SEND_EMAIL = 'send-email',
  DELETE_SPACE_ATTACHMENTS = 'delete-space-attachments',
  ATTACHMENT_INDEX_CONTENT = 'attachment-index-content',
  ATTACHMENT_INDEXING = 'attachment-indexing',
  DELETE_PAGE_ATTACHMENTS = 'delete-page-attachments',
  DELETE_AI_CHAT_ATTACHMENTS = 'delete-ai-chat-attachments',

  DELETE_USER_AVATARS = 'delete-user-avatars',

  PAGE_BACKLINKS = 'page-backlinks',
  ADD_PAGE_WATCHERS = 'add-page-watchers',

  STRIPE_SEATS_SYNC = 'sync-stripe-seats',
  TRIAL_ENDED = 'trial-ended',
  WELCOME_EMAIL = 'welcome-email',
  FIRST_PAYMENT_EMAIL = 'first-payment-email',

  IMPORT_TASK = 'import-task',
  EXPORT_TASK = 'export-task',

  TYPESENSE_FLUSH = 'typesense-flush',

  PAGE_CREATED = 'page-created',
  PAGE_CONTENT_UPDATED = 'page-content-updated',
  PAGE_MOVED_TO_SPACE = 'page-moved-to-space',
  PAGE_UPDATED = 'page-updated',
  PAGE_SOFT_DELETED = 'page-soft-deleted',
  PAGE_RESTORED = 'page-restored',
  PAGE_DELETED = 'page-deleted',

  SPACE_CREATED = 'space-created',
  SPACE_UPDATED = 'space-updated',
  SPACE_DELETED = 'space-deleted',

  WORKSPACE_CREATED = 'workspace-created',
  WORKSPACE_SPACE_UPDATED = 'workspace-updated',
  WORKSPACE_DELETED = 'workspace-deleted',
  WORKSPACE_CREATE_EMBEDDINGS = 'workspace-create-embeddings',
  WORKSPACE_DELETE_EMBEDDINGS = 'workspace-delete-embeddings',

  GENERATE_PAGE_EMBEDDINGS = 'generate-page-embeddings',
  DELETE_PAGE_EMBEDDINGS = 'delete-page-embeddings',

  PAGE_HISTORY = 'page-history',

  COMMENT_NOTIFICATION = 'comment-notification',
  COMMENT_RESOLVED_NOTIFICATION = 'comment-resolved-notification',
  // #399: off-critical-path mirror of a comment's inline mark into the collab
  // Y.Doc (resolve/unresolve flip, or ephemeral-suggestion anchor removal).
  COMMENT_MARK_UPDATE = 'comment-mark-update',
  PAGE_MENTION_NOTIFICATION = 'page-mention-notification',
  PAGE_PERMISSION_GRANTED = 'page-permission-granted',
  PAGE_UPDATE_DIGEST = 'page-update-digest',
  PAGE_VERIFICATION_EXPIRING = 'page-verification-expiring',
  PAGE_VERIFICATION_EXPIRED = 'page-verification-expired',
  VERIFICATION_RECONCILE = 'verification-reconcile',
  PAGE_VERIFIED_NOTIFICATION = 'page-verified-notification',
  PAGE_APPROVAL_REQUESTED_NOTIFICATION = 'page-approval-requested-notification',
  PAGE_APPROVAL_REJECTED_NOTIFICATION = 'page-approval-rejected-notification',

  AUDIT_LOG = 'audit-log',
  AUDIT_CLEANUP = 'audit-cleanup',

  PDF_EXPORT_TASK = 'pdf-export-task',
  PDF_EXPORT_CLEANUP = 'pdf-export-cleanup',
}

/**
 * #599 (R2) — job options for the workspace-wide RAG reindex
 * (WORKSPACE_CREATE_EMBEDDINGS), shared by EVERY enqueue site (the manual
 * "Reindex now" button, the AI-Search enable toggle, and the automatic reindex
 * fired when the embedding config's fingerprint changes) so they de-duplicate
 * against each other and retry identically.
 *
 * `jobId` is per-workspace and STABLE: a second enqueue while a run is pending/in
 * flight is de-duplicated by BullMQ rather than stacking a second full pass.
 *
 * `attempts: 3` + exponential backoff OVERRIDES the AI_QUEUE default of
 * `attempts: 1`. A reindex that ends with failed pages (a TEI timeout, a 429)
 * cannot flip the active generation, which leaves the workspace in the swap window
 * (~2x pgvector rows, `semantic.state: 'stale'`, lexical-only after a model
 * change). With a single attempt that state was PERMANENT — nothing ever re-ran the
 * job. The run is idempotent (the start GC keeps the serving generation; the
 * per-page replace is fingerprint-scoped), so retrying it is safe and simply
 * re-attempts the pages that failed. Bounded at 3 so a permanently poisonous page
 * cannot loop forever: after that the job stays failed and the workspace is left in
 * its (visible, `stale`) degraded state.
 *
 * The 60s base backoff is deliberately long: the typical cause is a saturated or
 * restarting embedding sidecar, and hammering it again seconds later would just
 * reproduce the same timeouts (retry at ~60s, then ~120s).
 */
export function workspaceReindexJobOptions(workspaceId: string) {
  return {
    jobId: `ai-reindex-${workspaceId}`,
    attempts: 3,
    backoff: { type: 'exponential' as const, delay: 60_000 },
    removeOnComplete: true,
    removeOnFail: true,
  };
}
