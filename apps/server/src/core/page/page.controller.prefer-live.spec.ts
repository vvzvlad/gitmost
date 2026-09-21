import { PageController } from './page.controller';

// #654 — the /pages/info `preferLive` wiring: when set, the controller resolves
// the live-preferred content AFTER the permission gate and returns it plus the
// additive sibling fields (contentSource/fallbackReason); when unset, the live
// probe is never dinged and the response carries neither field (the cheap path).

const DB_CONTENT = {
  type: 'doc',
  content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'stale' }] }],
};
const LIVE_CONTENT = {
  type: 'doc',
  content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'fresh' }] }],
};

function makeController(
  page: any,
  preferLiveResult?: any,
  gateError?: Error,
) {
  const pageRepo = { findById: jest.fn().mockResolvedValue(page) } as any;
  const validateCanViewWithPermissions = gateError
    ? jest.fn().mockRejectedValue(gateError)
    : jest.fn().mockResolvedValue({ canEdit: true, hasRestriction: false });
  const pageAccessService = { validateCanViewWithPermissions } as any;
  const resolvePreferLiveContent = jest
    .fn()
    .mockResolvedValue(preferLiveResult);
  const pageService = { resolvePreferLiveContent } as any;
  const controller = new PageController(
    pageService,
    pageRepo,
    undefined as any, // pageHistoryService
    undefined as any, // spaceAbility
    pageAccessService,
    undefined as any, // backlinkService
    undefined as any, // labelService
    undefined as any, // auditService
  );
  return { controller, resolvePreferLiveContent, validateCanViewWithPermissions };
}

const user = { id: 'u1' } as any;

describe('PageController.getPage — preferLive (#654)', () => {
  it('preferLive -> returns live content + sibling contentSource:"live"', async () => {
    const { controller, resolvePreferLiveContent } = makeController(
      { id: 'p1', content: DB_CONTENT },
      { content: LIVE_CONTENT, contentSource: 'live' },
    );
    const res: any = await controller.getPage(
      { pageId: 'p1', preferLive: true } as any,
      user,
    );
    expect(resolvePreferLiveContent).toHaveBeenCalledWith('p1', DB_CONTENT);
    expect(res.content).toBe(LIVE_CONTENT); // NOT the DB row
    expect(res.contentSource).toBe('live');
    expect(res.fallbackReason).toBeUndefined();
    expect(res.permissions).toEqual({ canEdit: true, hasRestriction: false });
  });

  it('preferLive db-fallback -> DB content + contentSource:"db" + fallbackReason', async () => {
    const { controller } = makeController(
      { id: 'p1', content: DB_CONTENT },
      { content: DB_CONTENT, contentSource: 'db', fallbackReason: 'owner_unreachable' },
    );
    const res: any = await controller.getPage(
      { pageId: 'p1', preferLive: true } as any,
      user,
    );
    expect(res.content).toBe(DB_CONTENT);
    expect(res.contentSource).toBe('db');
    expect(res.fallbackReason).toBe('owner_unreachable');
  });

  it('loaded-but-DB-empty -> live content still returned (independent of the format gate)', async () => {
    // The DB row content is null (edit acked, store not yet flushed), but the doc
    // is loaded on the owner, so preferLive must still surface the live body.
    const { controller } = makeController(
      { id: 'p1', content: null },
      { content: LIVE_CONTENT, contentSource: 'live' },
    );
    const res: any = await controller.getPage(
      { pageId: 'p1', preferLive: true } as any,
      user,
    );
    expect(res.content).toBe(LIVE_CONTENT);
    expect(res.contentSource).toBe('live');
  });

  it('permission gate REJECTS -> error propagates AND the preferLive probe is NEVER reached (no IDOR leak)', async () => {
    // The view gate runs BEFORE the `if (dto.preferLive)` block. If a refactor
    // ever hoisted the preferLive resolve above the gate, a non-viewer would leak
    // live/unflushed content — this asserts the ORDER: the throw must short-circuit
    // the request before resolvePreferLiveContent is ever called.
    const denied = new Error('forbidden');
    const { controller, resolvePreferLiveContent } = makeController(
      { id: 'p1', content: DB_CONTENT },
      { content: LIVE_CONTENT, contentSource: 'live' },
      denied,
    );
    await expect(
      controller.getPage({ pageId: 'p1', preferLive: true } as any, user),
    ).rejects.toBe(denied);
    expect(resolvePreferLiveContent).not.toHaveBeenCalled();
  });

  it('WITHOUT preferLive -> live probe NOT called, no contentSource/fallbackReason', async () => {
    const { controller, resolvePreferLiveContent } = makeController({
      id: 'p1',
      content: DB_CONTENT,
    });
    const res: any = await controller.getPage({ pageId: 'p1' } as any, user);
    expect(resolvePreferLiveContent).not.toHaveBeenCalled();
    expect(res.content).toEqual(DB_CONTENT);
    expect(res.contentSource).toBeUndefined();
    expect(res.fallbackReason).toBeUndefined();
  });
});
