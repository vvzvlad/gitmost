import { McpClientsService } from './mcp-clients.service';

/**
 * #204 (Phase 1, highest-value MCP gap) — external MCP client lease / refcount /
 * eviction lifecycle.
 *
 * `toolsFor` hands the streaming turn a release handle; the real transports must
 * be closed EXACTLY once and only when (a) the cache entry has been evicted AND
 * (b) no turn still leases it. The bugs this guards against:
 *   - leak: an evicted entry whose clients are never closed (refCount stuck > 0);
 *   - premature close: a TTL/CRUD eviction closing a client a turn is still
 *     executing tool calls against;
 *   - double close: a release handle closing the same client more than once.
 *
 * The private `buildEntry` is stubbed so no real network/MCP connection happens;
 * we drive only the lease bookkeeping in `toolsFor` / `release` / `evict` /
 * `invalidate`, which is the untested surface.
 */
describe('McpClientsService lease/refcount/eviction', () => {
  type FakeClient = { tools: () => Promise<any>; close: jest.Mock };

  function fakeClient(): FakeClient {
    return {
      tools: async () => ({}),
      close: jest.fn().mockResolvedValue(undefined),
    };
  }

  // Minimal CacheEntry the service's lease logic operates on.
  function makeEntry(clients: FakeClient[]) {
    const timer = setTimeout(() => {}, 60_000);
    timer.unref?.();
    return {
      tools: {},
      clients,
      outcomes: [],
      instructions: [],
      expiresAt: Date.now() + 60_000,
      refCount: 0,
      evicted: false,
      closed: false,
      timer,
    } as any;
  }

  let service: McpClientsService;

  beforeEach(() => {
    service = new McpClientsService({} as any, {} as any);
  });

  function stubBuild(entry: any) {
    jest.spyOn(service as any, 'buildEntry').mockResolvedValue(entry);
  }

  it('leases on toolsFor and keeps the client warm (no close) on release', async () => {
    const client = fakeClient();
    const entry = makeEntry([client]);
    stubBuild(entry);

    const lease = await service.toolsFor('ws-1');
    expect(entry.refCount).toBe(1);

    await lease.clients[0].close();
    // Released but NOT evicted: the cached entry stays warm for reuse, so the
    // transport must NOT be closed yet.
    expect(entry.refCount).toBe(0);
    expect(client.close).not.toHaveBeenCalled();
  });

  it('defers close when an entry is evicted while still leased, then closes once on release', async () => {
    const client = fakeClient();
    const entry = makeEntry([client]);
    stubBuild(entry);

    const lease = await service.toolsFor('ws-2');
    (service as any).evict(entry);

    // Evicted under an active lease: close is deferred to the last release.
    expect(entry.evicted).toBe(true);
    expect(client.close).not.toHaveBeenCalled();

    await lease.clients[0].close();
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(entry.closed).toBe(true);
  });

  it('shares one entry across concurrent leases; closes only after the LAST release', async () => {
    const client = fakeClient();
    const entry = makeEntry([client]);
    stubBuild(entry);

    const lease1 = await service.toolsFor('ws-3');
    const lease2 = await service.toolsFor('ws-3');
    expect(entry.refCount).toBe(2);

    (service as any).evict(entry);

    await lease1.clients[0].close();
    // One lease remains: a stream could still be running — must stay open.
    expect(entry.refCount).toBe(1);
    expect(client.close).not.toHaveBeenCalled();

    await lease2.clients[0].close();
    expect(entry.refCount).toBe(0);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('release is idempotent: closing the same handle twice decrements once and closes once', async () => {
    const client = fakeClient();
    const entry = makeEntry([client]);
    stubBuild(entry);

    const lease = await service.toolsFor('ws-4');
    (service as any).evict(entry);

    await lease.clients[0].close();
    await lease.clients[0].close();

    expect(entry.refCount).toBe(0); // not -1
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('evicting an unleased entry closes its clients immediately', async () => {
    const client = fakeClient();
    const entry = makeEntry([client]);
    stubBuild(entry);

    const built = await (service as any).getOrBuildEntry('ws-5');
    expect(built.refCount).toBe(0);

    (service as any).evict(entry);
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(entry.closed).toBe(true);
  });

  it('invalidate (TTL/CRUD) does NOT close a client that a turn still leases', async () => {
    const client = fakeClient();
    const entry = makeEntry([client]);
    stubBuild(entry);

    const lease = await service.toolsFor('ws-6');
    expect(entry.refCount).toBe(1);

    service.invalidate('ws-6');
    // invalidate evicts asynchronously once the build promise resolves.
    await Promise.resolve();
    await Promise.resolve();

    expect(entry.evicted).toBe(true);
    // Still leased: the mid-turn eviction must not pull the transport.
    expect(client.close).not.toHaveBeenCalled();

    await lease.clients[0].close();
    expect(client.close).toHaveBeenCalledTimes(1);
  });
});
