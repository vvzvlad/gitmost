import { McpClientsService, McpAuthUnreadableError } from './mcp-clients.service';
import { CACHE_KEY_SEP } from './mcp.constants';

/**
 * #686 phase 3 — per-user cache lifecycle correctness.
 *
 * The toolset cache is now keyed PER-USER (`${workspaceId}\0${userId}`), and its
 * lifecycle carries several enumerated hazards. Every test here NEUTER-PROVES the
 * guard it names (the comment on each states what reddens if the guard is removed):
 *   - per-user key + admin∪personal union with admin-first name disambiguation;
 *   - split invalidation: admin CRUD = workspace PREFIX fan-out;
 *     personal CRUD / user-delete = single-key;
 *   - identity-aware eviction (a stale timer never evicts a fresh rebuild);
 *   - the TTL timer routes through the per-user path, NOT the fan-out (no storm);
 *   - the one-shot uncached set for the evict-pending-build hole;
 *   - the pending-path liveness guard (a closed cached entry is never served);
 *   - recovery re-read refuses on a missing/disabled/changed row;
 *   - undecryptable headers skip (auth-unreadable), never an anonymous connect.
 */

type FakeServer = {
  id: string;
  name: string;
  transport: 'http' | 'sse';
  url: string;
  headersEnc: string | null;
  toolAllowlist: string[] | null;
  instructions: string | null;
  userId: string | null;
  workspaceId: string;
  enabled: boolean;
  updatedAt: Date;
};

const server = (over: Partial<FakeServer> = {}): FakeServer => ({
  id: 's1',
  name: 'srv',
  transport: 'http',
  url: 'http://example.test/mcp',
  headersEnc: null,
  toolAllowlist: null,
  instructions: null,
  userId: null,
  workspaceId: 'ws',
  enabled: true,
  updatedAt: new Date('2020-01-01T00:00:00.000Z'),
  ...over,
});

type FakeClient = { tools: () => Promise<any>; close: jest.Mock };

/**
 * Build a service with a repo whose `listEnabledForAgent(ws, userId)` returns a
 * per-(ws,userId) server list, plus `findByIdRaw` for the recovery re-read. The
 * private `connect` is stubbed so no real network happens: each server exposes one
 * tool named `tool` whose `description` is the SERVER ID (so a merge-collision test
 * can tell which server kept a canonical key).
 */
function buildService(opts: {
  serversFor?: (ws: string, userId: string) => FakeServer[];
  servers?: FakeServer[];
  secretBox?: any;
  connectImpl?: (s: FakeServer) => Promise<FakeClient>;
}) {
  const serversFor =
    opts.serversFor ?? ((_ws: string, _u: string) => opts.servers ?? []);
  const repo = {
    listEnabledForAgent: jest.fn(async (ws: string, userId: string) =>
      serversFor(ws, userId),
    ),
    findByIdRaw: jest.fn(async (id: string) =>
      (opts.servers ?? serversFor('ws', '')).find((s) => s.id === id),
    ),
  };
  const service = new McpClientsService(
    repo as never,
    (opts.secretBox ?? {}) as never,
  );

  const clients: FakeClient[] = [];
  const defaultConnect = async (s: FakeServer): Promise<FakeClient> => {
    const client: FakeClient = {
      tools: async () => ({
        tool: { description: s.id, execute: jest.fn().mockResolvedValue('ok') },
      }),
      close: jest.fn().mockResolvedValue(undefined),
    };
    clients.push(client);
    return client;
  };
  const connectSpy = jest
    .spyOn(
      service as unknown as { connect: (s: FakeServer) => Promise<unknown> },
      'connect',
    )
    .mockImplementation(opts.connectImpl ?? (defaultConnect as any));

  return { service, repo, connectSpy, clients };
}

function cacheMap(service: McpClientsService): Map<string, Promise<any>> {
  return (service as unknown as { cache: Map<string, Promise<any>> }).cache;
}
const keyOf = (ws: string, u: string) => `${ws}${CACHE_KEY_SEP}${u}`;

/** Minimal entry shape the lease/eviction logic operates on. */
function makeEntry(over: Partial<any> = {}): any {
  return {
    tools: { t: { description: 'x', execute: jest.fn() } },
    clients: [] as FakeClient[],
    outcomes: [],
    instructions: [],
    servers: [],
    toolMeta: {},
    expiresAt: Date.now() + 60_000,
    refCount: 0,
    evicted: false,
    closed: false,
    ...over,
  };
}

