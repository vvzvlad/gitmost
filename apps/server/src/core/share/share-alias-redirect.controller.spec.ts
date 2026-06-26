import * as fs from 'node:fs';

// `@sindresorhus/slugify` is ESM-only and not in jest's transformIgnorePatterns,
// so the real module fails to parse under ts-jest. Stub it with a minimal,
// deterministic slugifier — this spec asserts the controller's slug *assembly*
// (`<title-slug>-<slugId>`, 70-char clamp, `untitled` fallback), not the upstream
// slug algorithm. The factory keeps the real ESM module from ever being loaded.
jest.mock('@sindresorhus/slugify', () => ({
  __esModule: true,
  default: (input: string) =>
    String(input)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, ''),
}));

import { ShareAliasRedirectController } from './share-alias-redirect.controller';

/**
 * Routing/leak guard for the PUBLIC `GET /l/:alias` resolver.
 *
 * This is the most security-sensitive surface of the alias feature: an
 * unauthenticated route that MUST serve the plain SPA index (exactly like any
 * unknown path) for an unknown / dangling / no-longer-readable alias so that the
 * existence of a name never leaks. Only a resolvable, still-readable alias may
 * 302 to the canonical `/share/<key>/p/<title-slug>-<slugId>` page (302 — never
 * 301 — because the target is retargetable). These tests pin that routing and
 * the defensive percent-decoding, mirroring `share-seo.controller.routing.spec`.
 */

const STREAM_SENTINEL = { __isStream: true } as unknown as fs.ReadStream;

// Stub fs at CALL time (jest.spyOn), NOT module load (jest.mock): the controller
// transitively pulls bcrypt, whose native module is located by node-gyp-build
// reading the filesystem at import time — a module-level fs mock breaks that.
beforeEach(() => {
  jest.spyOn(fs, 'existsSync').mockReturnValue(true);
  jest.spyOn(fs, 'createReadStream').mockReturnValue(STREAM_SENTINEL);
});
afterEach(() => jest.restoreAllMocks());

function makeRes() {
  const res: any = {
    sent: undefined as unknown,
    statusCode: undefined as number | undefined,
    redirectUrl: undefined as string | undefined,
    type: jest.fn(() => res),
    status: jest.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    send: jest.fn((v: unknown) => {
      res.sent = v;
      return res;
    }),
    redirect: jest.fn((url: string, code: number) => {
      res.redirectUrl = url;
      res.statusCode = code;
      return res;
    }),
  };
  return res;
}

function makeController(opts: {
  resolved?: { share: any; page: any } | null;
  selfHosted?: boolean;
}) {
  const shareAliasService = {
    resolveReadableTarget: jest.fn(async () => opts.resolved ?? null),
  };
  const workspaceRepo = {
    findFirst: jest.fn(async () => ({ id: 'ws-self' })),
    findByHostname: jest.fn(async (sub: string) =>
      sub === 'acme' ? { id: 'ws-acme' } : null,
    ),
  };
  const environmentService = {
    isSelfHosted: jest.fn(() => opts.selfHosted ?? true),
  };
  const controller = new ShareAliasRedirectController(
    shareAliasService as any,
    workspaceRepo as any,
    environmentService as any,
  );
  return { controller, shareAliasService, workspaceRepo, environmentService };
}

const selfReq: any = { raw: { headers: { host: 'self' } } };

