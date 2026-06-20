import {
  afterUnloadDocumentPayload,
  Extension,
  onChangePayload,
  onLoadDocumentPayload,
  onStoreDocumentPayload,
} from '@hocuspocus/server';
import * as Y from 'yjs';
import { Injectable, Logger } from '@nestjs/common';
import { TiptapTransformer } from '@hocuspocus/transformer';
import {
  getPageId,
  isEmptyParagraphDoc,
  jsonToText,
  tiptapExtensions,
} from '../collaboration.util';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageHistoryRepo } from '@docmost/db/repos/page/page-history.repo';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { InjectQueue } from '@nestjs/bullmq';
import { QueueJob, QueueName } from '../../integrations/queue/constants';
import { Queue } from 'bullmq';
import {
  extractMentions,
  extractUserMentions,
} from '../../common/helpers/prosemirror/utils';
import { isDeepStrictEqual } from 'node:util';
import {
  IPageHistoryJob,
  IPageMentionNotificationJob,
} from '../../integrations/queue/constants/queue.interface';
import { Page } from '@docmost/db/types/entity.types';
import { CollabHistoryService } from '../services/collab-history.service';
import {
  HISTORY_FAST_INTERVAL,
  HISTORY_FAST_THRESHOLD,
  HISTORY_INTERVAL,
} from '../constants';
import { TransclusionService } from '../../core/page/transclusion/transclusion.service';
import {
  canAuthorHtmlEmbed,
  collectHtmlEmbedSources,
  hasHtmlEmbedNode,
  htmlEmbedAllowed,
  isHtmlEmbedFeatureEnabled,
  stripDisallowedHtmlEmbedNodes,
  stripHtmlEmbedNodes,
} from '../../common/helpers/prosemirror/html-embed.util';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';

@Injectable()
export class PersistenceExtension implements Extension {
  private readonly logger = new Logger(PersistenceExtension.name);
  private contributors: Map<string, Set<string>> = new Map();
  // Sticky agent-edit marker (§15 H2): a coalesced snapshot may mix human and
  // agent edits. We accumulate "an agent touched this document during the
  // coalescing window" per document and OR it across all edits in the window,
  // so the snapshot is marked 'agent' regardless of who wrote last.
  private agentTouched: Map<string, boolean> = new Map();
  // Per-document debounce timers for the early htmlEmbed guard (Gitea #26).
  // onChange schedules a short (~300ms) debounced strip that converges the
  // shared ydoc for all connected clients well before the 10s store debounce,
  // shrinking the pre-persist broadcast window of a non-admin's transient embed.
  private htmlEmbedGuardTimers: Map<string, NodeJS.Timeout> = new Map();
  // Per-document cache of the workspace htmlEmbed toggle (Gitea #26). Populated
  // in onLoadDocument (which already loads the page + has workspace context) and
  // read in onChange to gate early-guard scheduling: when the toggle is OFF (the
  // common default) we schedule NOTHING — no timer, no fromYdoc, no DB read — and
  // rely on the onStoreDocument strip as the backstop (when OFF the embed does
  // not execute in editable mode anyway). Cleared in afterUnloadDocument.
  // STALENESS: if an admin flips the toggle ON mid-session this cache stays OFF
  // until the document is reloaded, so the early guard won't schedule — accepted,
  // the onStoreDocument backstop still strips on persist.
  private htmlEmbedToggleByDoc: Map<string, boolean> = new Map();

  constructor(
    private readonly pageRepo: PageRepo,
    private readonly pageHistoryRepo: PageHistoryRepo,
    @InjectKysely() private readonly db: KyselyDB,
    @InjectQueue(QueueName.AI_QUEUE) private aiQueue: Queue,
    @InjectQueue(QueueName.HISTORY_QUEUE) private historyQueue: Queue,
    @InjectQueue(QueueName.NOTIFICATION_QUEUE) private notificationQueue: Queue,
    private readonly collabHistory: CollabHistoryService,
    private readonly transclusionService: TransclusionService,
    private readonly workspaceRepo: WorkspaceRepo,
  ) {}

