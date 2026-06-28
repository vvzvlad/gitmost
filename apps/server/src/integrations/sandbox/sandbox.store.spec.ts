import { createHash } from 'node:crypto';
import { validate as isValidUUID } from 'uuid';
import { SandboxStore } from './sandbox.store';

// Build a minimal EnvironmentService stub with overridable caps/TTL.
function makeEnv(
  overrides: Partial<{
    ttlMs: number;
    maxBytes: number;
    maxImageBytes: number;
    maxTotalBytes: number;
  }> = {},
) {
  const cfg = {
    ttlMs: 3_600_000,
    maxBytes: 8_388_608,
    maxImageBytes: 20_971_520,
    maxTotalBytes: 134_217_728,
    ...overrides,
  };
  return {
    getSandboxTtlMs: () => cfg.ttlMs,
    getSandboxMaxBytes: () => cfg.maxBytes,
    getSandboxMaxImageBytes: () => cfg.maxImageBytes,
    getSandboxMaxTotalBytes: () => cfg.maxTotalBytes,
    getSandboxPublicUrl: () => 'https://example.test',
  } as any;
}

describe('SandboxStore', () => {
  let store: SandboxStore;

  afterEach(() => {
    // Clear the unref'd sweep interval so it never leaks across tests.
    store?.onModuleDestroy();
    jest.useRealTimers();
  });

  it('put/get round-trips the exact bytes + mime and returns a UUID id', () => {
    store = new SandboxStore(makeEnv());
    const buf = Buffer.from('{"type":"doc","content":[]}', 'utf8');

    const res = store.put(buf, 'application/json');
    expect(isValidUUID(res.id)).toBe(true);
    expect(res.size).toBe(buf.length);

    const entry = store.get(res.id);
    expect(entry).toBeDefined();
    expect(entry!.buf.equals(buf)).toBe(true);
    expect(entry!.mime).toBe('application/json');
  });

  it('computes sha256 over the body (matches a manual digest)', () => {
    store = new SandboxStore(makeEnv());
    const buf = Buffer.from('hello sandbox', 'utf8');
    const expected = createHash('sha256').update(buf).digest('hex');

    const res = store.put(buf, 'text/plain');
    expect(res.sha256).toBe(expected);
    expect(store.get(res.id)!.sha256).toBe(expected);
  });

  it('returns undefined for a missing id', () => {
    store = new SandboxStore(makeEnv());
    expect(store.get('11111111-1111-1111-1111-111111111111')).toBeUndefined();
  });

  it('lazily expires entries past the TTL (get returns undefined)', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    store = new SandboxStore(makeEnv({ ttlMs: 1000 }));
    const res = store.put(Buffer.from('x'), 'text/plain');

    expect(store.get(res.id)).toBeDefined();
    jest.setSystemTime(new Date('2026-01-01T00:00:02Z')); // +2s > 1s TTL
    expect(store.get(res.id)).toBeUndefined();
    // Eviction also frees the byte accounting.
    expect(store.bytes).toBe(0);
  });

  it('background sweep drops expired entries without a get()', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    store = new SandboxStore(makeEnv({ ttlMs: 1000 }));
    store.put(Buffer.from('x'), 'text/plain');
    expect(store.size).toBe(1);

    jest.setSystemTime(new Date('2026-01-01T00:01:30Z')); // past TTL
    jest.advanceTimersByTime(60_000); // fire the sweep interval
    expect(store.size).toBe(0);
  });

  it('rejects a non-image blob over SANDBOX_MAX_BYTES', () => {
    store = new SandboxStore(makeEnv({ maxBytes: 16 }));
    expect(() => store.put(Buffer.alloc(17), 'application/json')).toThrow(
      /per-blob cap/,
    );
  });

  it('uses the larger image cap for image/* blobs', () => {
    // 100 bytes exceeds the doc cap (16) but fits the image cap (1024).
    store = new SandboxStore(makeEnv({ maxBytes: 16, maxImageBytes: 1024 }));
    expect(() => store.put(Buffer.alloc(100), 'image/png')).not.toThrow();
    // SVG counts as an image too.
    expect(() => store.put(Buffer.alloc(100), 'image/svg+xml')).not.toThrow();
  });

  it('evicts oldest entries when the total cap would be exceeded', () => {
    // Total cap 250 bytes; each blob 100 bytes -> only 2 fit at a time.
    store = new SandboxStore(
      makeEnv({ maxTotalBytes: 250, maxBytes: 1024 }),
    );
    const a = store.put(Buffer.alloc(100), 'application/json');
    const b = store.put(Buffer.alloc(100), 'application/json');
    const c = store.put(Buffer.alloc(100), 'application/json'); // evicts a

    expect(store.get(a.id)).toBeUndefined(); // oldest evicted
    expect(store.get(b.id)).toBeDefined();
    expect(store.get(c.id)).toBeDefined();
    expect(store.bytes).toBeLessThanOrEqual(250);
  });

  it('rejects a single blob larger than the whole total cap', () => {
    store = new SandboxStore(
      makeEnv({ maxTotalBytes: 50, maxBytes: 1024 }),
    );
    expect(() => store.put(Buffer.alloc(100), 'application/json')).toThrow(
      /total store cap/,
    );
  });

  it('putAndLink composes the anonymous /api/sb/<id> url with matching integrity', () => {
    store = new SandboxStore(makeEnv());
    const buf = Buffer.from('hello link', 'utf8');
    const expected = createHash('sha256').update(buf).digest('hex');

    const res = store.putAndLink(buf, 'image/png');
    expect(res.uri).toMatch(/^https:\/\/example\.test\/api\/sb\/[0-9a-f-]{36}$/);
    expect(res.sha256).toBe(expected);
    expect(res.size).toBe(buf.length);
  });

  it('has()/remove() report and free a blob by id', () => {
    store = new SandboxStore(makeEnv());
    const { id } = store.put(Buffer.from('x'), 'text/plain');

    expect(store.has(id)).toBe(true);
    store.remove(id);
    expect(store.has(id)).toBe(false);
    expect(store.bytes).toBe(0);
  });

  it('asSink() round-trips put/has/evict through the anonymous uri', () => {
    store = new SandboxStore(makeEnv());
    const sink = store.asSink();
    const buf = Buffer.from('sink bytes', 'utf8');

    const r = sink.put(buf, 'image/png');
    expect(sink.has(r.uri)).toBe(true);
    sink.evict(r.uri);
    expect(sink.has(r.uri)).toBe(false);
  });
});