describe('ShareAliasRedirectController.resolve', () => {
  it('302-redirects a resolvable alias to the canonical share page', async () => {
    const { controller, shareAliasService } = makeController({
      resolved: {
        share: { key: 'SHAREKEY' },
        page: { slugId: 'abc123', title: 'Quarterly Report' },
      },
    });
    const res = makeRes();

    await controller.resolve('promo', selfReq, res);

    expect(shareAliasService.resolveReadableTarget).toHaveBeenCalledWith(
      'promo',
      'ws-self',
    );
    expect(res.redirect).toHaveBeenCalledWith(
      '/share/SHAREKEY/p/quarterly-report-abc123',
      302,
    );
    // No index stream was served on a hit.
    expect(res.sent).toBeUndefined();
  });

  it('falls back to "untitled" in the slug when the target has no title', async () => {
    const { controller } = makeController({
      resolved: { share: { key: 'K' }, page: { slugId: 'sid', title: '' } },
    });
    const res = makeRes();

    await controller.resolve('promo', selfReq, res);

    expect(res.redirect).toHaveBeenCalledWith('/share/K/p/untitled-sid', 302);
  });

  it('streams the SPA index WITHOUT a 302 for an unknown/dangling/unreadable alias (no leak)', async () => {
    const { controller, shareAliasService } = makeController({ resolved: null });
    const res = makeRes();

    await controller.resolve('does-not-exist', selfReq, res);

    expect(shareAliasService.resolveReadableTarget).toHaveBeenCalled();
    // The plain index stream was served and no redirect leaked alias existence.
    expect(res.redirect).not.toHaveBeenCalled();
    expect(res.sent).toBe(STREAM_SENTINEL);
    expect(res.type).toHaveBeenCalledWith('text/html');
  });

  it('streams the SPA index without even resolving when the workspace is null', async () => {
    // Subdomain host that maps to no workspace => workspace === null.
    const { controller, shareAliasService, workspaceRepo } = makeController({
      selfHosted: false,
    });
    const res = makeRes();
    const req: any = { raw: { headers: { host: 'unknown.example.com' } } };

    await controller.resolve('promo', req, res);

    expect(workspaceRepo.findByHostname).toHaveBeenCalledWith('unknown');
    // Never even attempts to resolve (alias existence cannot leak per-host).
    expect(shareAliasService.resolveReadableTarget).not.toHaveBeenCalled();
    expect(res.redirect).not.toHaveBeenCalled();
    expect(res.sent).toBe(STREAM_SENTINEL);
  });

  it('defensively decodes broken percent-encoding and treats it as unknown', async () => {
    const { controller, shareAliasService } = makeController({ resolved: null });
    const res = makeRes();

    // '%E0%A4%A' is invalid -> decodeURIComponent throws -> raw value is used,
    // and the alias resolves to nothing (no crash, served as index).
    await controller.resolve('%E0%A4%A', selfReq, res);

    expect(shareAliasService.resolveReadableTarget).toHaveBeenCalledWith(
      '%E0%A4%A',
      'ws-self',
    );
    expect(res.redirect).not.toHaveBeenCalled();
    expect(res.sent).toBe(STREAM_SENTINEL);
  });

  it('decodes a valid percent-encoded alias before resolving', async () => {
    const { controller, shareAliasService } = makeController({ resolved: null });
    const res = makeRes();

    await controller.resolve('my%2Dlink', selfReq, res);

    expect(shareAliasService.resolveReadableTarget).toHaveBeenCalledWith(
      'my-link',
      'ws-self',
    );
  });

  it('resolves the workspace via findFirst on the self-hosted path', async () => {
    const { controller, workspaceRepo, shareAliasService } = makeController({
      selfHosted: true,
      resolved: null,
    });
    const res = makeRes();

    await controller.resolve('promo', selfReq, res);

    expect(workspaceRepo.findFirst).toHaveBeenCalled();
    expect(workspaceRepo.findByHostname).not.toHaveBeenCalled();
    expect(shareAliasService.resolveReadableTarget).toHaveBeenCalledWith(
      'promo',
      'ws-self',
    );
  });

  it('resolves the workspace via findByHostname (subdomain) on the cloud path', async () => {
    const { controller, workspaceRepo, shareAliasService } = makeController({
      selfHosted: false,
      resolved: null,
    });
    const res = makeRes();
    const req: any = { raw: { headers: { host: 'acme.example.com' } } };

    await controller.resolve('promo', req, res);

    expect(workspaceRepo.findByHostname).toHaveBeenCalledWith('acme');
    expect(workspaceRepo.findFirst).not.toHaveBeenCalled();
    expect(shareAliasService.resolveReadableTarget).toHaveBeenCalledWith(
      'promo',
      'ws-acme',
    );
  });

  it('serves a 404 when no built client index exists', async () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    const { controller } = makeController({ resolved: null });
    const res = makeRes();

    await controller.resolve('promo', selfReq, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.redirect).not.toHaveBeenCalled();
  });
});
