import { errors } from 'undici';
import {
  McpClientsService,
  isRetryableConnectError,
} from './mcp-clients.service';

/**
 * #489 — external-MCP in-run transport recovery.
 *
 * The transport-error classification + retry gate are exercised against the REAL
 * undici error CLASSES prod throws (`errors.SocketError` / `errors.BodyTimeoutError`,
 * carrying the true `UND_ERR_*` codes and class names), wrapped EXACTLY as undici's
 * `fetch` wraps them — a `TypeError('fetch failed'|'terminated')` whose `.cause` is
 * the undici error. These are the real classes, not hand-rolled `{code:'...'}`
 * mocks: constructing the genuine class is what makes this a faithful test of the
 * prod predicate (epic root-cause #4 — a mock-shaped predicate would leave the
 * evict/retry path silently dead in production while CI stays green). We construct
 * rather than drive a live fetch because Jest's environment degrades the live-fetch
 * error to a generic `Error` cause (no undici code), which would NOT be the prod
 * shape.
 */

/** A REAL undici socket reset, wrapped as fetch wraps it. */
function realSocketResetError(): unknown {
  const err = new TypeError('fetch failed');
  (err as { cause?: unknown }).cause = new errors.SocketError('other side closed');
  return err;
}

/** A REAL undici body timeout, wrapped as fetch wraps it. */
function realBodyTimeoutError(): unknown {
  const err = new TypeError('terminated');
  (err as { cause?: unknown }).cause = new errors.BodyTimeoutError();
  return err;
}

type FakeServer = {
  id: string;
  name: string;
  transport: 'http' | 'sse';
  url: string;
  headersEnc: string | null;
  toolAllowlist: string[] | null;
  instructions: string | null;
  // #686: the recovery re-read guard (findByIdRaw) validates these.
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
  workspaceId: 'ws-1',
  enabled: true,
  updatedAt: new Date('2020-01-01T00:00:00.000Z'),
  ...over,
});

function buildService(servers: FakeServer[], trusted = false) {
  const repo = {
    listEnabledForAgent: jest.fn().mockResolvedValue(servers),
    // #686 recovery re-read: reconnectServer re-reads the row before reopening a
    // connection. Return the SAME object by id so updatedAt/enabled match and the
    // guard permits the reconnect (the "changed" refusal is tested separately).
    findByIdRaw: jest.fn(async (id: string) => servers.find((s) => s.id === id)),
  };
  const service = new McpClientsService(repo as never, {} as never);
  // Seed a DETERMINISTIC write-class map so the retry gate is controlled here
  // (the production map loads from @docmost/mcp via a dynamic ESM import). getPage
  // is a read, patchNode is a write — the real classifications.
  (
    service as unknown as { writeClassMapPromise: Promise<unknown> }
  ).writeClassMapPromise = Promise.resolve({
    getPage: 'readOnly',
    patchNode: 'write',
  });
  // The service only APPLIES that map to a TRUSTED internal Docmost server
  // (isInternalDocmostServer, really false for every third-party row). A retry
  // test needs a trusted server to exercise the readOnly-retry path at all, so it
  // passes trusted=true to model a Docmost-origin server; the third-party
  // double-apply test leaves it at the real value (false).
  if (trusted) {
    jest
      .spyOn(
        service as unknown as {
          isInternalDocmostServer: (s: FakeServer) => boolean;
        },
        'isInternalDocmostServer',
      )
      .mockReturnValue(true);
  }
  return { service, repo };
}

/** Spy the private `connect` so each call yields a controlled fake client whose
 *  single tool's execute is the supplied function. Returns the connect spy. */
function stubConnect(
  service: McpClientsService,
  toolName: string,
  execs: Array<(...a: unknown[]) => Promise<unknown>>,
) {
  let n = 0;
  return jest
    .spyOn(
      service as unknown as { connect: (s: FakeServer) => Promise<unknown> },
      'connect',
    )
    .mockImplementation(async () => {
      const exec = execs[Math.min(n, execs.length - 1)];
      n += 1;
      return {
        tools: async () => ({ [toolName]: { description: 'x', execute: exec } }),
        close: jest.fn().mockResolvedValue(undefined),
      };
    });
}

