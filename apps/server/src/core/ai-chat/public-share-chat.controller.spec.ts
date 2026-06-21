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
  /**
   * Default share + page resolve: the canonical boundary returns a usable share
   * (matching SHARE-A) with a live, unrestricted page. The default share id is
   * SHARE-A so the share-id match passes; tests override `resolveReadableSharePage`
   * to simulate a cross-share swap / restricted / out-of-tree (all => null).
   */
  function makeDeps(over: {
    assistantEnabled?: boolean;
    resolveReadableSharePage?: jest.Mock;
    isSharingAllowed?: jest.Mock;
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
      // The SINGLE canonical (shareId, pageId) -> readable page boundary.
      // Returns { share, page } on success, null on ANY access failure
      // (out-of-tree / cross-share id swap / deleted / restricted descendant).
      resolveReadableSharePage:
        over.resolveReadableSharePage ??
        jest.fn().mockResolvedValue({
          share: {
            id: 'SHARE-A',
            pageId: 'root-page',
            spaceId: 'space-1',
            sharedPage: { id: 'root-page', title: 'Root' },
          },
          page: { id: 'opened-uuid' },
        }),
      isSharingAllowed:
        over.isSharingAllowed ?? jest.fn().mockResolvedValue(true),
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
      publicShareChat: publicShareChat as never,
    };
    return {
      deps,
      aiSettings,
      shareService,
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
    const { deps, shareService, publicShareChat } = makeDeps({
      assistantEnabled: false,
    });
    expect(await statusOf(deps, body())).toBe(404);
    // The whole share/page resolve is skipped when the feature is off.
    expect(shareService.resolveReadableSharePage).not.toHaveBeenCalled();
    expect(publicShareChat.getShareChatModel).not.toHaveBeenCalled();
  });

  it('share.id !== body.shareId => 404 (cross-share id swap rejected)', async () => {
    // A cross-share id swap makes the canonical boundary return null (it checks
    // share.id === requested shareId internally).
    const { deps, shareService, publicShareChat } = makeDeps({
      resolveReadableSharePage: jest.fn().mockResolvedValue(null),
    });
    expect(await statusOf(deps, body({ shareId: 'SHARE-A' }))).toBe(404);
    expect(shareService.resolveReadableSharePage).toHaveBeenCalledWith(
      'SHARE-A',
      'opened-page',
      'ws-1',
    );
    // Never reached the model resolution for an unusable share.
    expect(publicShareChat.getShareChatModel).not.toHaveBeenCalled();
  });

  it('opened page unresolvable / deleted (resolve -> null) => fail-closed 404', async () => {
    const { deps } = makeDeps({
      resolveReadableSharePage: jest.fn().mockResolvedValue(null),
    });
    expect(await statusOf(deps, body())).toBe(404);
  });

  it('restricted descendant => 404 (same as out-of-tree, no existence leak)', async () => {
    // The canonical boundary folds the restricted-ancestor gate in: a restricted
    // descendant resolves to null, indistinguishable from an out-of-tree page.
    const { deps, shareService } = makeDeps({
      resolveReadableSharePage: jest.fn().mockResolvedValue(null),
    });
    expect(await statusOf(deps, body())).toBe(404);
    expect(shareService.resolveReadableSharePage).toHaveBeenCalled();
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

  it('a message with a non-text part => 400 Unsupported message content', async () => {
    // The anonymous path runs no tools, so a client-supplied tool/file/data part
    // is never legitimate and is rejected before it can reach the model context.
    const { deps } = makeDeps();
    const nonText = {
      role: 'user',
      parts: [{ type: 'tool-call' }],
    };
    let caught: HttpException | null = null;
    try {
      await resolveShareAssistantRequest(deps, {
        workspaceId: 'ws-1',
        body: body({ messages: [nonText] }) as never,
      });
    } catch (err) {
      caught = err instanceof HttpException ? err : null;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect(caught!.getStatus()).toBe(400);
    expect(caught!.message).toBe('Unsupported message content');
  });

  it('a message mixing a text part AND a non-text part => still 400 (rejected before the 413 size check)', async () => {
    // A forged non-text part smuggled alongside a legit text part is still
    // rejected: the non-text guard runs BEFORE the char-cap (413) check, so even
    // an over-long mixed message surfaces the 400, not the size error.
    const { deps } = makeDeps();
    const mixed = {
      role: 'user',
      parts: [
        { type: 'text', text: 'x'.repeat(MAX_SHARE_MESSAGE_CHARS + 1) },
        { type: 'tool-call' },
      ],
    };
    let caught: HttpException | null = null;
    try {
      await resolveShareAssistantRequest(deps, {
        workspaceId: 'ws-1',
        body: body({ messages: [mixed] }) as never,
      });
    } catch (err) {
      caught = err instanceof HttpException ? err : null;
    }
    expect(caught).toBeInstanceOf(HttpException);
    // The non-text guard wins over the 413 size cap even though the text part
    // alone would exceed MAX_SHARE_MESSAGE_CHARS.
    expect(caught!.getStatus()).toBe(400);
    expect(caught!.message).toBe('Unsupported message content');
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
