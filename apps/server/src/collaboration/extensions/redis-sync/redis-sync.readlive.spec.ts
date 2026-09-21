import { RedisSyncExtension } from './redis-sync.extension';

/**
 * #647 refinement B/C — `readLiveIfLoaded` bridge contract (the primitive #654
 * gates on). Exercises the 6-property contract against a FAKE ioredis + fake
 * hocuspocus instance, with NO real Redis:
 *  2. never force-loads (owner-not-loaded / no-owner → loaded:false, no route);
 *  3. NON-CLAIMING — routing uses plain GET, NEVER `SET … NX`;
 *  4. distinguishes {loaded:false} from {loaded:false, unreachable:true};
 *  5. loaded ⇒ hydrated content (delegated to the owner-side handler);
 *  6. its OWN short timeout, separate from the 30s write customEventTTL.
 */

// JSON-based pack/unpack so the test can read the bridge's messages.
const pack = (m: any) => Buffer.from(JSON.stringify(m));
const unpack = (b: any) => JSON.parse(b.toString());

interface FakeClient {
  set: jest.Mock;
  get: jest.Mock;
  publish: jest.Mock;
  subscribe: jest.Mock;
  on: jest.Mock;
  disconnect: jest.Mock;
  __messageHandler?: (channel: Buffer, msg: Buffer) => void;
}

function makeClient(getImpl: () => Promise<string | null>): FakeClient {
  const client: FakeClient = {
    set: jest.fn(async () => 'OK'),
    get: jest.fn(getImpl),
    publish: jest.fn(async () => 1),
    subscribe: jest.fn(async () => undefined),
    on: jest.fn((event: string, handler: any) => {
      if (event === 'messageBuffer') client.__messageHandler = handler;
    }),
    disconnect: jest.fn(),
  };
  return client;
}

// The extension calls redis.duplicate() twice: #1 → pub, #2 → sub.
function makeRedis(getImpl: () => Promise<string | null>) {
  const clients: FakeClient[] = [];
  const redis = {
    duplicate: jest.fn(() => {
      const c = makeClient(getImpl);
      clients.push(c);
      return c;
    }),
  } as any;
  return { redis, clients };
}

function build(opts: {
  owner: string | null;
  documentsHas: boolean;
  readLiveContent?: jest.Mock;
  readProbeTTL?: number;
  customEventTTL?: number;
}) {
  const { redis, clients } = makeRedis(async () => opts.owner);
  const ext = new RedisSyncExtension<any>({
    redis,
    pack,
    unpack,
    serverId: 'me',
    prefix: 'collab',
    readProbeTTL: opts.readProbeTTL ?? 1500,
    customEventTTL: opts.customEventTTL ?? 30_000,
    customEvents: {
      readLiveContent:
        opts.readLiveContent ?? jest.fn(async () => ({ loaded: false })),
    } as any,
  });
  // Wire the fake hocuspocus instance (normally set in onConfigure).
  (ext as any).instance = {
    documents: { has: () => opts.documentsHas },
  };
  const [pub, sub] = clients;
  return { ext, pub, sub };
}

describe('RedisSyncExtension.readLiveIfLoaded (#647 §B)', () => {
  it('loaded locally → reads via the handler, no lock GET/SET at all', async () => {
    const readLiveContent = jest.fn(async () => ({
      loaded: true,
      content: { type: 'doc', content: [] },
      hash: 'h1',
    }));
    const { ext, pub } = build({
      owner: null,
      documentsHas: true,
      readLiveContent,
    });

    const res = await ext.readLiveIfLoaded('page.uuid-1');

    expect(res).toEqual({
      loaded: true,
      content: { type: 'doc', content: [] },
      hash: 'h1',
    });
    expect(readLiveContent).toHaveBeenCalledWith('page.uuid-1', undefined);
    // Loaded here: no ownership probe needed.
    expect(pub.get).not.toHaveBeenCalled();
    expect(pub.set).not.toHaveBeenCalled();
  });

  it('no owner → {loaded:false}; probes with GET and NEVER claims (no SET)', async () => {
    const { ext, pub } = build({ owner: null, documentsHas: false });

    const res = await ext.readLiveIfLoaded('page.uuid-1');

    expect(res).toEqual({ loaded: false });
    // property 3: non-claiming — a plain GET, never SET (…NX).
    expect(pub.get).toHaveBeenCalledWith('collabLock:page.uuid-1');
    expect(pub.set).not.toHaveBeenCalled();
  });

  it('we own the lock but have not hydrated → {loaded:false}, still no SET', async () => {
    const { ext, pub } = build({ owner: 'me', documentsHas: false });

    const res = await ext.readLiveIfLoaded('page.uuid-1');

    expect(res).toEqual({ loaded: false });
    expect(pub.set).not.toHaveBeenCalled();
  });

  it('another owner + no reply → {loaded:false, unreachable:true} within the short timeout', async () => {
    const { ext, pub } = build({
      owner: 'other',
      documentsHas: false,
      // Short read timeout, huge write TTL: proves the probe uses ITS OWN
      // timeout (property 6), not the 30s customEventTTL.
      readProbeTTL: 40,
      customEventTTL: 30_000,
    });

    const started = Date.now();
    const res = await ext.readLiveIfLoaded('page.uuid-1');
    const elapsed = Date.now() - started;

    // property 4: unreachable is DISTINCT from not-loaded.
    expect(res).toEqual({ loaded: false, unreachable: true });
    // property 6: returned within its own short timeout, nowhere near 30s.
    expect(elapsed).toBeLessThan(1000);
    // still non-claiming: a probe published, never a SET-NX claim.
    expect(pub.set).not.toHaveBeenCalled();
    expect(pub.publish).toHaveBeenCalled();
  });

  it('a per-call timeoutMs overrides the default readProbeTTL', async () => {
    const { ext } = build({
      owner: 'other',
      documentsHas: false,
      readProbeTTL: 5_000,
    });
    const started = Date.now();
    const res = await ext.readLiveIfLoaded('page.uuid-1', { timeoutMs: 30 });
    expect(res).toEqual({ loaded: false, unreachable: true });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('another owner that replies loaded → returns the hydrated payload', async () => {
    const { ext, pub, sub } = build({
      owner: 'other',
      documentsHas: false,
      readProbeTTL: 2000,
    });

    // When the bridge publishes the probe, simulate the owner's reply by feeding
    // a customEventComplete back through the sub's messageBuffer handler. Done
    // asynchronously so the bridge has registered its pending resolver first.
    pub.publish.mockImplementation(async (_channel: string, packed: Buffer) => {
      const start = unpack(packed);
      setImmediate(() => {
        sub.__messageHandler?.(
          Buffer.from('collabMsg:me'),
          pack({
            type: 'customEventComplete',
            replyId: start.replyId,
            payload: { loaded: true, content: { type: 'doc' }, hash: 'hh' },
          }),
        );
      });
      return 1;
    });

    const res = await ext.readLiveIfLoaded('page.uuid-1');
    expect(res).toEqual({ loaded: true, content: { type: 'doc' }, hash: 'hh' });
  });
});