const opts = (abortSignal?: AbortSignal) =>
  ({ toolCallId: 't', messages: [], abortSignal }) as never;

describe('isRetryableConnectError (#489, REAL error shapes)', () => {
  it('classifies a real undici socket reset and body timeout as retryable', async () => {
    const socketErr = await realSocketResetError();
    const bodyErr = await realBodyTimeoutError();
    expect(isRetryableConnectError(socketErr)).toBe(true);
    expect(isRetryableConnectError(bodyErr)).toBe(true);
    // Unwraps a wrapped cause chain (e.g. an MCPClientError around the socket err).
    const wrapped = new Error('mcp call failed');
    (wrapped as { cause?: unknown }).cause = socketErr;
    expect(isRetryableConnectError(wrapped)).toBe(true);
  });

  it('does NOT classify an application-level error as a transport break', () => {
    expect(isRetryableConnectError(new Error('validation failed'))).toBe(false);
    expect(isRetryableConnectError({ name: 'HttpError', status: 400 })).toBe(false);
    expect(isRetryableConnectError(undefined)).toBe(false);
    expect(isRetryableConnectError('boom')).toBe(false);
  });
});

describe('McpClientsService in-run transport recovery (#489)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('a readOnly tool whose transport breaks reconnects and retries WITHIN the same run', async () => {
    const realErr = await realSocketResetError();
    const { service } = buildService([server()], true);
    const first = jest.fn().mockRejectedValue(realErr);
    const second = jest.fn().mockResolvedValue({ ok: true });
    const connectSpy = stubConnect(service, 'getPage', [first, second]);

    const toolset = await service.toolsFor('ws-1', 'user-1');
    const tool = toolset.tools['srv_getPage'];
    const result = await (tool.execute as (a: unknown, o: unknown) => Promise<unknown>)(
      { pageId: 'p' },
      opts(),
    );

    // The repeat call within the run got a LIVE client and succeeded.
    expect(result).toEqual({ ok: true });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    // Exactly one reconnect was minted (initial build connect + one recovery).
    expect(connectSpy).toHaveBeenCalledTimes(2);
    // The run accumulated BOTH leases (old + reconnected) — released together at end.
    expect(toolset.clients).toHaveLength(2);
    await Promise.all(toolset.clients.map((c) => c.close()));
  });

  it('a WRITE tool does NOT auto-retry on a transport error (indeterminate)', async () => {
    const realErr = await realSocketResetError();
    const { service } = buildService([server()], true);
    const exec = jest.fn().mockRejectedValue(realErr);
    const connectSpy = stubConnect(service, 'patchNode', [exec]);

    const toolset = await service.toolsFor('ws-2', 'user-1');
    const tool = toolset.tools['srv_patchNode'];
    await expect(
      (tool.execute as (a: unknown, o: unknown) => Promise<unknown>)(
        { pageId: 'p' },
        opts(),
      ),
    ).rejects.toThrow(/MAY have already applied/);

    // Called exactly once — NO blind retry (avoids double-apply, the #435 class).
    expect(exec).toHaveBeenCalledTimes(1);
    // No fresh connection was minted for a write.
    expect(connectSpy).toHaveBeenCalledTimes(1);
    await Promise.all(toolset.clients.map((c) => c.close()));
  });

  it('does NOT retry (or reconnect) after the run is aborted (Stop)', async () => {
    const realErr = await realSocketResetError();
    const { service } = buildService([server()], true);
    const controller = new AbortController();
    // The transport error arrives, but the run was Stopped in the same tick.
    const first = jest.fn().mockImplementation(async () => {
      controller.abort();
      throw realErr;
    });
    const second = jest.fn().mockResolvedValue({ ok: true });
    const connectSpy = stubConnect(service, 'getPage', [first, second]);

    const toolset = await service.toolsFor('ws-3', 'user-1');
    const tool = toolset.tools['srv_getPage'];
    await expect(
      (tool.execute as (a: unknown, o: unknown) => Promise<unknown>)(
        { pageId: 'p' },
        opts(controller.signal),
      ),
    ).rejects.toBeDefined();

    // getPage IS readOnly, but the Stop blocks the retry — no second call, no mint.
    expect(second).not.toHaveBeenCalled();
    expect(connectSpy).toHaveBeenCalledTimes(1);
    await Promise.all(toolset.clients.map((c) => c.close()));
  });

  it('an app-level (non-transport) tool error is surfaced verbatim, never retried', async () => {
    const { service } = buildService([server()], true);
    const appErr = new Error('tool says: bad input');
    const exec = jest.fn().mockRejectedValue(appErr);
    const connectSpy = stubConnect(service, 'getPage', [exec]);

    const toolset = await service.toolsFor('ws-4', 'user-1');
    const tool = toolset.tools['srv_getPage'];
    await expect(
      (tool.execute as (a: unknown, o: unknown) => Promise<unknown>)(
        { pageId: 'p' },
        opts(),
      ),
    ).rejects.toThrow('tool says: bad input');
    expect(exec).toHaveBeenCalledTimes(1);
    expect(connectSpy).toHaveBeenCalledTimes(1); // no reconnect for an app error
    await Promise.all(toolset.clients.map((c) => c.close()));
  });

  // #489 (review, MEDIUM) — the Docmost write-class map keys by DOCMOST tool
  // names; a THIRD-PARTY server may name a WRITE tool `getPage` (a Docmost read
  // name). It must NOT inherit readOnly and must NOT auto-retry on a transport
  // error — a blind retry of that write is a double-apply (the #435 class). Here
  // the server is UNTRUSTED (buildService default, isInternalDocmostServer=false),
  // so the map is not applied and `getPage` classifies as a write.
  //
  // MUTATION-VERIFY: forcing the server "trusted" (buildService(..., true)) makes
  // `getPage` inherit readOnly -> it WOULD reconnect+retry (connect twice) and the
  // assertions below fail — i.e. removing the trust scope re-opens the bug.
  it('a THIRD-PARTY WRITE tool named like a Docmost read does NOT auto-retry (no double-apply)', async () => {
    const realErr = await realSocketResetError();
    // Untrusted: default trusted=false — a real third-party server.
    const { service } = buildService([server()]);
    const exec = jest.fn().mockRejectedValue(realErr);
    const connectSpy = stubConnect(service, 'getPage', [exec, exec]);

    const toolset = await service.toolsFor('ws-5', 'user-1');
    const tool = toolset.tools['srv_getPage'];
    await expect(
      (tool.execute as (a: unknown, o: unknown) => Promise<unknown>)(
        { pageId: 'p' },
        opts(),
      ),
    ).rejects.toThrow(/MAY have already applied/);

    // Exactly one call, NO reconnect — the name collision granted no readOnly-retry.
    expect(exec).toHaveBeenCalledTimes(1);
    expect(connectSpy).toHaveBeenCalledTimes(1);
    await Promise.all(toolset.clients.map((c) => c.close()));
  });
});

