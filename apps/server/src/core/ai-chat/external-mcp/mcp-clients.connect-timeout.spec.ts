import { McpClientsService } from './mcp-clients.service';

/**
 * D1 — a HUNG MCP handshake must not POISON the per-workspace build cache.
 *
 * THE BUG (production hang): `createMCPClient` (inside the private `connect`) is
 * NOT bounded by a timeout and — like @ai-sdk/mcp's tool calls — its promise does
 * NOT settle on abort. A transient network blip mid-handshake made connect hang
 * FOREVER. Because getOrBuildEntry caches the build PROMISE, that never-settling
 * connect wedged EVERY later turn for the workspace (each awaited the same pending
 * build) — step_count stuck at 0, run row leaking 'running', chat 409ing forever.
 *
 * THE FIX: `connectWithTimeout` races `connect` against a SETTLING timeout
 * (CONNECT_TIMEOUT_MS). On timeout it REJECTS, so buildEntry catches it, records
 * the server `ok:false`, and the build COMPLETES with that server skipped — the
 * cache is never poisoned and a subsequent `toolsFor` returns instead of hanging.
 *
 * REACHABILITY NOTE: the smallest network-free path that exercises the fix is to
 * spy on the private `connect` (the same harness the namespacing spec uses) —
 * `connectWithTimeout` wraps exactly that call, so a never-resolving `connect`
 * models a never-settling `createMCPClient` precisely, without DNS/sockets.
 *
 * Fake timers prove the timeout fires WITHOUT real waiting.
 */

// Mirrors the private CONNECT_TIMEOUT_MS constant in mcp-clients.service.ts.
const CONNECT_TIMEOUT_MS = 5000;

interface FakeServer {
  id: string;
  name: string;
  transport: string;
  url: string;
  headersEnc: string | null;
  toolAllowlist: string[] | null;
  instructions?: string | null;
}

function server(
  over: Partial<FakeServer> & { id: string; name: string },
): FakeServer {
  return {
    transport: 'http',
    url: 'https://example.com/mcp',
    headersEnc: null,
    toolAllowlist: null,
    ...over,
  };
}

function buildService(servers: FakeServer[]) {
  const repoStub = { listEnabledForAgent: jest.fn().mockResolvedValue(servers) };
  const service = new McpClientsService(repoStub as never, {} as never);
  // Silence the expected "server unavailable" warning.
  jest
    .spyOn(
      (service as unknown as { logger: { warn: (...a: unknown[]) => void } })
        .logger,
      'warn',
    )
    .mockImplementation(() => undefined);
  return service;
}

// Spy on the private `connect` with a per-server implementation.
function stubConnect(
  service: McpClientsService,
  impl: (s: FakeServer) => Promise<unknown>,
) {
  return jest
    .spyOn(
      service as unknown as { connect: (s: FakeServer) => Promise<unknown> },
      'connect',
    )
    .mockImplementation(impl);
}

describe('McpClientsService.connectWithTimeout — hung connect does not poison the cache (D1)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('buildEntry completes (server recorded ok:false) when connect never settles, and toolsFor does not hang', async () => {
    const svc = buildService([server({ id: 'id-hung', name: 'hung' })]);
    // connect NEVER settles — models a wedged createMCPClient handshake.
    stubConnect(svc, () => new Promise<never>(() => {}));

    const toolsetPromise = svc.toolsFor('ws-1', 'user-1');
    // Drive fake time past the connect bound so connectWithTimeout rejects and
    // buildEntry catches it (records ok:false) — flushing the microtasks.
    await jest.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS + 1);

    const toolset = await toolsetPromise;
    // The build COMPLETED with the bad server skipped (no tools, ok:false).
    expect(Object.keys(toolset.tools)).toHaveLength(0);
    expect(toolset.outcomes).toEqual([
      { name: 'hung', ok: false, reason: 'MCP connect timed out after 5000ms' },
    ]);
    await Promise.all(toolset.clients.map((c) => c.close()));

    // The cache is NOT poisoned: a subsequent turn returns (served from the warm
    // cached entry) instead of awaiting a never-settling build.
    const again = await svc.toolsFor('ws-1', 'user-1');
    expect(Object.keys(again.tools)).toHaveLength(0);
    await Promise.all(again.clients.map((c) => c.close()));
  });

  it('a hung server is skipped but a healthy server in the SAME build still contributes its tools', async () => {
    const svc = buildService([
      server({ id: 'id-hung', name: 'hung' }),
      server({ id: 'id-ok', name: 'ok' }),
    ]);
    const okClient = {
      tools: () => Promise.resolve({ search: { description: 'x' } }),
      close: jest.fn().mockResolvedValue(undefined),
    };
    stubConnect(svc, (s) =>
      s.id === 'id-hung'
        ? new Promise<never>(() => {})
        : Promise.resolve(okClient),
    );

    const toolsetPromise = svc.toolsFor('ws-2', 'user-1');
    await jest.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS + 1);

    const toolset = await toolsetPromise;
    // Healthy server's tool survives (namespaced); hung server recorded ok:false.
    expect(Object.keys(toolset.tools)).toEqual(['ok_search']);
    expect(toolset.outcomes).toEqual([
      { name: 'hung', ok: false, reason: 'MCP connect timed out after 5000ms' },
      { name: 'ok', ok: true },
    ]);
    await Promise.all(toolset.clients.map((c) => c.close()));
  });

  it('closes the ORPHANED client when connect resolves LATE (after the timeout)', async () => {
    const svc = buildService([server({ id: 'id-late', name: 'late' })]);
    const lateClient = {
      tools: () => Promise.resolve({}),
      close: jest.fn().mockResolvedValue(undefined),
    };
    // connect resolves only AFTER the connect bound has already elapsed, so
    // connectWithTimeout has already rejected and must close this orphan.
    stubConnect(
      svc,
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(lateClient), CONNECT_TIMEOUT_MS * 2);
        }),
    );

    const toolsetPromise = svc.toolsFor('ws-3', 'user-1');
    // Fire the timeout: the build completes with the server skipped.
    await jest.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS + 1);
    const toolset = await toolsetPromise;
    expect(toolset.outcomes[0]?.ok).toBe(false);
    expect(lateClient.close).not.toHaveBeenCalled();

    // Now let the late connect resolve — the orphan must be closed, not leaked.
    await jest.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS * 2);
    expect(lateClient.close).toHaveBeenCalledTimes(1);

    await Promise.all(toolset.clients.map((c) => c.close()));
  });
});