afterEach(() => jest.restoreAllMocks());

describe('per-user cache key + admin∪personal union (#686)', () => {
  it('keys the cache per-user and reads the union via listEnabledForAgent(ws,userId)', async () => {
    const { service, repo } = buildService({
      serversFor: (_ws, userId) => [server({ id: `s-${userId}` })],
    });

    await service.toolsFor('ws', 'userA');
    await service.toolsFor('ws', 'userB');

    // Two DISTINCT per-user entries — no cross-user sharing.
    expect(cacheMap(service).has(keyOf('ws', 'userA'))).toBe(true);
    expect(cacheMap(service).has(keyOf('ws', 'userB'))).toBe(true);
    // The agent-union read was called with each user's id (NOT the admin-only read).
    expect(repo.listEnabledForAgent).toHaveBeenCalledWith('ws', 'userA');
    expect(repo.listEnabledForAgent).toHaveBeenCalledWith('ws', 'userB');
  });

  it('admin server keeps the canonical namespace prefix on a name collision (admin-first)', async () => {
    // Admin + personal server with the SAME sanitized name -> same prefix. The
    // repo returns admin FIRST (its real ordering), so admin merges first and keeps
    // the canonical `dup_tool`; the personal one is disambiguated, never dropped.
    const union = () => [
      server({ id: 'admin', name: 'dup', userId: null }),
      server({ id: 'personal', name: 'dup', userId: 'userA' }),
    ];
    const { service } = buildService({ serversFor: union, servers: union() });

    const toolset = await service.toolsFor('ws', 'userA');
    const keys = Object.keys(toolset.tools);
    // Both tools survive the merge (no silent overwrite).
    expect(keys).toHaveLength(2);
    // The canonical `dup_tool` exists AND is the ADMIN server's tool (its tool
    // description is the admin server id); the personal one got a different key.
    expect(toolset.tools['dup_tool']).toBeDefined();
    expect((toolset.tools['dup_tool'] as any).description).toBe('admin');
    // Neuter: if personal merged FIRST (no admin-first order) or overwrote the key,
    // dup_tool would be the personal tool / there would be one key.
    expect(keys.find((k) => k !== 'dup_tool')).not.toBe('dup_tool');
  });
});

describe('split invalidation: admin fan-out vs single-user (#686)', () => {
  it('invalidate(ws) is a PREFIX fan-out: evicts EVERY user in the workspace', async () => {
    const { service } = buildService({ servers: [server()] });
    await service.toolsFor('ws', 'userA');
    await service.toolsFor('ws', 'userB');
    await service.toolsFor('other', 'userA');

    service.invalidate('ws');

    // Both ws users evicted; a different workspace's entry is untouched.
    expect(cacheMap(service).has(keyOf('ws', 'userA'))).toBe(false);
    expect(cacheMap(service).has(keyOf('ws', 'userB'))).toBe(false);
    expect(cacheMap(service).has(keyOf('other', 'userA'))).toBe(true);
  });

  it('invalidateUser(ws,user) evicts ONLY that user; other users stay warm', async () => {
    const { service } = buildService({ servers: [server()] });
    await service.toolsFor('ws', 'userA');
    await service.toolsFor('ws', 'userB');

    service.invalidateUser('ws', 'userA');

    // Neuter: if invalidateUser fanned out (used the workspace prefix), userB
    // would be gone too.
    expect(cacheMap(service).has(keyOf('ws', 'userA'))).toBe(false);
    expect(cacheMap(service).has(keyOf('ws', 'userB'))).toBe(true);
  });
});

describe('identity-aware eviction: a stale timer never evicts a fresh rebuild (#686)', () => {
  it('expireEntry(key, OLD) does not evict the NEW entry now cached at the same key', async () => {
    const { service } = buildService({ servers: [server()] });

    await service.toolsFor('ws', 'userA');
    const key = keyOf('ws', 'userA');
    const e1 = await cacheMap(service).get(key)!;

    // Evict E1 (models its TTL/CRUD eviction) and rebuild a FRESH entry E2.
    service.invalidateUser('ws', 'userA');
    await service.toolsFor('ws', 'userA');
    const e2 = await cacheMap(service).get(key)!;
    expect(e2).not.toBe(e1);

    // Fire E1's STALE timer callback by hand. Identity-aware: it must NOT evict E2.
    (
      service as unknown as { expireEntry: (k: string, e: unknown) => void }
    ).expireEntry(key, e1);
    await Promise.resolve();
    await Promise.resolve();

    // Neuter: without the `current === entry` identity check, expireEntry would
    // delete the map slot (holding E2) and evict E2 — closing a live toolset.
    expect(cacheMap(service).has(key)).toBe(true);
    expect(await cacheMap(service).get(key)!).toBe(e2);
    expect(e2.evicted).toBe(false);
  });
});

