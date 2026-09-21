import { CommentService } from './comment.service';

/**
 * Caller-contract coverage for the three live comment broadcasts (#300/#304):
 *   - commentCreated   (create @153)
 *   - commentUpdated   (update @214)  ← the fragile path this suite spotlights
 *   - commentResolved  (resolveComment @283)
 *
 * All three must emit a payload carrying the {agent,launcher} avatar stack for an
 * AGENT comment, and NEITHER field for a non-agent comment. The enrichment lives
 * in CommentRepo.findById(..., {includeCreator:true}); the service contract these
 * tests pin is that every broadcast reads its payload from that enriched
 * single-row load rather than from an un-enriched object.
 *
 * NON-VACUITY for the update path: the service is handed an UN-enriched input
 * comment (no agent/launcher), while findById returns the ENRICHED shape. The
 * pre-#304 update() re-emitted the caller's object in place, so it would emit the
 * un-enriched input and the `agent`/`launcher` assertions would FAIL. The fix
 * re-fetches via findById, so the broadcast carries the stack regardless of how
 * the caller pre-loaded the comment.
 */
describe('CommentService — broadcast carries the agent avatar stack', () => {
  // An enriched agent comment as CommentRepo.findById(..., includeCreator:true)
  // returns it: the {agent,launcher} pair is attached and agentRole is stripped.
  const enrichedAgentComment = (over?: Record<string, unknown>) => ({
    id: 'comment-new',
    pageId: 'page-1',
    spaceId: 'space-1',
    workspaceId: 'ws-1',
    content: { type: 'doc', content: [] },
    createdSource: 'agent',
    agent: { name: 'Researcher', emoji: '🔬', avatarUrl: null },
    launcher: { name: 'Alice', avatarUrl: 'a.png' },
    ...over,
  });

  // A plain human comment: findById attaches neither agent nor launcher.
  const plainHumanComment = (over?: Record<string, unknown>) => ({
    id: 'comment-new',
    pageId: 'page-1',
    spaceId: 'space-1',
    workspaceId: 'ws-1',
    content: { type: 'doc', content: [] },
    createdSource: 'user',
    ...over,
  });

  function makeService(findByIdReturn: unknown) {
    const commentRepo: any = {
      // In these flows findById is only the post-write enriched re-read
      // (no parentCommentId is set, so no parent lookup path is taken).
      findById: jest.fn(async () => findByIdReturn),
      insertComment: jest.fn(async () => ({ id: 'comment-new' })),
      updateComment: jest.fn(async () => undefined),
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

    return { service, commentRepo, wsService };
  }

  // Pull the emitted event object (3rd arg of emitCommentEvent) for an operation.
  const emittedEvent = (wsService: any, operation: string) =>
    wsService.emitCommentEvent.mock.calls
      .map((c: any[]) => c[2])
      .find((e: any) => e.operation === operation);

  const page = { id: 'page-1', spaceId: 'space-1' } as any;
  const user = (id = 'user-1') => ({ id }) as any;
  const emptyDoc = JSON.stringify({ type: 'doc', content: [] });

  describe('commentCreated', () => {
    it('emits agent + launcher for an agent comment', async () => {
      const { service, wsService } = makeService(enrichedAgentComment());

      await service.create(
        { page, workspaceId: 'ws-1', user: user() },
        { content: emptyDoc } as any,
        { actor: 'agent', aiChatId: 'chat-1' },
      );

      const event = emittedEvent(wsService, 'commentCreated');
      expect(event).toBeDefined();
      expect(event.comment.agent).toEqual({
        name: 'Researcher',
        emoji: '🔬',
        avatarUrl: null,
      });
      expect(event.comment.launcher).toEqual({ name: 'Alice', avatarUrl: 'a.png' });
    });

    it('emits neither field for a non-agent comment', async () => {
      const { service, wsService } = makeService(plainHumanComment());

      await service.create(
        { page, workspaceId: 'ws-1', user: user() },
        { content: emptyDoc } as any,
      );

      const event = emittedEvent(wsService, 'commentCreated');
      expect(event).toBeDefined();
      expect(event.comment).not.toHaveProperty('agent');
      expect(event.comment).not.toHaveProperty('launcher');
    });
  });

  describe('commentUpdated — the fragile path (spotlight)', () => {
    it('emits agent + launcher even when the caller pre-loaded an UN-enriched comment', async () => {
      // findById (the re-fetch) returns the enriched shape...
      const { service, wsService, commentRepo } = makeService(
        enrichedAgentComment(),
      );

      // ...but the caller hands in an object with NO agent/launcher. The pre-#304
      // update() re-emitted THIS object in place, so this test fails against it;
      // the re-fetch fix makes the broadcast independent of the pre-load.
      const inputComment: any = {
        id: 'comment-new',
        creatorId: 'user-1',
        pageId: 'page-1',
        spaceId: 'space-1',
        workspaceId: 'ws-1',
        content: { type: 'doc', content: [] },
        // deliberately no `agent` / `launcher`
      };

      await service.update(
        inputComment,
        { content: emptyDoc } as any,
        user('user-1'),
      );

      // The broadcast must re-read the enriched row (persisted update, then load).
      expect(commentRepo.updateComment).toHaveBeenCalled();
      expect(commentRepo.findById).toHaveBeenCalledWith('comment-new', {
        includeCreator: true,
        includeResolvedBy: true,
      });

      const event = emittedEvent(wsService, 'commentUpdated');
      expect(event).toBeDefined();
      expect(event.comment.agent).toEqual({
        name: 'Researcher',
        emoji: '🔬',
        avatarUrl: null,
      });
      expect(event.comment.launcher).toEqual({ name: 'Alice', avatarUrl: 'a.png' });
    });

    it('emits neither field for a non-agent comment', async () => {
      const { service, wsService } = makeService(plainHumanComment());

      const inputComment: any = {
        id: 'comment-new',
        creatorId: 'user-1',
        pageId: 'page-1',
        spaceId: 'space-1',
        workspaceId: 'ws-1',
        content: { type: 'doc', content: [] },
      };

      await service.update(
        inputComment,
        { content: emptyDoc } as any,
        user('user-1'),
      );

      const event = emittedEvent(wsService, 'commentUpdated');
      expect(event).toBeDefined();
      expect(event.comment).not.toHaveProperty('agent');
      expect(event.comment).not.toHaveProperty('launcher');
    });
  });

  describe('commentResolved', () => {
    it('emits agent + launcher for an agent comment', async () => {
      const { service, wsService } = makeService(enrichedAgentComment());

      await service.resolveComment(
        {
          id: 'comment-new',
          creatorId: 'user-1',
          pageId: 'page-1',
          spaceId: 'space-1',
          workspaceId: 'ws-1',
        } as any,
        true,
        user('user-1'),
        { actor: 'agent', aiChatId: 'chat-1' },
      );

      const event = emittedEvent(wsService, 'commentResolved');
      expect(event).toBeDefined();
      expect(event.comment.agent).toEqual({
        name: 'Researcher',
        emoji: '🔬',
        avatarUrl: null,
      });
      expect(event.comment.launcher).toEqual({ name: 'Alice', avatarUrl: 'a.png' });
    });

    it('emits neither field for a non-agent comment', async () => {
      const { service, wsService } = makeService(plainHumanComment());

      await service.resolveComment(
        {
          id: 'comment-new',
          creatorId: 'user-1',
          pageId: 'page-1',
          spaceId: 'space-1',
          workspaceId: 'ws-1',
        } as any,
        true,
        user('user-1'),
      );

      const event = emittedEvent(wsService, 'commentResolved');
      expect(event).toBeDefined();
      expect(event.comment).not.toHaveProperty('agent');
      expect(event.comment).not.toHaveProperty('launcher');
    });
  });
});
