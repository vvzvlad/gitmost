import { HttpException } from '@nestjs/common';
import {
  resolveShareAssistantRequest,
  uiMessageTextLength,
  type ShareAssistantDeps,
} from './public-share-chat.controller';
import { AiNotConfiguredException } from '../../integrations/ai/ai-not-configured.exception';
import {
  MAX_SHARE_MESSAGES,
  MAX_SHARE_MESSAGE_CHARS,
} from './public-share-chat.service';
import type { UIMessage } from 'ai';

/**
 * Unit tests for the extracted pre-hijack funnel (resolveShareAssistantRequest)
 * and the exported size helper (uiMessageTextLength). The funnel order is
 * security-relevant: the first failing gate must win, every failure must throw
 * BEFORE any stream/hijack, and the access-shaped failures must all 404 (no
 * existence leak). These exercise each branch with hand-rolled mocks — no Nest
 * module graph, no DB.
 */
describe('resolveShareAssistantRequest (extracted controller funnel)', () => {
  /** A fully-passing dep set; individual tests override single collaborators. */
  function makeDeps(over: {
    assistantEnabled?: boolean;
    getShareForPage?: jest.Mock;
    isSharingAllowed?: jest.Mock;
    findById?: jest.Mock;
    hasRestrictedAncestor?: jest.Mock;
    resolveShareRole?: jest.Mock;
    getShareChatModel?: jest.Mock;
    tryConsumeWorkspaceQuota?: jest.Mock;
  } = {}) {
    const aiSettings = {
      isPublicShareAssistantEnabled: jest
        .fn()
        .mockResolvedValue(over.assistantEnabled ?? true),
    };
    const shareService = {
      getShareForPage:
        over.getShareForPage ??
        jest.fn().mockResolvedValue({
          id: 'SHARE-A',
          pageId: 'root-page',
          spaceId: 'space-1',
          sharedPage: { id: 'root-page', title: 'Root' },
        }),
      isSharingAllowed:
        over.isSharingAllowed ?? jest.fn().mockResolvedValue(true),
    };
    const pageRepo = {
      findById:
        over.findById ?? jest.fn().mockResolvedValue({ id: 'opened-uuid' }),
    };
    const pagePermissionRepo = {
      hasRestrictedAncestor:
        over.hasRestrictedAncestor ?? jest.fn().mockResolvedValue(false),
    };
    const publicShareChat = {
      resolveShareRole:
        over.resolveShareRole ?? jest.fn().mockResolvedValue(null),
      getShareChatModel:
        over.getShareChatModel ?? jest.fn().mockResolvedValue('MODEL'),
      tryConsumeWorkspaceQuota:
        over.tryConsumeWorkspaceQuota ?? jest.fn().mockResolvedValue(true),
    };
    const deps: ShareAssistantDeps = {
      aiSettings: aiSettings as never,
      shareService: shareService as never,
      pageRepo: pageRepo as never,
      pagePermissionRepo: pagePermissionRepo as never,
      publicShareChat: publicShareChat as never,
    };
    return {
      deps,
      aiSettings,
      shareService,
      pageRepo,
      pagePermissionRepo,
      publicShareChat,
    };
  }

  const body = (over: Record<string, unknown> = {}) => ({
    shareId: 'SHARE-A',
    pageId: 'opened-page',
    messages: [],
    ...over,
  });

  /** Run the funnel and capture the thrown HttpException status (or null). */
  async function statusOf(
    deps: ShareAssistantDeps,
    b: Record<string, unknown>,
  ): Promise<number | null> {
    try {
      await resolveShareAssistantRequest(deps, {
        workspaceId: 'ws-1',
        body: b as never,
      });
      return null;
    } catch (err) {
      if (err instanceof HttpException) return err.getStatus();
      throw err;
    }
  }

  it('happy path: returns the resolved, non-null request', async () => {
    const { deps } = makeDeps();
    const out = await resolveShareAssistantRequest(deps, {
      workspaceId: 'ws-1',
      body: body() as never,
    });
    expect(out.shareId).toBe('SHARE-A');
    expect(out.share.id).toBe('SHARE-A');
    expect(out.model).toBe('MODEL');
    expect(out.role).toBeNull();
    expect(out.openedPage).toEqual({ id: 'opened-page', title: 'Root' });
  });

  it('assistant disabled => 404 and NO share/page/model lookups', async () => {
    const { deps, shareService, pageRepo, publicShareChat } = makeDeps({
      assistantEnabled: false,
    });
    expect(await statusOf(deps, body())).toBe(404);
    expect(shareService.getShareForPage).not.toHaveBeenCalled();
    expect(pageRepo.findById).not.toHaveBeenCalled();
    expect(publicShareChat.getShareChatModel).not.toHaveBeenCalled();
  });

  it('share.id !== body.shareId => 404 (cross-share id swap rejected)', async () => {
    const { deps, publicShareChat } = makeDeps({
      getShareForPage: jest.fn().mockResolvedValue({
        id: 'OTHER-SHARE',
        pageId: 'root',
        spaceId: 'space-1',
        sharedPage: null,
      }),
    });
    expect(await statusOf(deps, body({ shareId: 'SHARE-A' }))).toBe(404);
    // Never reached the model resolution for an unusable share.
    expect(publicShareChat.getShareChatModel).not.toHaveBeenCalled();
  });

  it('opened page unresolvable (pageRepo.findById -> null) => fail-closed 404', async () => {
    const { deps } = makeDeps({
      findById: jest.fn().mockResolvedValue(null),
    });
    expect(await statusOf(deps, body())).toBe(404);
  });

  it('restricted descendant => 404 (same as out-of-tree, no existence leak)', async () => {
    const { deps, pagePermissionRepo } = makeDeps({
      hasRestrictedAncestor: jest.fn().mockResolvedValue(true),
    });
    expect(await statusOf(deps, body())).toBe(404);
    expect(pagePermissionRepo.hasRestrictedAncestor).toHaveBeenCalled();
  });

  it('getShareChatModel throws AiNotConfiguredException => 503', async () => {
    const { deps } = makeDeps({
      getShareChatModel: jest
        .fn()
        .mockRejectedValue(new AiNotConfiguredException()),
    });
    expect(await statusOf(deps, body())).toBe(503);
  });

  it('getShareChatModel throws a non-AiNotConfigured error => re-thrown (not a 503/404)', async () => {
    const boom = new Error('boom');
    const { deps } = makeDeps({
      getShareChatModel: jest.fn().mockRejectedValue(boom),
    });
    await expect(
      resolveShareAssistantRequest(deps, {
        workspaceId: 'ws-1',
        body: body() as never,
      }),
    ).rejects.toBe(boom);
  });

  it('tryConsumeWorkspaceQuota false => 429 thrown BEFORE any stream', async () => {
    const { deps, publicShareChat } = makeDeps({
      tryConsumeWorkspaceQuota: jest.fn().mockResolvedValue(false),
    });
    expect(await statusOf(deps, body())).toBe(429);
    // The quota gate ran AFTER the model resolved (provider configured) but the
    // function returns/throws before producing a streamable request.
    expect(publicShareChat.tryConsumeWorkspaceQuota).toHaveBeenCalledWith('ws-1');
  });

  it('messages over MAX_SHARE_MESSAGES => 413', async () => {
    const { deps } = makeDeps();
    const tooMany = Array.from({ length: MAX_SHARE_MESSAGES + 1 }, () => ({
      role: 'user',
      parts: [{ type: 'text', text: 'hi' }],
    }));
    expect(await statusOf(deps, body({ messages: tooMany }))).toBe(413);
  });

  it('a single message over MAX_SHARE_MESSAGE_CHARS => 413 (uiMessageTextLength)', async () => {
    const { deps } = makeDeps();
    const huge = {
      role: 'user',
      parts: [{ type: 'text', text: 'x'.repeat(MAX_SHARE_MESSAGE_CHARS + 1) }],
    };
    expect(await statusOf(deps, body({ messages: [huge] }))).toBe(413);
  });

  it('the quota gate is checked BEFORE the payload caps (429 wins over 413)', async () => {
    // Over-cap workspace AND an over-long message: the 429 must surface first, so
    // an over-cap caller is rejected without even paying the payload-cap scan.
    const { deps } = makeDeps({
      tryConsumeWorkspaceQuota: jest.fn().mockResolvedValue(false),
    });
    const huge = {
      role: 'user',
      parts: [{ type: 'text', text: 'x'.repeat(MAX_SHARE_MESSAGE_CHARS + 1) }],
    };
    expect(await statusOf(deps, body({ messages: [huge] }))).toBe(429);
  });
});