/**
 * #476/#685 — the recovery-reconnect path (`reconnectServer`) MUST apply the
 * SAME allowlist semantics as the initial `buildEntry` build: ANY array —
 * including `[]` — is authoritative, so an empty/deny-all allowlist yields ZERO
 * tools after a reconnect too. The bug (#685): `reconnectServer` used a
 * `Array.isArray(allow) && allow.length > 0` guard that read `[]` as falsy and
 * silently widened deny-all to allow-all EXACTLY on recovery-reconnect — a
 * fail-closed → fail-open flip precisely when the transport degraded (the repo
 * also clamps a corrupt allowlist row to `[]` fail-closed).
 *
 * The `buildEntry` side of this invariant is pinned in mcp-allowlist-filter.spec.ts
 * (via `toolsFor`); this pins the recovery side directly on `reconnectServer`.
 *
 * MUTATION-VERIFY: reverting the fix to
 *   `Array.isArray(allow) && allow.length > 0 ? pick(raw, allow) : raw`
 * reddens the two `[]` cases below (they would expose ALL three tools).
 */
describe('reconnectServer honours allowlist deny-all on recovery (#476/#685)', () => {
  afterEach(() => jest.restoreAllMocks());

  const RAW = (): Record<string, unknown> => ({
    alpha: { description: 'x', execute: jest.fn().mockResolvedValue({}) },
    beta: { description: 'y', execute: jest.fn().mockResolvedValue({}) },
    gamma: { description: 'z', execute: jest.fn().mockResolvedValue({}) },
  });

  /** Stub `connect` so the reconnected client lists a fixed raw tool map. */
  function stubConnectRaw(
    service: McpClientsService,
    rawTools: Record<string, unknown>,
  ) {
    return jest
      .spyOn(
        service as unknown as { connect: (s: FakeServer) => Promise<unknown> },
        'connect',
      )
      .mockImplementation(async () => ({
        tools: async () => rawTools,
        close: jest.fn().mockResolvedValue(undefined),
      }));
  }

  /** Invoke the private recovery-reconnect and return its resolved tool keys. */
  async function reconnectKeys(
    service: McpClientsService,
    srv: FakeServer,
  ): Promise<{ keys: string[]; close: () => Promise<void> }> {
    const { state, lease } = await (
      service as unknown as {
        reconnectServer: (
          s: FakeServer,
          capMs: number,
        ) => Promise<{
          state: { tools: Record<string, unknown> };
          lease: { close: () => Promise<void> };
        }>;
      }
    ).reconnectServer(srv, 1000);
    return { keys: Object.keys(state.tools), close: () => lease.close() };
  }

  it('toolAllowlist:[] yields ZERO tools after a recovery-reconnect (deny-all)', async () => {
    // #686 recovery re-read: the row must be FINDABLE by findByIdRaw (same object
    // => same updatedAt/enabled), or the staleness guard refuses the reconnect.
    const srv = server({ toolAllowlist: [] });
    const { service } = buildService([srv]);
    stubConnectRaw(service, RAW());
    const { keys, close } = await reconnectKeys(service, srv);
    expect(keys).toEqual([]);
    await close();
  });

  it('a corrupt allowlist clamped to [] by the repo also yields ZERO tools after reconnect', async () => {
    // The repo fails a present-but-corrupt tool_allowlist CLOSED to `[]`
    // (ai-mcp-server.repo.ts normalizeRow); recovery must honour that as deny-all.
    const corruptFallback: string[] = [];
    const srv = server({ toolAllowlist: corruptFallback });
    const { service } = buildService([srv]);
    stubConnectRaw(service, RAW());
    const { keys, close } = await reconnectKeys(service, srv);
    expect(keys).toEqual([]);
    await close();
  });

  it('null (no restriction) still exposes every tool after reconnect', async () => {
    const srv = server({ toolAllowlist: null });
    const { service } = buildService([srv]);
    stubConnectRaw(service, RAW());
    const { keys, close } = await reconnectKeys(service, srv);
    expect(keys.sort()).toEqual(['alpha', 'beta', 'gamma']);
    await close();
  });

  it("['alpha'] exposes ONLY alpha after reconnect (parity with buildEntry)", async () => {
    const srv = server({ toolAllowlist: ['alpha'] });
    const { service } = buildService([srv]);
    stubConnectRaw(service, RAW());
    const { keys, close } = await reconnectKeys(service, srv);
    expect(keys).toEqual(['alpha']);
    await close();
  });
});