describe('TTL timer routes per-user, never the workspace fan-out (#686)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('a TTL expiry evicts only via the per-user path and NEVER calls invalidate(ws)', async () => {
    const { service } = buildService({ servers: [server()] });
    await service.toolsFor('ws', 'userA');
    await service.toolsFor('ws', 'userB');

    const invalidateSpy = jest.spyOn(service, 'invalidate');
    const expireSpy = jest.spyOn(
      service as unknown as { expireEntry: (k: string, e: unknown) => void },
      'expireEntry',
    );

    // Advance past the 60s TTL so BOTH per-user timers fire.
    await jest.advanceTimersByTimeAsync(61_000);

    // Neuter: if the timer were repointed to invalidate(workspaceId) (fan-out),
    // ONE user's expiry would storm-evict every other user AND invalidateSpy would
    // fire. The per-user path calls expireEntry per key and never fans out.
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(expireSpy).toHaveBeenCalledTimes(2);
    expect(cacheMap(service).has(keyOf('ws', 'userA'))).toBe(false);
    expect(cacheMap(service).has(keyOf('ws', 'userB'))).toBe(false);
  });
});

describe('one-shot uncached set for the evict-pending-build hole (#686)', () => {
  it('when the cached build resolves already-evicted, serves a one-shot that closes EXACTLY once', async () => {
    const { service } = buildService({ servers: [server()] });

    // The cached build resolves ALREADY evicted+closed (models an invalidation that
    // landed mid-build and closed the refCount-0 entry). The one-shot rebuild
    // returns a LIVE entry (pre-`evicted` so release closes it, refCount 0).
    const liveClient: FakeClient = {
      tools: async () => ({}),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const evictedBuild = makeEntry({
      evicted: true,
      closed: true,
      clients: [
        { tools: async () => ({}), close: jest.fn() } as unknown as FakeClient,
      ],
    });
    const oneShot = makeEntry({ evicted: true, clients: [liveClient] });

    jest
      .spyOn(service as any, 'buildEntry')
      .mockImplementation(async (..._args: any[]) => {
        const opts = _args[2] as { oneShot?: boolean } | undefined;
        return opts?.oneShot ? oneShot : evictedBuild;
      });

    const toolset = await service.toolsFor('ws', 'userA');

    // Neuter: without the `entry.evicted` one-shot fallback, toolsFor would lease
    // the CLOSED evictedBuild and hand back dead clients.
    expect(oneShot.refCount).toBe(1); // one-shot leased (inc -> 1)
    expect(Object.keys(toolset.tools).length).toBeGreaterThan(0); // live
    expect(liveClient.close).not.toHaveBeenCalled();

    await Promise.all(toolset.clients.map((c) => c.close()));
    expect(oneShot.refCount).toBe(0);
    expect(liveClient.close).toHaveBeenCalledTimes(1); // closes EXACTLY once
    // Idempotent: releasing again does not double-close.
    await Promise.all(toolset.clients.map((c) => c.close()));
    expect(liveClient.close).toHaveBeenCalledTimes(1);
  });
});

describe('pending-path liveness guard (#686 TOCTOU)', () => {
  it('never leases/serves a cached entry that is already closed — rebuilds fresh', async () => {
    const { service, connectSpy } = buildService({ servers: [server()] });
    const key = keyOf('ws', 'userA');
    const deadClient: FakeClient = {
      tools: async () => ({}),
      close: jest.fn().mockResolvedValue(undefined),
    };
    // Seed a CLOSED+evicted entry (models a TTL eviction that already ran).
    cacheMap(service).set(
      key,
      Promise.resolve(
        makeEntry({ evicted: true, closed: true, clients: [deadClient] }),
      ),
    );

    const toolset = await service.toolsFor('ws', 'userA');

    // Neuter: without the `!entry.evicted && !entry.closed` liveness guard,
    // toolsFor would lease the DEAD entry and serve its (closed) clients without
    // rebuilding — connect would NOT be called.
    expect(connectSpy).toHaveBeenCalled();
    expect(deadClient.close).not.toHaveBeenCalled();
    expect(Object.keys(toolset.tools).length).toBeGreaterThan(0);
  });
});

describe('recovery re-read refuses on a missing/disabled/changed row (#686)', () => {
  // Drive a readOnly tool through a transport break so the recovery path attempts
  // a reconnect; the re-read guard must REFUSE (no second connect, error surfaces).
  async function driveBrokenReadOnlyTool(
    findByIdRawResult: FakeServer | undefined,
  ) {
    const s = server({ id: 's1' });
    const repo = {
      listEnabledForAgent: jest.fn().mockResolvedValue([s]),
      findByIdRaw: jest.fn().mockResolvedValue(findByIdRawResult),
    };
    const service = new McpClientsService(repo as never, {} as never);
    jest.spyOn(service as any, 'isInternalDocmostServer').mockReturnValue(true);
    (service as any).writeClassMapPromise = Promise.resolve({ tool: 'readOnly' });

    const transportErr = Object.assign(new TypeError('fetch failed'), {
      cause: { name: 'SocketError', code: 'UND_ERR_SOCKET' },
    });
    const first = jest.fn().mockRejectedValue(transportErr);
    const connectSpy = jest.spyOn(service as any, 'connect').mockResolvedValue({
      tools: async () => ({ tool: { description: 'x', execute: first } }),
      close: jest.fn().mockResolvedValue(undefined),
    });

    const toolset = await service.toolsFor('ws', 'userA');
    const tool = toolset.tools['srv_tool'];
    const call = (tool.execute as any)(
      {},
      { toolCallId: 't', messages: [], abortSignal: undefined },
    );
    return { call, connectSpy };
  }

  it('refuses when the row is MISSING (deleted) — no reconnect, error surfaces', async () => {
    const { call, connectSpy } = await driveBrokenReadOnlyTool(undefined);
    await expect(call).rejects.toBeDefined();
    // Only the initial build connect — the guard threw BEFORE a reconnect connect.
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  it('refuses when the row is DISABLED', async () => {
    const { call, connectSpy } = await driveBrokenReadOnlyTool(
      server({ id: 's1', enabled: false }),
    );
    await expect(call).rejects.toBeDefined();
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  it('refuses when the row CHANGED (updatedAt moved)', async () => {
    const { call, connectSpy } = await driveBrokenReadOnlyTool(
      server({ id: 's1', updatedAt: new Date('2021-06-06T00:00:00.000Z') }),
    );
    await expect(call).rejects.toBeDefined();
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });
});

describe('undecryptable auth headers are skipped, never connected anonymously (#686)', () => {
  it('decryptHeaders throws McpAuthUnreadableError for a PRESENT-but-unreadable blob', () => {
    const secretBox = {
      decryptSecret: jest.fn(() => {
        throw new Error('bad key');
      }),
    };
    const service = new McpClientsService({} as never, secretBox as never);
    // Present blob -> throws (NOT undefined, which would connect anonymously).
    expect(() => (service as any).decryptHeaders('enc-blob', 's1', 'ws')).toThrow(
      McpAuthUnreadableError,
    );
    // Absent blob -> undefined (a legitimately anonymous server is unaffected).
    expect((service as any).decryptHeaders(null)).toBeUndefined();
  });

  it('buildEntry records an `auth-unreadable` outcome and contributes ZERO tools', async () => {
    const { service } = buildService({
      servers: [server({ id: 's1', name: 'srv', headersEnc: 'enc' })],
      // connect throws exactly as decryptHeaders would on an unreadable blob.
      connectImpl: async () => {
        throw new McpAuthUnreadableError('s1', 'ws');
      },
    });

    const toolset = await service.toolsFor('ws', 'userA');

    // The server is skipped with the DISTINCT reason (NOT a generic network fail,
    // which is what an anonymous-connect-then-401 would have produced).
    expect(toolset.outcomes).toEqual([
      { name: 'srv', ok: false, reason: 'auth-unreadable' },
    ]);
    expect(Object.keys(toolset.tools)).toHaveLength(0);
  });
});
