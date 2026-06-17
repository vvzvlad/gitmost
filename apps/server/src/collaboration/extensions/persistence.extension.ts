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

@Injectable()
export class PersistenceExtension implements Extension {
  private readonly logger = new Logger(PersistenceExtension.name);
  private contributors: Map<string, Set<string>> = new Map();
  // Sticky agent-edit marker (§15 H2): a coalesced snapshot may mix human and
  // agent edits. We accumulate "an agent touched this document during the
  // coalescing window" per document and OR it across all edits in the window,
  // so the snapshot is marked 'agent' regardless of who wrote last.
  private agentTouched: Map<string, boolean> = new Map();

  constructor(
    private readonly pageRepo: PageRepo,
    private readonly pageHistoryRepo: PageHistoryRepo,
    @InjectKysely() private readonly db: KyselyDB,
    @InjectQueue(QueueName.AI_QUEUE) private aiQueue: Queue,
    @InjectQueue(QueueName.HISTORY_QUEUE) private historyQueue: Queue,
    @InjectQueue(QueueName.NOTIFICATION_QUEUE) private notificationQueue: Queue,
    private readonly collabHistory: CollabHistoryService,
    private readonly transclusionService: TransclusionService,
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

    const tiptapJson = TiptapTransformer.fromYdoc(document, 'default');
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
  }

  async afterUnloadDocument(data: afterUnloadDocumentPayload) {
    const documentName = data.documentName;
    this.contributors.delete(documentName);
    this.agentTouched.delete(documentName);
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
    const jobId = isAgent ? `${page.id}:agent` : page.id;

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
  }
}
