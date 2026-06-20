import { evaluateShareAssistantFunnel } from './public-share-chat.funnel';
import { buildShareSystemPrompt } from './public-share-chat.prompt';
import { PublicShareChatService } from './public-share-chat.service';
import { PublicShareChatToolsService } from './tools/public-share-chat-tools.service';
import { PublicShareWorkspaceLimiter } from './public-share-workspace-limiter';

/**
 * Guardrail-funnel ORDERING test for the anonymous public-share assistant.
 *
 * The order is security-relevant: the first failing condition must win, and the
 * status codes must hide whether the feature / share / private page exists.
 * (The full controller pulls in the Nest/DB graph, so we test the pure funnel
 * decision plus the model fallback and the share-scoping of `forShare`.)
 */
describe('evaluateShareAssistantFunnel ordering', () => {
  const allOk = {
    assistantEnabled: true,
    shareUsable: true,
    pageInShare: true,
    providerConfigured: true,
  };

  it('passes when every gate is satisfied', () => {
    expect(evaluateShareAssistantFunnel(allOk)).toEqual({ ok: true });
  });

  it('404s (assistant-disabled) FIRST when the toggle is off, even if everything else fails', () => {
    const out = evaluateShareAssistantFunnel({
      assistantEnabled: false,
      shareUsable: false,
      pageInShare: false,
      providerConfigured: false,
    });
    expect(out).toEqual({ ok: false, status: 404, reason: 'assistant-disabled' });
  });

  it('404s (share-not-found) when the toggle is on but the share is unusable', () => {
    const out = evaluateShareAssistantFunnel({
      ...allOk,
      shareUsable: false,
      pageInShare: false,
    });
    expect(out).toEqual({ ok: false, status: 404, reason: 'share-not-found' });
  });

  it('404s (page-not-in-share) when the share is usable but the page is outside it', () => {
    const out = evaluateShareAssistantFunnel({ ...allOk, pageInShare: false });
    expect(out).toEqual({ ok: false, status: 404, reason: 'page-not-in-share' });
  });

  it('503s (provider-not-configured) only after all access gates pass', () => {
    const out = evaluateShareAssistantFunnel({
      ...allOk,
      providerConfigured: false,
    });
    expect(out).toEqual({
      ok: false,
      status: 503,
      reason: 'provider-not-configured',
    });
  });

  it('hides the private-page case as a 404, never a 403/200', () => {
    const out = evaluateShareAssistantFunnel({ ...allOk, pageInShare: false });
    expect(out.ok).toBe(false);
    if (out.ok === false) expect(out.status).toBe(404);
  });
});

describe('buildShareSystemPrompt locking', () => {
  it('always includes the immutable read-only / share-scope safety rules', () => {
    const prompt = buildShareSystemPrompt({ share: null, openedPage: null });
    expect(prompt).toContain('read-only assistant');
    expect(prompt).toContain('CANNOT change anything');
    expect(prompt).toContain('this share');
    // Anti prompt-injection clause is present.
    expect(prompt).toContain('anti prompt-injection');
  });
});

describe('PublicShareChatService model fallback', () => {
  function makeService(resolvePublicModel: string | undefined) {
    const aiSettings = {
      resolve: jest
        .fn()
        .mockResolvedValue({ publicShareChatModel: resolvePublicModel }),
    };
    const getChatModel = jest.fn().mockResolvedValue('MODEL');
    const ai = { getChatModel };
    const service = new PublicShareChatService(
      ai as never,
      aiSettings as never,
      {} as never,
    );
    return { service, getChatModel };
  }

  it('passes the cheap publicShareChatModel as the override', async () => {
    const { service, getChatModel } = makeService('cheap-model');
    await service.getShareChatModel('ws-1');
    expect(getChatModel).toHaveBeenCalledWith('ws-1', {
      chatModel: 'cheap-model',
    });
  });

  it('passes undefined when unset so getChatModel falls back to chatModel', async () => {
    const { service, getChatModel } = makeService(undefined);
    await service.getShareChatModel('ws-1');
    expect(getChatModel).toHaveBeenCalledWith('ws-1', { chatModel: undefined });
  });
});