describe('uiMessageTextLength', () => {
  it('returns 0 for an undefined / parts-less / non-array message', () => {
    expect(uiMessageTextLength(undefined)).toBe(0);
    expect(uiMessageTextLength({} as UIMessage)).toBe(0);
    expect(uiMessageTextLength({ parts: 'nope' } as never)).toBe(0);
  });

  it('sums the lengths of ONLY the text parts', () => {
    const msg = {
      role: 'user',
      parts: [
        { type: 'text', text: 'hello' }, // 5
        { type: 'tool-call', text: 'IGNORED' }, // non-text: ignored
        { type: 'text', text: 'world!' }, // 6
        { type: 'text' }, // no text field: ignored
      ],
    } as unknown as UIMessage;
    expect(uiMessageTextLength(msg)).toBe(11);
  });

  it('matches the 413 boundary used by the funnel', () => {
    const atCap = {
      role: 'user',
      parts: [{ type: 'text', text: 'x'.repeat(MAX_SHARE_MESSAGE_CHARS) }],
    } as unknown as UIMessage;
    const overCap = {
      role: 'user',
      parts: [{ type: 'text', text: 'x'.repeat(MAX_SHARE_MESSAGE_CHARS + 1) }],
    } as unknown as UIMessage;
    expect(uiMessageTextLength(atCap)).toBe(MAX_SHARE_MESSAGE_CHARS);
    expect(uiMessageTextLength(overCap)).toBeGreaterThan(MAX_SHARE_MESSAGE_CHARS);
  });
});