  async onLoadDocument(data: onLoadDocumentPayload) {
    const { documentName, document } = data;
    const pageId = getPageId(documentName);

    if (!document.isEmpty('default')) {
      return;
    }

    const page = await this.pageRepo.findById(pageId, {
      includeContent: true,
      includeYdoc: true,
    });

    if (!page) {
      this.logger.warn('page not found');
      return;
    }

    // Cache the workspace htmlEmbed toggle for this document (Gitea #26). We
    // already have the page (hence its workspaceId) here, so resolve the toggle
    // once and cache it keyed by documentName. onChange reads this to decide
    // whether to schedule the early guard at all — when OFF we skip the guard
    // entirely (no timer, no fromYdoc, no DB read). Cleared in
    // afterUnloadDocument. See htmlEmbedToggleByDoc for the staleness note.
    try {
      const enabled = isHtmlEmbedFeatureEnabled(
        (await this.workspaceRepo.findById(page.workspaceId))?.settings,
      );
      this.htmlEmbedToggleByDoc.set(documentName, enabled);
    } catch (err) {
      // Fail OFF: if the toggle can't be resolved, never schedule the early
      // guard; the onStoreDocument backstop still strips on persist.
      this.htmlEmbedToggleByDoc.set(documentName, false);
    }

    if (page.ydoc) {
      this.logger.debug(`ydoc loaded from db: ${pageId}`);

      const doc = new Y.Doc();
      const dbState = new Uint8Array(page.ydoc);

      Y.applyUpdate(doc, dbState);
      return doc;
    }

    // if no ydoc state in db convert json in page.content to Ydoc.
    if (page.content) {
      this.logger.debug(`converting json to ydoc: ${pageId}`);

      const ydoc = TiptapTransformer.toYdoc(
        page.content,
        'default',
        tiptapExtensions,
      );

      Y.encodeStateAsUpdate(ydoc);
      return ydoc;
    }

    this.logger.debug(`creating fresh ydoc: ${pageId}`);
    return new Y.Doc();
  }

