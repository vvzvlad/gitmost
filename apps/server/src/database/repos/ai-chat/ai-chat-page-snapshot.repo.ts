import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '../../types/kysely.types';
import { dbOrTx } from '../../utils';
import { AiChatPageSnapshot } from '@docmost/db/types/entity.types';

/**
 * Repository for the per-(chat,page) Markdown snapshot taken at the end of the
 * agent's previous turn (#274). Diffing the current page against this snapshot
 * tells the agent what a human changed between turns, so it doesn't overwrite
 * those edits. There is at most one live row per (chatId, pageId) — the turn-end
 * write is an upsert on that unique key. Every lookup is workspace-scoped as
 * defense-in-depth (the chat/page ids are already tenant-owned by the caller).
 */
@Injectable()
export class AiChatPageSnapshotRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  /**
   * The current snapshot for a (chat, page) pair, or undefined when none exists
   * yet (first turn on that page). Workspace-scoped so a foreign chat/page id can
   * never surface another tenant's snapshot.
   */
  async findByChatPage(
    chatId: string,
    pageId: string,
    workspaceId: string,
  ): Promise<AiChatPageSnapshot | undefined> {
    return this.db
      .selectFrom('aiChatPageSnapshots')
      .selectAll('aiChatPageSnapshots')
      .where('chatId', '=', chatId)
      .where('pageId', '=', pageId)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
  }

  /**
   * Write the turn-end snapshot for a (chat, page) pair. Inserts on the first
   * turn and overwrites the content/updatedAt on later turns (upsert on the
   * UNIQUE(chatId, pageId) key). The agent's own edits this turn are baked into
   * `contentMd`, which is exactly why the next turn's diff isolates human edits.
   */
  async upsert(
    values: {
      chatId: string;
      pageId: string;
      workspaceId: string;
      contentMd: string;
      pageUpdatedAt: Date;
      contentHash?: string | null;
    },
    trx?: KyselyTransaction,
  ): Promise<AiChatPageSnapshot> {
    const db = dbOrTx(this.db, trx);
    return db
      .insertInto('aiChatPageSnapshots')
      .values({
        chatId: values.chatId,
        pageId: values.pageId,
        workspaceId: values.workspaceId,
        contentMd: values.contentMd,
        pageUpdatedAt: values.pageUpdatedAt,
        contentHash: values.contentHash ?? null,
      })
      .onConflict((oc) =>
        oc.columns(['chatId', 'pageId']).doUpdateSet({
          contentMd: values.contentMd,
          pageUpdatedAt: values.pageUpdatedAt,
          contentHash: values.contentHash ?? null,
          updatedAt: new Date(),
        }),
      )
      .returningAll()
      .executeTakeFirst();
  }
}