describe('PublicShareWorkspaceLimiter (IP-independent per-workspace cap)', () => {
  it('allows up to the cap within a window, then 429s (returns false)', () => {
    const limiter = new PublicShareWorkspaceLimiter(3, 60_000, () => 1_000);
    expect(limiter.tryConsume('ws-1')).toBe(true); // 1
    expect(limiter.tryConsume('ws-1')).toBe(true); // 2
    expect(limiter.tryConsume('ws-1')).toBe(true); // 3 (at cap)
    expect(limiter.tryConsume('ws-1')).toBe(false); // over cap
    expect(limiter.tryConsume('ws-1')).toBe(false); // stays over cap
  });

  it('resets the count when the window elapses', () => {
    let now = 1_000;
    const limiter = new PublicShareWorkspaceLimiter(2, 60_000, () => now);
    expect(limiter.tryConsume('ws-1')).toBe(true);
    expect(limiter.tryConsume('ws-1')).toBe(true);
    expect(limiter.tryConsume('ws-1')).toBe(false); // capped in window 1
    // Advance past the window boundary: a fresh window opens.
    now += 60_000;
    expect(limiter.tryConsume('ws-1')).toBe(true);
    expect(limiter.tryConsume('ws-1')).toBe(true);
    expect(limiter.tryConsume('ws-1')).toBe(false); // capped again in window 2
  });

  it('keeps separate counts per workspace (one over-cap ws cannot starve another)', () => {
    const limiter = new PublicShareWorkspaceLimiter(1, 60_000, () => 1_000);
    expect(limiter.tryConsume('ws-a')).toBe(true);
    expect(limiter.tryConsume('ws-a')).toBe(false); // ws-a capped
    expect(limiter.tryConsume('ws-b')).toBe(true); // ws-b unaffected
  });

  it('does not roll the window over until the FULL windowMs has elapsed', () => {
    let now = 0;
    const limiter = new PublicShareWorkspaceLimiter(1, 60_000, () => now);
    expect(limiter.tryConsume('ws-1')).toBe(true);
    now += 59_999; // just inside the window
    expect(limiter.tryConsume('ws-1')).toBe(false);
    now += 1; // exactly at windowMs -> new window
    expect(limiter.tryConsume('ws-1')).toBe(true);
  });
});

describe('PublicShareChatService.tryConsumeWorkspaceQuota', () => {
  it('delegates to the in-process per-workspace limiter', () => {
    const service = new PublicShareChatService(
      {} as never,
      {} as never,
      {} as never,
    );
    // The default cap is high, so a couple of calls are allowed; this asserts
    // the service exposes the limiter contour the controller relies on.
    expect(service.tryConsumeWorkspaceQuota('ws-1')).toBe(true);
    expect(service.tryConsumeWorkspaceQuota('ws-1')).toBe(true);
  });
});

describe('PublicShareChatToolsService share scoping', () => {
  it('getSharePage rejects a page that does not resolve to THIS share (no existence leak)', async () => {
    const shareService = {
      // The page resolves to a DIFFERENT share id.
      getShareForPage: jest.fn().mockResolvedValue({ id: 'OTHER-SHARE' }),
      updatePublicAttachments: jest.fn(),
    };
    const pageRepo = { findById: jest.fn() };
    const svc = new PublicShareChatToolsService(
      shareService as never,
      {} as never,
      pageRepo as never,
    );

    const tools = svc.forShare('THIS-SHARE', 'ws-1');
    const getSharePage = tools.getSharePage as {
      execute: (args: { pageId: string }) => Promise<unknown>;
    };

    await expect(getSharePage.execute({ pageId: 'p-outside' })).rejects.toThrow(
      /not part of this published share/i,
    );
    // It must NOT have fetched/returned any content for an out-of-share page.
    expect(pageRepo.findById).not.toHaveBeenCalled();
    expect(shareService.updatePublicAttachments).not.toHaveBeenCalled();
  });

  it('searchSharePages forwards the share scope (shareId, no spaceId/userId) to the FTS branch', async () => {
    const searchService = {
      searchPage: jest.fn().mockResolvedValue({
        items: [{ id: 'p1', title: 'T', highlight: 'snip' }],
      }),
    };
    const svc = new PublicShareChatToolsService(
      {} as never,
      searchService as never,
      {} as never,
    );
    const tools = svc.forShare('THIS-SHARE', 'ws-1');
    const searchSharePages = tools.searchSharePages as {
      execute: (args: { query: string }) => Promise<unknown>;
    };

    const res = await searchSharePages.execute({ query: 'hello' });
    const [params, opts] = searchService.searchPage.mock.calls[0];
    expect(params.shareId).toBe('THIS-SHARE');
    // The share-scoped FTS branch requires NO spaceId and NO userId.
    expect(params.spaceId).toBeUndefined();
    expect(opts.userId).toBeUndefined();
    expect(opts.workspaceId).toBe('ws-1');
    expect(res).toEqual([{ id: 'p1', title: 'T', snippet: 'snip' }]);
  });
});