  async onStoreDocument(data: onStoreDocumentPayload) {
    const { documentName, document, context } = data;

    const pageId = getPageId(documentName);

    let tiptapJson = TiptapTransformer.fromYdoc(document, 'default');

    // SECURITY (Variant C admin gate, collab WebSocket write path):
    // The persisted snapshot is the merged ydoc, which may contain an htmlEmbed
    // node inserted by ANY connected editor. htmlEmbed renders raw, unsanitized
    // JS in every reader's browser, so only workspace admins/owners may author
    // it. When the user whose store triggers this persist is not an admin, strip
    // every htmlEmbed node before it is written to the page row AND before the
    // ydoc state is re-encoded, so the node cannot be reintroduced by a
    // non-admin via the collab socket.
    // NOTE (defense-in-depth refinement, Gitea #29): the gate is keyed to the
    // storing connection's user, but it no longer blindly strips EVERY embed on
    // a non-admin store. We distinguish two cases inside the !allowed branch:
    //   - Feature toggle OFF => strip ALL embeds (the feature is disabled for
    //     everyone; existing embeds get cleaned up on the next save).
    //   - Toggle ON but the storer is a NON-admin => strip only NEWLY-introduced
    //     embeds and PRESERVE embeds already present in the currently-persisted
    //     page content (admin-authored, already vetted). So a non-admin still
    //     cannot ADD an embed, but an unrelated edit (e.g. a paragraph tweak) no
    //     longer destroys an admin's existing embed (the prior data-loss bug).
    // The pre-existing-embed identity is the raw `attrs.source` (see
    // collectHtmlEmbedSources). A non-admin who copies an existing admin embed's
    // exact source elsewhere passes — acceptable, that HTML is already vetted.
    //
    // ACCEPTED RESIDUAL RISK (toggle-ON allow-list TOCTOU): the allow-list is a
    // best-effort snapshot read OUTSIDE the locked transaction (the prior content
    // is pre-read above, but inside executeTx the row is re-read withLock without
    // recomputing the allow-list). A concurrent admin store that changes the
    // persisted embeds between the pre-read and this write can make the preserve
    // decision use a slightly stale snapshot — worst case one embed transiently
    // kept or dropped; it converges on the next store, with no auth bypass or
    // broader data loss. The race is accepted because it only affects concurrent
    // authenticated editors on the (rare) toggle-ON non-admin path, converges on
    // the next store, and the persisted row plus every share/readonly read path
    // remain protected by the strip.
    //
    // RESIDUAL RISK (pre-persist broadcast window) — NOW MITIGATED (Gitea #26):
    // this strip runs in the debounced onStoreDocument (up to 10s), but
    // hocuspocus broadcasts each inbound Yjs update to connected clients
    // immediately, so a non-admin's transient htmlEmbed can execute in OTHER open
    // editors' browsers in the window before this persist strips it. The exposure
    // is limited to concurrent AUTHENTICATED space members who have the doc open
    // with Edit rights (semi-trusted) — anonymous public-share/readonly viewers do
    // NOT open a collab socket (ReadonlyPageEditor renders fetched,
    // already-stripped content; HocuspocusProvider is only used by the
    // authenticated editable page-editor), and the PERSISTED page row plus every
    // share/readonly read path are protected by this strip.
    // The window is now SHRUNK to sub-second by an onChange-debounced early guard
    // (~300ms) — see guardHtmlEmbed() — which runs the SAME preserve/strip gate as
    // this block and re-encodes the cleaned ydoc, converging the doc for all
    // clients long before this 10s store debounce fires. This onStoreDocument
    // strip remains the authoritative backstop for persistence. The irreducible
    // residual is only the VERY FIRST inbound broadcast before the ~300ms debounce
    // fires: hocuspocus exposes no synchronous beforeBroadcast filter to drop the
    // node before that first relay, so it cannot be eliminated entirely.
    // Toggle-AND-admin gate: htmlEmbed survives only when the workspace feature
    // toggle is ON and the storing user is an admin/owner. OFF (default) =>
    // stripped for everyone (existing embeds get cleaned up on next save).
    const htmlEmbedEnabled = isHtmlEmbedFeatureEnabled(
      (await this.workspaceRepo.findById(context?.user?.workspaceId))?.settings,
    );
    if (!htmlEmbedAllowed(htmlEmbedEnabled, context?.user?.role)) {
      if (hasHtmlEmbedNode(tiptapJson)) {
        let strippedJson: typeof tiptapJson;
        if (htmlEmbedEnabled === false) {
          // Toggle OFF: feature disabled for everyone -> strip ALL embeds.
          strippedJson = stripHtmlEmbedNodes(tiptapJson);
        } else {
          // Toggle ON, non-admin storer: preserve embeds already present in the
          // currently-persisted (admin-vetted) page content; strip only the
          // newly-introduced ones. Pre-read the prior content — a small extra
          // query only on this rare non-admin + toggle-ON path.
          const prior = await this.pageRepo.findById(pageId, {
            includeContent: true,
          });
          const allowed = collectHtmlEmbedSources(prior?.content);
          strippedJson = stripDisallowedHtmlEmbedNodes(tiptapJson, allowed);
        }

        // Only mutate the ydoc + log when the strip actually removed something;
        // an unnecessary ydoc rewrite would churn the doc for all clients. With
        // the toggle-ON branch a non-admin store that only touches admin-vetted
        // embeds leaves the content unchanged here.
        if (!isDeepStrictEqual(strippedJson, tiptapJson)) {
          this.logger.warn(
            `Stripping htmlEmbed node(s) from collab store by user ${context?.user?.id} on ${documentName}`,
          );
          tiptapJson = strippedJson;
          // Reflect the stripped content back into the shared ydoc so the node
          // is removed for all connected clients, not just the persisted row.
          const fragment = document.getXmlFragment('default');
          if (fragment.length > 0) {
            fragment.delete(0, fragment.length);
          }
          const cleanDoc = TiptapTransformer.toYdoc(
            tiptapJson,
            'default',
            tiptapExtensions,
          );
          Y.applyUpdate(document, Y.encodeStateAsUpdate(cleanDoc));
        }
      }
    }

    const ydocState = Buffer.from(Y.encodeStateAsUpdate(document));

    let textContent = null;

    try {
      textContent = jsonToText(tiptapJson);
    } catch (err) {
      this.logger.warn('jsonToText' + err?.['message']);
    }

    let page: Page = null;
    const editingUserIds = this.consumeContributors(documentName);
    // Sticky agent marker: 'agent' if any agent edit landed in this window, OR
    // if the current writer is the agent (covers a store with no prior onChange
    // agent event in the same window). §15 H2.
    const agentTouched =
      this.consumeAgentTouched(documentName) || context?.actor === 'agent';
    const lastUpdatedSource = agentTouched ? 'agent' : 'user';

    try {
      await executeTx(this.db, async (trx) => {
        page = await this.pageRepo.findById(pageId, {
          withLock: true,
          includeContent: true,
          trx,
        });

        if (!page) {
          this.logger.error(`Page with id ${pageId} not found`);
          return;
        }

        if (isDeepStrictEqual(tiptapJson, page.content)) {
          page = null;
          return;
        }

        let contributorIds = undefined;
        try {
          const existingContributors = page.contributorIds || [];
          contributorIds = Array.from(
            new Set([
              ...existingContributors,
              ...editingUserIds,
              page.creatorId,
            ]),
          );
        } catch (err) {
          //this.logger.debug('Contributors error:' + err?.['message']);
        }

        // Approach A — boundary snapshot before the agent's first edit.
        // When this store is the agent's and the page's currently persisted
        // state was authored by a human, pin that human state as its own
        // history version BEFORE the agent overwrites it. `page` still holds the
        // OLD content/provenance here, so saveHistory(page) captures the
        // pre-agent state tagged 'user'. The agent's new content is snapshotted
        // later by the debounced PAGE_HISTORY job ('agent'). Skip if the prior
        // state is already agent-authored (boundary already pinned on the
        // user->agent transition), if the page is effectively empty, or if the
        // latest existing snapshot already equals this human state (avoid
        // duplicates).
        if (lastUpdatedSource === 'agent' && page.lastUpdatedSource !== 'agent') {
          const lastHistory = await this.pageHistoryRepo.findPageLastHistory(
            pageId,
            { includeContent: true, trx },
          );
          const humanBaselineMissing =
            !lastHistory || !isDeepStrictEqual(lastHistory.content, page.content);
          if (!isEmptyParagraphDoc(page.content as any) && humanBaselineMissing) {
            await this.pageHistoryRepo.saveHistory(page, {
              contributorIds: page.contributorIds ?? undefined,
              trx,
            });
          }
        }

        await this.pageRepo.updatePage(
          {
            content: tiptapJson,
            textContent: textContent,
            ydoc: ydocState,
            lastUpdatedById: context.user.id,
            // Human stays the responsible author; these annotate the source.
            lastUpdatedSource,
            lastUpdatedAiChatId: context?.aiChatId ?? null,
            contributorIds: contributorIds,
          },
          pageId,
          trx,
        );

        this.logger.debug(`Page updated: ${pageId} - SlugId: ${page.slugId}`);
      });
    } catch (err) {
      this.logger.error(`Failed to update page ${pageId}`, err);
    }

    if (page) {
      document.broadcastStateless(
        JSON.stringify({
          type: 'page.updated',
          updatedAt: new Date().toISOString(),
          // Provenance for a future live badge; 'user' for human edits.
          source: lastUpdatedSource,
          lastUpdatedById: context?.user?.id,
          lastUpdatedBy: context?.user
            ? {
                id: context.user?.id,
                name: context.user?.name,
                avatarUrl: context.user?.avatarUrl,
              }
            : undefined,
        }),
      );

      await this.syncTransclusion(pageId, page.workspaceId, tiptapJson);
    }

    if (page) {
      await this.collabHistory.addContributors(pageId, editingUserIds);

      const mentions = extractMentions(tiptapJson);

      const userMentions = extractUserMentions(mentions);
      const oldMentions = page.content ? extractMentions(page.content) : [];
      const oldMentionedUserIds = extractUserMentions(oldMentions).map(
        (m) => m.entityId,
      );

      if (userMentions.length > 0) {
        await this.notificationQueue.add(QueueJob.PAGE_MENTION_NOTIFICATION, {
          userMentions: userMentions.map((m) => ({
            userId: m.entityId,
            mentionId: m.id,
            creatorId: m.creatorId,
          })),
          oldMentionedUserIds,
          pageId,
          spaceId: page.spaceId,
          workspaceId: page.workspaceId,
        } as IPageMentionNotificationJob);
      }

      await this.aiQueue.add(QueueJob.PAGE_CONTENT_UPDATED, {
        pageIds: [pageId],
        workspaceId: page.workspaceId,
      });

      await this.enqueuePageHistory(page, lastUpdatedSource);
    }
  }

