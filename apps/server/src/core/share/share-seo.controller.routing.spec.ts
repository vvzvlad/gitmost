import * as fs from 'node:fs';
import { ShareSeoController } from './share-seo.controller';

/**
 * Routing guard for ShareSeoController.getShare (red-team finding #3).
 *
 * The SEO route must NOT leak a shared page's <title>/og:title to anonymous
 * visitors / crawlers when the page is not publicly readable. It previously
 * called the raw `getShareForPage`, which skips the restricted-ancestor gate, so
 * a permission-restricted descendant of an includeSubPages share leaked its
 * title. The fix funnels through `resolveReadableSharePage` (the canonical gate)
 * AND honours `isSharingAllowed`. These tests pin that routing: a non-readable
 * page or sharing-disabled space serves the plain SPA index (no title); only a
 * readable, still-shared page gets meta tags.
 */

const SECRET_TITLE = 'Restricted Quarterly Numbers';
const INDEX_HTML = `<!doctype html><html><head><title>App</title><!--meta-tags--></head><body></body></html>`;
const STREAM_SENTINEL = { __isStream: true } as unknown as fs.ReadStream;

// Stub fs at CALL time (jest.spyOn), NOT module load (jest.mock): the controller
// transitively pulls bcrypt, whose native module is located by node-gyp-build
// reading the filesystem at import time — a module-level fs mock breaks that.
beforeEach(() => {
  jest.spyOn(fs, 'existsSync').mockReturnValue(true);
  jest.spyOn(fs, 'readFileSync').mockReturnValue(INDEX_HTML);
  jest.spyOn(fs, 'createReadStream').mockReturnValue(STREAM_SENTINEL);
});
afterEach(() => jest.restoreAllMocks());

function makeRes() {
  const res: any = {
    sent: undefined as unknown,
    type: jest.fn(() => res),
    send: jest.fn((v: unknown) => {
      res.sent = v;
    }),
  };
  return res;
}

function makeController(opts: {
  resolved: { share: any; page: any } | null;
  sharingAllowed?: boolean;
}) {
  const shareService = {
    resolveReadableSharePage: jest.fn(async () => opts.resolved),
    isSharingAllowed: jest.fn(async () => opts.sharingAllowed ?? true),
    // Must NEVER be used by the SEO path anymore (the bypass is the bug).
    getShareForPage: jest.fn(async () => {
      throw new Error('getShareForPage must not be called by the SEO path');
    }),
  };
  const workspaceRepo = {
    findFirst: async () => ({ id: 'ws-1', settings: {} }),
  };
  const environmentService = { isSelfHosted: () => true };
  const controller = new ShareSeoController(
    shareService as any,
    workspaceRepo as any,
    environmentService as any,
  );
  return { controller, shareService };
}

const req: any = { raw: { headers: { host: 'self' } } };

describe('ShareSeoController.getShare routing (#3 title-leak gate)', () => {
  it('serves the plain index (NO title) when the page is not publicly readable', async () => {
    const { controller, shareService } = makeController({ resolved: null });
    const res = makeRes();

    await controller.getShare(res, req, 'share-key', `slug-pageB`);

    // The restricted-ancestor gate ran; the raw bypass did not.
    expect(shareService.resolveReadableSharePage).toHaveBeenCalled();
    expect(shareService.getShareForPage).not.toHaveBeenCalled();
    // The plain index stream was sent — NOT the title-bearing meta HTML.
    expect(res.sent).toBe(STREAM_SENTINEL);
  });

  it('serves the plain index when sharing was disabled at the workspace/space level', async () => {
    const { controller } = makeController({
      resolved: {
        share: { spaceId: 'sp-1', searchIndexing: true },
        page: { title: SECRET_TITLE },
      },
      sharingAllowed: false,
    });
    const res = makeRes();

    await controller.getShare(res, req, 'share-key', 'slug-pageB');

    // The plain index stream was sent, so the restricted title never reached
    // the response (it is only ever interpolated into the meta HTML string).
    expect(res.sent).toBe(STREAM_SENTINEL);
    expect(res.sent).not.toBe(SECRET_TITLE);
  });

  it('injects the title + meta for a readable, still-shared page', async () => {
    const { controller } = makeController({
      resolved: {
        share: { spaceId: 'sp-1', searchIndexing: true },
        page: { title: 'Public Handbook' },
      },
      sharingAllowed: true,
    });
    const res = makeRes();

    await controller.getShare(res, req, 'share-key', 'slug-pageA');

    expect(typeof res.sent).toBe('string');
    expect(res.sent as string).toContain('<title>Public Handbook</title>');
    expect(res.sent as string).toContain('og:title');
    // searchIndexing on => crawlable (no noindex).
    expect(res.sent as string).not.toContain('content="noindex"');
  });

  it('adds robots=noindex when the share opted out of search indexing', async () => {
    const { controller } = makeController({
      resolved: {
        share: { spaceId: 'sp-1', searchIndexing: false },
        page: { title: 'Internal Notes' },
      },
      sharingAllowed: true,
    });
    const res = makeRes();

    await controller.getShare(res, req, 'share-key', 'slug-pageA');

    expect(res.sent as string).toContain('content="noindex"');
  });
});
