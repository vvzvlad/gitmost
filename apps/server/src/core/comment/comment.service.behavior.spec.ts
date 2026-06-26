import { BadRequestException } from '@nestjs/common';
import { CommentService } from './comment.service';
import { QueueJob } from '../../integrations/queue/constants';

/**
 * Behavioral coverage for CommentService (comment.service.ts):
 *   - create()                @53
 *   - resolveComment()        @223
 *   - queueCommentNotification() @292 (exercised through create/update)
 *
 * The service is constructed directly with jest-mocked repos / gateway / queues
 * (the @InjectQueue tokens cannot be resolved by Test.createTestingModule — see
 * the existing comment.service.spec.ts note). Every async dep returns a resolved
 * promise so the real control flow runs end-to-end.
 *
 * These specs catch: the thread-depth invariant (no reply-to-a-reply, parent
 * must live on the same page), mis-attributed AI provenance (created_source /
 * resolved_source / ai_chat_id), and notification correctness (self-mention and
 * re-notify spam, plus missed reply / resolve notifications).
 */
describe('CommentService — behavior', () => {
  // ProseMirror-ish doc containing a single user mention. extractUserMentionIds
  // FromJson walks `content[]` for nodes of type 'mention' with
  // attrs.entityType==='user' and returns attrs.entityId.
  const docMentioning = (...entityIds: string[]) => ({
    type: 'doc',
    content: entityIds.map((entityId) => ({
      type: 'mention',
      attrs: { entityType: 'user', entityId },
    })),
  });

  function makeService(overrides?: {
    insertedId?: string;
    parentComment?: any;
  }) {
    const insertedId = overrides?.insertedId ?? 'comment-new';

    const commentRepo: any = {
      // findById is used both for parent lookup (create) and the post-write
      // re-read. Default: the parent lookup result is configurable; the re-read
      // returns a minimal hydrated comment carrying the inserted id.
      findById: jest.fn(async (id: string) => {
        if (
          overrides &&
          'parentComment' in overrides &&
          id === overrides.parentComment?.id
        ) {
          return overrides.parentComment;
        }
        return { id, content: {}, spaceId: 'space-1', pageId: 'page-1' };
      }),
      insertComment: jest.fn(async () => ({ id: insertedId })),
      updateComment: jest.fn(async () => undefined),
    };
    const pageRepo: any = {};
    const wsService: any = { emitCommentEvent: jest.fn() };
    const collaborationGateway: any = {
      handleYjsEvent: jest.fn(async () => undefined),
    };
    const generalQueue: any = { add: jest.fn(() => Promise.resolve()) };
    const notificationQueue: any = { add: jest.fn(async () => undefined) };

    const service = new CommentService(
      commentRepo,
      pageRepo,
      wsService,
      collaborationGateway,
      generalQueue,
      notificationQueue,
    );

    return {
      service,
      commentRepo,
      wsService,
      generalQueue,
      notificationQueue,
    };
  }

  const page = (over?: Partial<any>): any => ({
    id: 'page-1',
    spaceId: 'space-1',
    ...over,
  });
  const user = (over?: Partial<any>): any => ({ id: 'user-1', ...over });

  describe('create — thread-depth invariant & provenance', () => {
    it('rejects a reply whose parent is itself a reply: "You cannot reply to a reply"', async () => {
      const parentComment = {
        id: 'parent-1',
        pageId: 'page-1',
        // A non-null parentCommentId means the "parent" is already a reply.
        parentCommentId: 'grandparent-1',
      };
      const { service, commentRepo } = makeService({ parentComment });

      await expect(
        service.create(
          { page: page(), workspaceId: 'ws-1', user: user() },
          {
            content: JSON.stringify(docMentioning()),
            parentCommentId: 'parent-1',
          } as any,
        ),
      ).rejects.toThrow(new BadRequestException('You cannot reply to a reply'));

      // The depth check happens before any write.
      expect(commentRepo.insertComment).not.toHaveBeenCalled();
    });

    it('rejects a reply when the parent lives on a different page: "Parent comment not found"', async () => {
      const parentComment = {
        id: 'parent-1',
        pageId: 'OTHER-page',
        parentCommentId: null,
      };
      const { service, commentRepo } = makeService({ parentComment });

      await expect(
        service.create(
          { page: page(), workspaceId: 'ws-1', user: user() },
          {
            content: JSON.stringify(docMentioning()),
            parentCommentId: 'parent-1',
          } as any,
        ),
      ).rejects.toThrow(new BadRequestException('Parent comment not found'));

      expect(commentRepo.insertComment).not.toHaveBeenCalled();
    });

    it('stamps createdSource:"agent" + aiChatId when the actor is an agent', async () => {
      const { service, commentRepo } = makeService();

      await service.create(
        { page: page(), workspaceId: 'ws-1', user: user() },
        { content: JSON.stringify(docMentioning()) } as any,
        { actor: 'agent', aiChatId: 'chat-99' },
      );

      const insertArg = commentRepo.insertComment.mock.calls[0][0];
      expect(insertArg.createdSource).toBe('agent');
      expect(insertArg.aiChatId).toBe('chat-99');
      // Provenance only annotates the source — the human stays the creator.
      expect(insertArg.creatorId).toBe('user-1');
    });

    it('stamps createdSource:"agent" with a null aiChatId (external MCP agent) without breaking insert', async () => {
      const { service, commentRepo } = makeService();

      // An external MCP agent is flagged is_agent server-side but has no
      // internal ai_chats row, so provenance carries actor='agent' + a null
      // aiChatId. The insert must still record the agent marker.
      await service.create(
        { page: page(), workspaceId: 'ws-1', user: user() },
        { content: JSON.stringify(docMentioning()) } as any,
        { actor: 'agent', aiChatId: null },
      );

      const insertArg = commentRepo.insertComment.mock.calls[0][0];
      expect(insertArg.createdSource).toBe('agent');
      expect(insertArg.aiChatId).toBeNull();
      expect(insertArg.creatorId).toBe('user-1');
    });

    it('leaves source default (no agent stamp) for a normal user', async () => {
      const { service, commentRepo } = makeService();

      await service.create(
        { page: page(), workspaceId: 'ws-1', user: user() },
        { content: JSON.stringify(docMentioning()) } as any,
        // Normal user provenance.
        { actor: 'user', aiChatId: null },
      );

      const insertArg = commentRepo.insertComment.mock.calls[0][0];
      expect(insertArg).not.toHaveProperty('createdSource');
      expect(insertArg).not.toHaveProperty('aiChatId');
    });
  });

  describe('resolveComment — provenance & resolve notifications', () => {
    it('stamps resolvedSource:"agent" when an agent resolves', async () => {
      const { service, commentRepo } = makeService();
      const comment: any = {
        id: 'c-1',
        creatorId: 'user-1',
        pageId: 'page-1',
        spaceId: 'space-1',
        workspaceId: 'ws-1',
      };

      await service.resolveComment(comment, true, user({ id: 'user-1' }), {
        actor: 'agent',
        aiChatId: 'chat-1',
      });

      const [patch] = commentRepo.updateComment.mock.calls[0];
      expect(patch.resolvedSource).toBe('agent');
      expect(patch.resolvedById).toBe('user-1');
      expect(patch.resolvedAt).toBeInstanceOf(Date);
    });

    it('clears resolvedAt/resolvedById/resolvedSource to null on unresolve', async () => {
      const { service, commentRepo } = makeService();
      const comment: any = {
        id: 'c-1',
        creatorId: 'user-1',
        pageId: 'page-1',
        spaceId: 'space-1',
        workspaceId: 'ws-1',
      };

      // Unresolve as an agent — the agent marker must still clear, not persist.
      await service.resolveComment(comment, false, user({ id: 'user-2' }), {
        actor: 'agent',
        aiChatId: 'chat-1',
      });

      const [patch] = commentRepo.updateComment.mock.calls[0];
      expect(patch).toEqual({
        resolvedAt: null,
        resolvedById: null,
        resolvedSource: null,
      });
    });

    it("notifies the author when SOMEONE ELSE resolves their comment", async () => {
      const { service, notificationQueue } = makeService();
      const comment: any = {
        id: 'c-1',
        creatorId: 'author-1',
        pageId: 'page-1',
        spaceId: 'space-1',
        workspaceId: 'ws-1',
      };

      await service.resolveComment(comment, true, user({ id: 'resolver-2' }));

      expect(notificationQueue.add).toHaveBeenCalledTimes(1);
      const [jobName, jobData] = notificationQueue.add.mock.calls[0];
      expect(jobName).toBe(QueueJob.COMMENT_RESOLVED_NOTIFICATION);
      expect(jobData).toMatchObject({
        commentId: 'c-1',
        commentCreatorId: 'author-1',
        actorId: 'resolver-2',
        pageId: 'page-1',
        spaceId: 'space-1',
        workspaceId: 'ws-1',
      });
    });

    it('does NOT notify when resolving your OWN comment', async () => {
      const { service, notificationQueue } = makeService();
      const comment: any = {
        id: 'c-1',
        creatorId: 'self-1',
        pageId: 'page-1',
        spaceId: 'space-1',
        workspaceId: 'ws-1',
      };

      await service.resolveComment(comment, true, user({ id: 'self-1' }));

      expect(notificationQueue.add).not.toHaveBeenCalled();
    });
  });

  describe('queueCommentNotification — via create/update', () => {
    // Find the COMMENT_NOTIFICATION job among notificationQueue.add calls.
    const notifJob = (notificationQueue: any) =>
      notificationQueue.add.mock.calls.find(
        (c: any[]) => c[0] === QueueJob.COMMENT_NOTIFICATION,
      );

    it('filters out a self-mention on create (no notification job)', async () => {
      const { service, notificationQueue } = makeService();

      // A brand-new top-level comment that mentions only its own author. The
      // self id is filtered, no watchers branch reachable here because the only
      // potential job is from the mention set... but create() passes
      // notifyWatchers=true for a top-level comment, so a job WILL fire — we
      // assert the self id was scrubbed from mentionedUserIds.
      await service.create(
        { page: page(), workspaceId: 'ws-1', user: user({ id: 'me' }) },
        { content: JSON.stringify(docMentioning('me')) } as any,
      );

      const job = notifJob(notificationQueue);
      expect(job).toBeDefined();
      // Self-mention must never appear in the recipients list.
      expect(job[1].mentionedUserIds).toEqual([]);
    });

    it('does not re-notify an already-mentioned id on edit', async () => {
      const { service, notificationQueue } = makeService();

      // The comment already mentioned 'bob' (oldMentionIds). The edited content
      // mentions bob again plus nobody new, top-level (notifyWatchers=false on
      // update) → no new mentions, no watchers, no parent → NO job.
      const comment: any = {
        id: 'c-1',
        creatorId: 'editor-1',
        pageId: 'page-1',
        spaceId: 'space-1',
        workspaceId: 'ws-1',
        content: docMentioning('bob'),
      };

      await service.update(
        comment,
        { content: JSON.stringify(docMentioning('bob')) } as any,
        user({ id: 'editor-1' }),
      );

      expect(notifJob(notificationQueue)).toBeUndefined();
    });

    it('enqueues newly added mentions on edit (re-notify guard does not over-suppress)', async () => {
      const { service, notificationQueue } = makeService();

      const comment: any = {
        id: 'c-1',
        creatorId: 'editor-1',
        pageId: 'page-1',
        spaceId: 'space-1',
        workspaceId: 'ws-1',
        content: docMentioning('bob'),
      };

      // Edit adds 'carol' while keeping 'bob' → only 'carol' is new.
      await service.update(
        comment,
        { content: JSON.stringify(docMentioning('bob', 'carol')) } as any,
        user({ id: 'editor-1' }),
      );

      const job = notifJob(notificationQueue);
      expect(job).toBeDefined();
      expect(job[1].mentionedUserIds).toEqual(['carol']);
    });

    it('enqueues NO job when no new mentions, not notifying watchers and no parent (edit)', async () => {
      const { service, notificationQueue } = makeService();

      const comment: any = {
        id: 'c-1',
        creatorId: 'editor-1',
        pageId: 'page-1',
        spaceId: 'space-1',
        workspaceId: 'ws-1',
        content: docMentioning(),
      };

      // Plain edit with no mentions at all: update() passes notifyWatchers=false
      // and no parentCommentId → the early return in queueCommentNotification.
      await service.update(
        comment,
        { content: JSON.stringify(docMentioning()) } as any,
        user({ id: 'editor-1' }),
      );

      expect(notifJob(notificationQueue)).toBeUndefined();
    });

    it('enqueues a reply notification (parentCommentId) even with no new mentions', async () => {
      const parentComment = {
        id: 'parent-1',
        pageId: 'page-1',
        parentCommentId: null,
      };
      const { service, notificationQueue } = makeService({ parentComment });

      // A reply with no mentions: notifyWatchers is false (!isReply) but the
      // parentCommentId keeps the job alive → reply notifications are not missed.
      await service.create(
        { page: page(), workspaceId: 'ws-1', user: user({ id: 'replier' }) },
        {
          content: JSON.stringify(docMentioning()),
          parentCommentId: 'parent-1',
        } as any,
      );

      const job = notifJob(notificationQueue);
      expect(job).toBeDefined();
      expect(job[1]).toMatchObject({
        parentCommentId: 'parent-1',
        notifyWatchers: false,
        mentionedUserIds: [],
      });
    });
  });
});