  async onChange(data: onChangePayload) {
    const documentName = data.documentName;
    const userId = data.context?.user?.id;

    if (!userId) return;

    if (!this.contributors.has(documentName)) {
      this.contributors.set(documentName, new Set());
    }

    this.contributors.get(documentName).add(userId);

    // Sticky agent marker: once an agent connection touches the document in the
    // coalescing window, keep it marked until the next snapshot consumes it.
    if (data.context?.actor === 'agent') {
      this.agentTouched.set(documentName, true);
    }

    // Early htmlEmbed guard scheduling (Gitea #26). Schedule the short debounced
    // guard ONLY when (a) this document's workspace toggle is cached ON and
    // (b) the changing connection's user is a NON-admin (cannot author
    // htmlEmbed). When the toggle is OFF/unknown we schedule NOTHING — no timer,
    // no fromYdoc, no DB read — killing the OFF-case overhead (the common
    // default); the onStoreDocument strip is the backstop and an OFF embed does
    // not execute in editable mode anyway. We do NO expensive work here — we only
    // (re)schedule the timer; the debounce coalesces rapid edits into a single
    // guard check.
    if (
      userId &&
      this.htmlEmbedToggleByDoc.get(documentName) === true &&
      !canAuthorHtmlEmbed(data.context?.user?.role)
    ) {
      const existing = this.htmlEmbedGuardTimers.get(documentName);
      if (existing) {
        clearTimeout(existing);
      }
      const timer = setTimeout(() => {
        this.htmlEmbedGuardTimers.delete(documentName);
        void this.guardHtmlEmbed(documentName, data.document, data.context);
      }, 300);
      this.htmlEmbedGuardTimers.set(documentName, timer);
    }
  }