describe('McpClientsService.buildEntry — closes a connected client whose tools() fails (leak fix)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('connect succeeds but tools() REJECTS: the client is close()d exactly once and the server is skipped, while a healthy server still contributes', async () => {
    const svc = buildService([
      server({ id: 'id-bad', name: 'bad' }),
      server({ id: 'id-ok', name: 'ok' }),
    ]);
    // The bad server connects fine, then tools() rejects — the client would leak if
    // buildEntry did not close it in the per-server catch (it was never registered).
    const badClient = {
      tools: () => Promise.reject(new Error('tools listing failed')),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const okClient = {
      tools: () => Promise.resolve({ search: { description: 'x' } }),
      close: jest.fn().mockResolvedValue(undefined),
    };
    stubConnect(svc, (s) =>
      s.id === 'id-bad' ? Promise.resolve(badClient) : Promise.resolve(okClient),
    );

    const toolset = await svc.toolsFor('ws-4', 'user-1');

    // The orphaned (never-registered) client is closed exactly once — no leak.
    expect(badClient.close).toHaveBeenCalledTimes(1);
    // Healthy server survives; bad server recorded ok:false and skipped.
    expect(Object.keys(toolset.tools)).toEqual(['ok_search']);
    expect(toolset.outcomes).toEqual([
      { name: 'bad', ok: false, reason: 'tools listing failed' },
      { name: 'ok', ok: true },
    ]);

    // The healthy (registered) client is NOT closed by the loop — it is owned by the
    // cache entry and stays warm (closed only on eviction/teardown, not on lease
    // release). Releasing the lease keeps it warm since the entry is not evicted.
    expect(okClient.close).not.toHaveBeenCalled();
    await Promise.all(toolset.clients.map((c) => c.close()));
    expect(okClient.close).not.toHaveBeenCalled();
    // The failed client is never double-closed.
    expect(badClient.close).toHaveBeenCalledTimes(1);
  });

  it('connect succeeds but tools() HANGS (times out): the client is close()d once and the server is skipped', async () => {
    const svc = buildService([server({ id: 'id-slow', name: 'slow' })]);
    const slowClient = {
      // tools() never settles -> withTimeout rejects after CONNECT_TIMEOUT_MS.
      tools: () => new Promise<Record<string, never>>(() => {}),
      close: jest.fn().mockResolvedValue(undefined),
    };
    stubConnect(svc, () => Promise.resolve(slowClient));

    const toolsetPromise = svc.toolsFor('ws-5', 'user-1');
    // Drive fake time past the tools() bound so withTimeout rejects.
    await jest.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS + 1);
    const toolset = await toolsetPromise;

    expect(slowClient.close).toHaveBeenCalledTimes(1);
    expect(Object.keys(toolset.tools)).toHaveLength(0);
    expect(toolset.outcomes[0]?.ok).toBe(false);
    await Promise.all(toolset.clients.map((c) => c.close()));
  });
});