  /**
   * Early, onChange-debounced htmlEmbed strip (Gitea #26). Mirrors the
   * onStoreDocument admin gate but runs ~300ms after a non-admin edit instead of
   * waiting for the 10s store debounce, so a non-admin's transient embed is
   * removed from the shared ydoc — and re-broadcast as cleaned state — for all
   * connected clients in sub-second time. onStoreDocument remains the
   * authoritative persistence backstop; this is an ADDITIONAL early pass.
   *
   * CONCURRENCY (the critical invariant): the Y.Doc mutation is a single
   * SYNCHRONOUS block with NO `await` between the fromYdoc snapshot and the
   * applyUpdate write. ALL async work (the workspace toggle lookup and the
   * persisted-content read for the allow-list) happens FIRST, before that block.
   * Because JS is single-threaded, a synchronous block cannot interleave with
   * inbound Yjs update handlers, so a concurrent edit that lands while we await
   * cannot be CLOBBERED: we re-snapshot the live doc only after all awaits, then
   * delete + rebuild + applyUpdate without yielding. (An earlier version awaited
   * DB reads BETWEEN the snapshot and the write, so a concurrent edit in that gap
   * was lost — this restructure fixes that.)
   *
   * The allow-list is a best-effort snapshot read outside any lock (TOCTOU
   * accepted, same as onStoreDocument): worst case one embed is transiently kept
   * or dropped; it converges on the next guard/store, with no auth bypass.
   *
   * Loop-safety: the corrective applyUpdate has a null origin, so the re-fired
   * onChange carries no userId and is not rescheduled; and after a strip no
   * htmlEmbed remains, so a subsequent guard fire is a cheap no-op (the
   * hasHtmlEmbedNode early-exit). NEVER throws — an unhandled rejection in a timer
   * would crash the process — so the whole body is wrapped in try/catch.
   */
  private async guardHtmlEmbed(
    documentName: string,
    document: Y.Doc,
    context: any,
  ): Promise<void> {
    // Defensive: ensure no stale timer entry survives for this document.
    this.htmlEmbedGuardTimers.delete(documentName);
    try {
      // Re-check defensively: onChange only schedules for non-admins, but if an
      // admin/owner somehow reaches here, the embed is authored content — do
      // nothing (onStoreDocument's toggle-AND-admin gate handles persistence).
      if (canAuthorHtmlEmbed(context?.user?.role)) {
        return;
      }

      // ---- ASYNC PHASE: do ALL awaits up front, before touching the ydoc. ----
      // Resolve the workspace toggle exactly as onStoreDocument does. When OFF we
      // strip everything; when ON we use the preserve logic (keep admin-vetted
      // embeds, strip only the non-admin's newly-introduced ones).
      const enabled = isHtmlEmbedFeatureEnabled(
        (await this.workspaceRepo.findById(context?.user?.workspaceId))
          ?.settings,
      );

      // The allow-list (admin-vetted sources already in the persisted content).
      // null => strip ALL (toggle OFF). Read here, BEFORE the synchronous block,
      // so no await sits between the doc snapshot and the doc write.
      let allowed: Set<string> | null = null;
      if (enabled !== false) {
        const prior = await this.pageRepo.findById(getPageId(documentName), {
          includeContent: true,
        });
        allowed = collectHtmlEmbedSources(prior?.content);
      }

      // The awaits above may have let the document be unloaded/destroyed. If so,
      // bail — mutating a destroyed doc is pointless and could throw (the
      // try/catch is the ultimate safety net regardless).
      if ((document as { isDestroyed?: boolean }).isDestroyed) {
        return;
      }

      // ---- SYNCHRONOUS PHASE: snapshot -> strip -> reflect, NO await here. ----
      // Because there is no await between fromYdoc and applyUpdate, no inbound
      // Yjs update can interleave, so a concurrent edit cannot be lost.
      const json = TiptapTransformer.fromYdoc(document, 'default');

      // Cheap exit: nothing to guard if the doc has no embed at all. This is also
      // why a post-strip re-fire is a no-op (loop-safe).
      if (!hasHtmlEmbedNode(json)) {
        return;
      }

      const strippedJson =
        allowed === null
          ? stripHtmlEmbedNodes(json)
          : stripDisallowedHtmlEmbedNodes(json, allowed);

      // Nothing was stripped (e.g. the only embed is an admin-vetted one) — do
      // not churn the shared ydoc for all clients.
      if (isDeepStrictEqual(strippedJson, json)) {
        return;
      }

      // Reflect the stripped content back into the shared ydoc EXACTLY as
      // onStoreDocument does, so the node is removed for all connected clients,
      // not just on the eventual persist. This re-encode broadcasts the cleaned
      // state; after it hasHtmlEmbedNode is false, so any later guard fire is a
      // cheap no-op (loop-safe).
      const fragment = document.getXmlFragment('default');
      if (fragment.length > 0) {
        fragment.delete(0, fragment.length);
      }
      const cleanDoc = TiptapTransformer.toYdoc(
        strippedJson,
        'default',
        tiptapExtensions,
      );
      Y.applyUpdate(document, Y.encodeStateAsUpdate(cleanDoc));

      this.logger.warn(
        `Stripping htmlEmbed node(s) via early onChange guard by user ${context?.user?.id} on ${documentName}`,
      );
    } catch (err) {
      // NEVER rethrow out of a timer-scheduled call.
      this.logger.error(
        `Early htmlEmbed guard failed on ${documentName}`,
        err,
      );
    }
  }

  async afterUnloadDocument(data: afterUnloadDocumentPayload) {
    const documentName = data.documentName;
    this.contributors.delete(documentName);
    this.agentTouched.delete(documentName);
    // Drop the cached toggle for this document so a reload re-resolves it (and
    // picks up a mid-session admin toggle flip).
    this.htmlEmbedToggleByDoc.delete(documentName);
    // Clear any pending early-guard timer so it cannot fire after the document
    // is unloaded (leak / use-after-unload prevention).
    const timer = this.htmlEmbedGuardTimers.get(documentName);
    if (timer) {
      clearTimeout(timer);
      this.htmlEmbedGuardTimers.delete(documentName);
    }
  }

  private consumeContributors(documentName: string): string[] {
    const contributorSet = this.contributors.get(documentName);
    if (!contributorSet) return [];
    const userIds = [...contributorSet];
    this.contributors.delete(documentName);
    return userIds;
  }

  /** Read and clear the sticky agent-touched flag for this coalescing window. */
  private consumeAgentTouched(documentName: string): boolean {
    const touched = this.agentTouched.get(documentName) ?? false;
    this.agentTouched.delete(documentName);
    return touched;
  }

  private async enqueuePageHistory(
    page: Page,
    lastUpdatedSource: string,
  ): Promise<void> {
    // Agent edits get an immediate, source-keyed history job: they snapshot
    // deterministically as 'agent' and a later human edit (jobId = page.id)
    // cannot coalesce/retag them. Human edits keep the age-based debounce so
    // rapid human edits still coalesce into one snapshot.
    // NOTE: the agent delay MUST stay 0 — the worker re-reads the page row at
    // run time, so any delay would risk reading content a later human edit has
    // already overwritten (mis-tagged snapshot). 0 minimizes that window.
    const isAgent = lastUpdatedSource === 'agent';
    const pageAge = Date.now() - new Date(page.createdAt).getTime();
    const delay = isAgent
      ? 0
      : pageAge < HISTORY_FAST_THRESHOLD
        ? HISTORY_FAST_INTERVAL
        : HISTORY_INTERVAL;
    // BullMQ forbids ':' in custom job IDs (it is the Redis key separator), so
    // use '-' here. page.id is a UUID, so `${page.id}-agent` cannot collide with
    // any human job whose id is a bare page.id.
    const jobId = isAgent ? `${page.id}-agent` : page.id;

    await this.historyQueue.add(
      QueueJob.PAGE_HISTORY,
      { pageId: page.id } as IPageHistoryJob,
      { jobId, delay },
    );
  }

  /**
   * Refresh `page_transclusions` and `page_transclusion_references` to match
   * the page's current content. Runs outside the page-write transaction and
   * isolates each call so a failure here cannot affect the page save itself.
   * The diff is idempotent — the next save converges if a round drops anything.
   */
  private async syncTransclusion(
    pageId: string,
    workspaceId: string,
    tiptapJson: unknown,
  ): Promise<void> {
    try {
      await this.transclusionService.syncPageTransclusions(
        pageId,
        workspaceId,
        tiptapJson,
      );
    } catch (err) {
      this.logger.error(
        { err, pageId },
        'Failed to sync transclusions for page',
      );
    }
    try {
      await this.transclusionService.syncPageReferences(
        pageId,
        workspaceId,
        tiptapJson,
      );
    } catch (err) {
      this.logger.error(
        { err, pageId },
        'Failed to sync transclusion references for page',
      );
    }
    try {
      await this.transclusionService.syncPageTemplateReferences(
        pageId,
        workspaceId,
        tiptapJson,
      );
    } catch (err) {
      this.logger.error(
        { err, pageId },
        'Failed to sync page template references for page',
      );
    }
  }
}
