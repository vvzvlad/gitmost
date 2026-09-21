import { isIP } from 'node:net';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { pathToFileURL } from 'node:url';
import { Injectable, Logger } from '@nestjs/common';
import { type Tool, type ToolCallOptions } from 'ai';
import { createMCPClient } from '@ai-sdk/mcp';
import { Agent, type Dispatcher } from 'undici';
import { AiMcpServerRepo } from '@docmost/db/repos/ai-chat/ai-mcp-server.repo';
import { AiMcpServer } from '@docmost/db/types/entity.types';
import {
  streamingDispatcherOptions,
  mcpStreamTimeoutMs,
  mcpCallTimeoutMs,
  mcpSseBodyTimeoutMs,
} from '../../../integrations/ai/ai-streaming-fetch';
import { SecretBoxService } from '../../../integrations/crypto/secret-box';
import { incExternalMcpConnectFailure } from '../../../integrations/metrics/metrics.registry';
import { isUrlAllowed, isIpAllowed } from './ssrf-guard';
import { CACHE_KEY_SEP } from './mcp.constants';
// TYPE-ONLY (erased at compile): @docmost/mcp is ESM-only and cannot be a runtime
// `require()` from this commonjs module (same constraint as docmost-client.loader).
// The write-class MAP is loaded lazily via the dynamic-import trick below.
import type { ToolWriteClass } from '@docmost/mcp';

// TS(commonjs) downlevels a literal `import()` to `require()`, which cannot load
// the ESM-only @docmost/mcp. Indirect through Function so the real dynamic
// `import()` survives compilation (same trick as docmost-client.loader.ts).
const esmImport = new Function(
  'specifier',
  'return import(specifier)',
) as (specifier: string) => Promise<unknown>;

/** Local read-only predicate — avoids a value import of the ESM-only package.
 *  Only a pure read is retry-safe after a transport break (a write is
 *  indeterminate). Kept in lockstep with @docmost/mcp's isRetryableWriteClass. */
function isReadOnlyWriteClass(writeClass: ToolWriteClass | undefined): boolean {
  return writeClass === 'readOnly';
}

/** A closable external MCP client handle. */
export interface Closable {
  close: () => Promise<void>;
}

/**
 * Thrown when a server's `headersEnc` blob is PRESENT but cannot be decrypted
 * (e.g. after an `APP_SECRET` rotation). Distinct from "no auth headers": the
 * connect path must NOT fall back to an anonymous, header-less connection (that
 * would silently drop the server's credentials and could reach an unintended
 * endpoint) — the server is SKIPPED with a clear `auth-unreadable` outcome. The
 * server id + workspace id ride along for a non-secret operator log line; the
 * encrypted blob itself is NEVER carried or logged.
 */
export class McpAuthUnreadableError extends Error {
  constructor(
    readonly serverId?: string,
    readonly workspaceId?: string,
  ) {
    super('external MCP server auth headers are unreadable');
    this.name = 'McpAuthUnreadableError';
  }
}

/** The minimal shape of an @ai-sdk/mcp client we depend on. */
interface McpClient {
  tools(): Promise<Record<string, Tool>>;
  close(): Promise<void>;
}

/**
 * The fields {@link McpClientsService.connect} needs. `id`/`workspaceId` are
 * OPTIONAL (the admin "test" endpoint connects a not-yet-persisted config) — they
 * only ride along so an undecryptable-headers skip (#686) can log WHICH server
 * without ever touching the encrypted blob.
 */
type ConnectTarget = Pick<AiMcpServer, 'transport' | 'url' | 'headersEnc'> & {
  id?: string;
  workspaceId?: string;
};

/** A server we connected to (or tried to) for one toolset build. */
interface ServerOutcome {
  name: string;
  ok: boolean;
  /** Short, non-sensitive reason when ok=false (UI: "tool X unavailable"). */
  reason?: string;
}

/**
 * One server's admin-authored guidance for the agent system prompt (#180).
 * Built ONLY for a server that actually connected AND contributed ≥1 tool
 * (after the allowlist filter) AND has non-blank guidance — so a guide never
 * appears for a server whose tools the agent cannot actually call.
 */
export interface McpServerInstruction {
  /** Display name of the server (for the prompt section header). */
  serverName: string;
  /**
   * The tool-name namespace prefix the server's tools were merged under
   * (sanitized name, e.g. `tavily`). The prompt renders this as `tavily_*` so
   * the model can connect the guidance to the actual tool names. Advisory:
   * individual tools may carry a disambiguating suffix on rare collisions.
   */
  toolPrefix: string;
  /** The trusted, non-blank guidance text. */
  instructions: string;
}

export interface ExternalToolset {
  /** Namespaced external tools, merge-ready into the agent toolset. */
  tools: Record<string, Tool>;
  /** Live client handles the caller MUST close (release) after the turn. */
  clients: Closable[];
  /** Per-server connect outcomes so the UI can show unavailable servers. */
  outcomes: ServerOutcome[];
  /**
   * Per-server prompt guidance for connected servers that contributed ≥1 tool
   * and have non-blank instructions. Empty when no server qualifies.
   */
  instructions: McpServerInstruction[];
}

/** Connect+tools() timeout per server — a slow server must not stall the turn. */
const CONNECT_TIMEOUT_MS = 5000;
/** TTL for the per-workspace tool cache. */
const CACHE_TTL_MS = 60_000;
/** AI SDK provider tool-name constraint: ^[a-zA-Z0-9_-]+$, capped length. */
const MAX_TOOL_NAME_LENGTH = 64;

/**
 * A cached, live, per-workspace toolset. The clients stay OPEN for the TTL so
 * the cached tools remain executable (the AI SDK tools hold the open transport).
 * Refcounting keeps eviction safe: a lease taken during a turn defers the actual
 * close until the turn releases it, so a TTL expiry mid-turn never closes a
 * client a stream is still executing against.
 */
/**
 * Where a merged (namespaced) tool came from, so the per-run recovery wrapper
 * (#489) can, on a transport error, reconnect THAT server and re-resolve the SAME
 * underlying tool by its raw name. `writeClass` gates the single auto-retry (a
 * read is retry-safe; a write is indeterminate). `serverIndex` indexes the
 * entry's `servers` array (which server config to reconnect).
 */
interface ToolProvenance {
  serverIndex: number;
  rawName: string;
  writeClass: ToolWriteClass | undefined;
}

/** A live reconnected server (its fresh client + raw call-timeout-wrapped tools). */
interface RecoveredServerState {
  client: McpClient;
  tools: Record<string, Tool>;
}

/**
 * Per-run, per-server recovery binding (#489). `current` is the server's LIVE
 * target for this run: `null` means "use the ORIGINAL cached client/template";
 * a non-null value is a reconnected throwaway client all this server's tools now
 * call. `reconnecting` dedupes concurrent reconnects so only ONE fresh client is
 * minted per death (a losing concurrent call awaits it and retries on the SAME
 * new client — the CAS-by-identity rule).
 */
interface ServerBinding {
  current: RecoveredServerState | null;
  reconnecting?: Promise<RecoveredServerState>;
}

interface CacheEntry {
  tools: Record<string, Tool>;
  clients: McpClient[];
  outcomes: ServerOutcome[];
  /** Prompt guidance for qualifying servers (see McpServerInstruction). */
  instructions: McpServerInstruction[];
  /**
   * The enabled server configs used to build this entry (#489), so the per-run
   * recovery wrapper can reconnect a specific server by index. Parallel to the
   * indices referenced by {@link toolMeta}.
   */
  servers: AiMcpServer[];
  /** merged-tool-key -> provenance (#489), for the per-run recovery wrapper. */
  toolMeta: Record<string, ToolProvenance>;
  expiresAt: number;
  /** Active leases (turns currently using these clients). */
  refCount: number;
  /** Set once the entry is evicted from the map; close when refCount hits 0. */
  evicted: boolean;
  /** Set once the clients have actually been closed (guards double-close). */
  closed: boolean;
  /**
   * The TTL expiry timer. Undefined for a ONE-SHOT entry (#686): a one-shot is
   * never cached, so it has no TTL — it is pre-`evicted` and closes on release.
   */
  timer?: NodeJS.Timeout;
}

/**
 * Connects to the workspace's enabled external MCP servers (Tavily, etc.),
 * namespaces their tools, and merges them into the agent toolset (§6.8/§14[H3]).
 *
 * gitmost is the MCP CLIENT here. Resilience rules:
 *  - a down/slow server is skipped (timeout + try/catch), never crashing a turn;
 *  - the connect URL is SSRF-checked before connect AND on every request via a
 *    guarded fetch (DNS-rebinding defense);
 *  - decrypted auth headers and URLs never appear in logs;
 *  - a per-workspace cache (TTL + CRUD invalidation) avoids reconnecting each
 *    turn while keeping execution correct (live clients held for the TTL).
 */
@Injectable()
export class McpClientsService {
  private readonly logger = new Logger(McpClientsService.name);
  /**
   * In-flight-deduplicated toolset builds, keyed PER-USER (#686):
   * `${workspaceId}${CACHE_KEY_SEP}${userId}`. The toolset is ALWAYS per-user
   * (admin servers ∪ that user's personal servers), so no entry is ever shared
   * across users — a NUL separator makes `${workspaceId}${CACHE_KEY_SEP}` an
   * unambiguous prefix for the admin-CRUD fan-out that evicts every user's entry
   * in one workspace at once (see {@link invalidate}). We store the BUILD PROMISE
   * (not the resolved entry) so two concurrent turns for the same user await the
   * SAME build instead of each connecting to every server and leaking the loser's
   * live clients (see acquireEntry).
   */
  private readonly cache = new Map<string, Promise<CacheEntry>>();
  /**
   * SSRF-pinned dispatchers for outbound external-MCP fetches. Both use the SAME
   * custom connect.lookup (so every connection is IP-validated), but carry a
   * DIFFERENT `bodyTimeout` (#489): the HTTP (streamable) transport opens a fresh
   * request per call, so it keeps the tight silence timeout; the SSE transport
   * holds ONE long-lived body open across many calls, so a >1-min idle BETWEEN
   * calls is LEGITIMATE and must not break the socket — it gets a much larger
   * bodyTimeout. (headersTimeout stays tight on both.)
   */
  private readonly dispatcherHttp: Dispatcher = buildPinnedDispatcher(
    mcpStreamTimeoutMs(),
  );
  private readonly dispatcherSse: Dispatcher = buildPinnedDispatcher(
    mcpSseBodyTimeoutMs(),
  );
  /** guardedFetch bound to each dispatcher; picked by transport type in connect(). */
  private readonly guardedFetchHttp: typeof fetch = (input, init) =>
    guardedFetch(this.dispatcherHttp, input, init);
  private readonly guardedFetchSse: typeof fetch = (input, init) =>
    guardedFetch(this.dispatcherSse, input, init);

  /**
   * Memoized write-class map (#489), loaded lazily from @docmost/mcp via the
   * dynamic-import trick. Keyed by tool name (=== mcpName). A tool NOT in the map
   * (any third-party external MCP tool) classifies as `undefined` -> treated as a
   * write by the retry gate (the safe default: never blind-retry an unknown tool).
   * On any load failure the map is `{}` (every tool -> no auto-retry), so a
   * missing/older @docmost/mcp build only DISABLES retries, never mis-retries.
   */
  private writeClassMapPromise: Promise<Record<string, ToolWriteClass>> | null =
    null;

  constructor(
    private readonly repo: AiMcpServerRepo,
    private readonly secretBox: SecretBoxService,
  ) {}

  /**
   * Whether an external MCP server is the TRUSTED internal Docmost MCP server —
   * the only server whose tools may be classified by the Docmost write-class map
   * (#489 review). Today this is ALWAYS false: every `ai_mcp_servers` row is an
   * admin-configured THIRD-PARTY endpoint (there is no builtin/self flag, sentinel
   * URL, or synthetic server in this path — Docmost's OWN tools are exposed via the
   * separate in-app tools path, never through this external-MCP client). So no
   * third-party tool can inherit `readOnly` by a name collision with a Docmost read
   * tool, and none is ever auto-retried on a transport error (which would risk a
   * double-apply — the #435 class). Flip this (an explicit `kind`/`isBuiltin`
   * column, or a configured self-MCP URL) if a trusted internal server is ever
   * introduced. A method (not a free function) so it is a single, mockable seam.
   */
  private isInternalDocmostServer(_server: AiMcpServer): boolean {
    return false;
  }

  /** Lazily load + memoize the shared write-class map (see the field doc). */
  private getWriteClassMap(): Promise<Record<string, ToolWriteClass>> {
    if (!this.writeClassMapPromise) {
      this.writeClassMapPromise = (async () => {
        try {
          const entry = require.resolve('@docmost/mcp');
          const mod = (await esmImport(pathToFileURL(entry).href)) as {
            SHARED_TOOL_WRITE_CLASS?: Record<string, ToolWriteClass>;
          };
          return mod.SHARED_TOOL_WRITE_CLASS ?? {};
        } catch (err) {
          this.logger.warn(
            `Could not load MCP write-class map (auto-retry disabled): ${shortError(
              err,
            )}`,
          );
          return {};
        }
      })();
    }
    return this.writeClassMapPromise;
  }

  /**
   * Build (or reuse a cached) external toolset for a workspace. Returns the
   * merged tools, the open client handles to release, and per-server outcomes.
   *
   * The returned `clients` are release handles: calling `close()` on each one
   * decrements the cache lease (and closes the real client only once no lease
   * remains and the entry has been evicted). The caller MUST close every handle
   * in the streamText onFinish/onError/onAbort lifecycle.
   */
  async toolsFor(
    workspaceId: string,
    userId: string,
  ): Promise<ExternalToolset> {
    // #686: the toolset is ALWAYS per-user (admin ∪ this user's personal servers)
    // — `userId` is REQUIRED. acquireEntry returns an ALREADY-LEASED live entry
    // (refCount already incremented synchronously with its liveness check, so a
    // TTL timer / invalidation cannot evict-then-close it in the gap between the
    // check and the lease). We therefore do NOT increment refCount again here.
    const entry = await this.acquireEntry(workspaceId, userId);
    let released = false;
    const release: Closable = {
      close: async () => {
        if (released) return; // idempotent: close at most once per lease
        released = true;
        entry.refCount -= 1;
        // If the entry was evicted while leased and we are the last user, close.
        if (entry.evicted && entry.refCount <= 0 && !entry.closed) {
          entry.closed = true;
          await this.closeClients(entry.clients);
        }
      },
    };

    // #489: the run accumulates a SET of leases — the primary cache lease PLUS any
    // throwaway client minted by an in-run transport-recovery reconnect. They are
    // NEVER released mid-run (releasing a swapped-out client while a concurrent
    // in-flight call still holds it would INDUCE a second failure); the caller
    // releases the WHOLE set together at turn-end. A recovery reconnect pushes its
    // lease onto this live array, which the consumer closes over.
    const leaseSet: Closable[] = [release];

    // #489: per-RUN transport-recovery binding, one per server, SHARED by all of
    // that server's tools so a swap by one call is seen by the next (CAS by
    // identity). Kept per-run (here, not in the cached entry) because the binding
    // + lease-set state is per-run.
    const bindings = new Map<number, ServerBinding>();
    const capMs = mcpCallTimeoutMs();

    // Wrap each cached tool with the recovery layer. On a transport error a
    // declared readOnly tool reconnects its server and retries ONCE; a write is
    // never blind-retried (indeterminate — may have applied before the reset). A
    // tool without provenance (a minimal stub entry in a test) passes through raw.
    const tools: Record<string, Tool> = {};
    for (const [key, tool] of Object.entries(entry.tools)) {
      const meta = entry.toolMeta?.[key];
      tools[key] = meta
        ? this.wrapWithTransportRecovery(entry, meta, tool, leaseSet, bindings, capMs)
        : tool;
    }

    return {
      tools,
      clients: leaseSet,
      outcomes: entry.outcomes,
      instructions: entry.instructions,
    };
  }

  /** The per-user cache key: `${workspaceId}${CACHE_KEY_SEP}${userId}`. */
  private userKey(workspaceId: string, userId: string): string {
    return `${workspaceId}${CACHE_KEY_SEP}${userId}`;
  }

  /**
   * Admin-CRUD invalidation (#686): an admin server appears in EVERY user's
   * toolset, so a change to it must evict every per-user entry for the workspace.
   * PREFIX FAN-OUT over `${workspaceId}${CACHE_KEY_SEP}` — the NUL separator can
   * never appear in a workspace/user UUID, so the prefix matches exactly this
   * workspace's per-user keys and nothing else.
   */
  invalidate(workspaceId: string): void {
    const prefix = `${workspaceId}${CACHE_KEY_SEP}`;
    // Snapshot the keys first: evictKey mutates the map while we iterate.
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(prefix)) this.evictKey(key);
    }
  }

  /**
   * Single-user invalidation (#686): evict ONLY this user's entry. Called by the
   * personal-server CRUD path and by the user-delete flow. Critically, this is
   * also what the TTL timer routes through (via {@link expireEntry}) so ONE
   * user's 60s expiry does NOT fan-out-evict every other user's toolset (which
   * would trigger a connect storm across the whole workspace on each expiry).
   */
  invalidateUser(workspaceId: string, userId: string): void {
    this.evictKey(this.userKey(workspaceId, userId));
  }

  /**
   * Drop one cache key and evict its resolved entry. Identity-aware: only the
   * map slot that STILL holds the promise we read is removed, so a concurrent
   * rebuild that already replaced it is never clobbered. A rejected build owns
   * no clients, so there is nothing to close on that branch.
   */
  private evictKey(key: string): void {
    const pending = this.cache.get(key);
    if (!pending) return;
    if (this.cache.get(key) === pending) this.cache.delete(key);
    pending.then(
      (entry) => this.evict(entry),
      () => undefined,
    );
  }

  /**
   * The TTL timer's expiry handler (#686). It is the per-user single-key eviction
   * (never the workspace fan-out) AND it is IDENTITY-AWARE: it evicts ONLY when
   * the map still points at THIS entry's promise. Without the identity check a
   * stale timer for an old entry (E1) could fire just after a rebuild installed a
   * fresh entry (E2) at the same key and evict E2 — closing a toolset a live turn
   * is executing against. The old entry is closed regardless (idempotent) so its
   * transports never leak.
   */
  private expireEntry(key: string, entry: CacheEntry): void {
    const pending = this.cache.get(key);
    if (!pending) {
      // Key already gone (evicted by CRUD / getOrBuild expiry). Close THIS entry.
      this.evict(entry);
      return;
    }
    pending.then((current) => {
      // Only remove the map slot when it still resolves to THIS entry (not a
      // newer rebuild) AND still holds the SAME promise we read.
      if (current === entry && this.cache.get(key) === pending) {
        this.cache.delete(key);
      }
      // Always close THIS (now-expired) entry; evict() is idempotent and closes
      // only when nothing is leasing it.
      this.evict(entry);
    }, () => this.evict(entry));
  }

  /**
   * Connect to a single server and list its tools, with SSRF + timeout, WITHOUT
   * touching the cache. Used by the admin "test" endpoint. Returns the raw
   * (un-namespaced) tool names; the caller must close the returned client.
   */
  async testServer(
    server: Pick<AiMcpServer, 'transport' | 'url' | 'headersEnc'>,
  ): Promise<{ ok: true; tools: string[] } | { ok: false; error: string }> {
    let client: McpClient | undefined;
    try {
      client = await this.connectWithTimeout(server, CONNECT_TIMEOUT_MS);
      const raw = await withTimeout(client.tools(), CONNECT_TIMEOUT_MS);
      return { ok: true, tools: Object.keys(raw) };
    } catch (err) {
      // NEVER leak headers or raw upstream bodies — short message only.
      return { ok: false, error: shortError(err) };
    } finally {
      if (client) {
        await client.close().catch(() => undefined);
      }
    }
  }

  // --- internals ---

  /**
   * Return a LEASED, guaranteed-live cache entry for this user, building it at
   * most ONCE for any set of concurrent callers. The returned entry already has
   * `refCount` incremented for the caller's lease — the increment happens in the
   * SAME synchronous block as the liveness check (no await between), so a TTL
   * timer / invalidation cannot evict-then-close the entry in the gap between
   * "it's live" and "I hold a lease". The caller (toolsFor) builds the release
   * around it and must NOT increment again.
   */
  private async acquireEntry(
    workspaceId: string,
    userId: string,
  ): Promise<CacheEntry> {
    const key = this.userKey(workspaceId, userId);
    const pending = this.cache.get(key);
    if (pending) {
      const entry = await pending;
      // TOCTOU fix (#686): liveness check + refCount increment in ONE synchronous
      // block. Nothing runs between them (single-threaded JS, no await), so the
      // entry cannot be evicted-and-closed underneath us. Once refCount > 0, a
      // racing evict() sees a non-zero lease count and defers the close to our
      // release() — so leasing a live entry can never hand back closed clients.
      if (
        entry.expiresAt > Date.now() &&
        !entry.evicted &&
        !entry.closed
      ) {
        entry.refCount += 1;
        // Defensive re-check: if an eviction had ALREADY closed it before our
        // increment (it could only have run at the await above, but assert the
        // invariant anyway), undo the lease and fall through to a fresh build.
        if (!entry.closed) return entry;
        entry.refCount -= 1;
      }
      // Expired / evicted / closed: drop this promise (identity-aware) + evict the
      // stale entry, then rebuild fresh.
      if (this.cache.get(key) === pending) {
        this.cache.delete(key);
        this.evict(entry);
      }
    }
    return this.buildAndLease(key, workspaceId, userId);
  }

  /**
   * Build a fresh entry, cache it, and return it LEASED. Handles the
   * evict-pending-build hole (#686): an invalidation (or the user-delete flow)
   * can fire WHILE we await the build and — because the just-resolved entry has
   * refCount 0 — evict AND close its clients before we ever lease it. Leasing
   * that corpse would hand the turn dead clients (ARCH INVARIANT #10). When we
   * detect the cached entry was evicted/closed during the build, we fall back to
   * a ONE-SHOT entry: built fresh, NOT put in the Map, NO TTL timer, pre-marked
   * `evicted` so the shared release path closes it exactly once when the turn
   * releases its lease (inc → 1, release → 0 ⇒ close). It is never shared, so
   * refCount only ever goes 0 → 1 → 0.
   */
  private async buildAndLease(
    key: string,
    workspaceId: string,
    userId: string,
  ): Promise<CacheEntry> {
    // Install the in-flight build promise BEFORE awaiting, so concurrent callers
    // reuse it. On rejection, remove it so a later call retries.
    const build = this.buildEntry(workspaceId, userId).catch((err: unknown) => {
      if (this.cache.get(key) === build) {
        this.cache.delete(key);
      }
      throw err;
    });
    this.cache.set(key, build);
    const entry = await build;
    if (entry.evicted || entry.closed) {
      // The cached build was invalidated (and, at refCount 0, closed) while we
      // awaited it. Serve a one-shot uncached toolset for THIS turn instead.
      return this.buildOneShotLeased(workspaceId, userId);
    }
    // Lease synchronously after the await (no gap to an evict-then-close).
    entry.refCount += 1;
    if (entry.closed) {
      // Defensive: closed between resolve and our lease — release + one-shot.
      entry.refCount -= 1;
      return this.buildOneShotLeased(workspaceId, userId);
    }
    return entry;
  }

  /**
   * Build a ONE-SHOT (uncached, pre-evicted, timer-less) entry and lease it. Used
   * only for the evict-pending-build hole (see {@link buildAndLease}).
   */
  private async buildOneShotLeased(
    workspaceId: string,
    userId: string,
  ): Promise<CacheEntry> {
    const oneShot = await this.buildEntry(workspaceId, userId, {
      oneShot: true,
    });
    // Lease it (inc → 1). release() closes it (refCount → 0, evicted true).
    oneShot.refCount += 1;
    return oneShot;
  }

  /** Connect to all enabled servers and assemble one cache entry. */
  private async buildEntry(
    workspaceId: string,
    userId: string,
    opts?: { oneShot?: boolean },
  ): Promise<CacheEntry> {
    // #686: the agent-union read — admin servers ∪ THIS user's personal servers,
    // ADMIN-FIRST (so admin keeps the canonical namespace prefix on a name clash).
    const servers = await this.repo.listEnabledForAgent(workspaceId, userId);
    const tools: Record<string, Tool> = {};
    const clients: McpClient[] = [];
    const outcomes: ServerOutcome[] = [];
    // Per-call total wall-clock cap, read once for this build (env-overridable).
    const callTimeoutMs = mcpCallTimeoutMs();
    const instructions: McpServerInstruction[] = [];
    // merged-key -> provenance for the per-run recovery wrapper (#489).
    const toolMeta: Record<string, ToolProvenance> = {};
    // Shared Docmost write-class map (#489) — classifies a tool by its raw name.
    // Loaded ONLY when at least one server is a TRUSTED internal Docmost server
    // (see isInternalDocmostServer): for third-party servers the map is never
    // applied (a name collision must not grant readOnly-retry), so we skip the
    // dynamic ESM load entirely in that (currently universal) case.
    const writeClassMap = servers.some((s) => this.isInternalDocmostServer(s))
      ? await this.getWriteClassMap()
      : null;

    // Per-server connect+tools result, still tagged with its server so the merge
    // below can be applied in the SAME order as `servers` (see the parallel note).
    type PerServerResult =
      | { ok: true; client: McpClient; guarded: Record<string, Tool> }
      | { ok: false; reason: string };

    // Connect to (and list tools for) every enabled server CONCURRENTLY, so the
    // total build time is bounded by the SLOWEST single server (~2×
    // CONNECT_TIMEOUT_MS: connect + tools), NOT the SUM across servers. The
    // sequential loop this replaced summed those bounds, so with enough all-timing-
    // out servers the outer MCP_TOOLSET_BUILD_DEADLINE_MS could fire before the
    // per-server bounds, dropping ALL external tools and inverting the "per-server
    // bound is primary, outer is a backstop" invariant. Each server keeps its OWN
    // try/catch + connectWithTimeout/withTimeout bound + close-on-failure logic; a
    // failed server is skipped, never fatal. Nothing here mutates the shared
    // arrays — every result is merged IN SERVER ORDER after Promise.all, so tool-
    // key precedence/disambiguation, `outcomes`, `instructions` and `clients`
    // ordering all match the previous sequential behavior exactly.
    const perServer = async (
      server: (typeof servers)[number],
    ): Promise<PerServerResult> => {
      // Track the connected client so the catch can close it when it was obtained
      // but tools() then threw/timed out (connectWithTimeout closes its OWN orphan
      // on a connect timeout, so `client` stays undefined on that path). On success
      // the client is handed back and registered by the merge below (owned by the
      // entry, closed at teardown) — so it is never double-closed.
      let client: McpClient | undefined;
      try {
        client = await this.connectWithTimeout(server, CONNECT_TIMEOUT_MS);
        const raw = await withTimeout(client.tools(), CONNECT_TIMEOUT_MS);
        // Allowlist semantics (#476): null/absent = no restriction (all tools);
        // ANY array — including `[]` — is authoritative, so an EMPTY allowlist
        // yields ZERO tools (deny-all). Do NOT add a `.length > 0` escape here:
        // that read `[]` as falsy and silently widened deny-all to allow-all
        // (the repo also fails corrupt rows closed to `[]` for the same reason).
        const allow = server.toolAllowlist;
        const picked = Array.isArray(allow) ? pick(raw, allow) : raw;
        // Bound each tool's execute with a per-call total-timeout guard before
        // merging, so a single chatty-but-stuck call is aborted after the cap.
        const guarded = wrapToolsWithCallTimeout(picked, callTimeoutMs);
        return { ok: true, client, guarded };
      } catch (err) {
        // A failed server is skipped — the turn proceeds with the rest. If connect
        // returned a live client but a later step (tools()) threw, that client was
        // never registered in `clients`, so close it here or its transport/socket
        // leaks (compounding every 60s cache rebuild during a flaky-server outage).
        if (client) {
          void client.close().catch(() => undefined);
        }
        // Observability (#686): every enabled server that fails to connect (or
        // whose auth is unreadable) increments the connect-failure metric, by the
        // server's OWNERSHIP LEVEL so an operator sees whether admin or personal
        // external tools have gone dark. Never a per-server label (unbounded).
        incExternalMcpConnectFailure(server.userId ? 'personal' : 'admin');
        // Undecryptable auth headers (#686): the blob is PRESENT but unreadable
        // (e.g. APP_SECRET rotated). We SKIP the server with a clear
        // `auth-unreadable` outcome rather than connecting anonymously — a
        // header-less connect would silently drop the credentials. The WARN
        // carries the server + workspace ids (never the blob) so an admin can
        // repair it by re-saving the headers.
        if (err instanceof McpAuthUnreadableError) {
          this.logger.warn(
            `External MCP server "${server.name}" (server ${server.id}, workspace ${server.workspaceId}) ` +
              `auth headers are unreadable (APP_SECRET rotated?) — skipping; re-save its headers to repair`,
          );
          return { ok: false, reason: 'auth-unreadable' };
        }
        // Log a short warning (never the URL/headers) so ops can see degradation,
        // and record the outcome so the UI can show "tool X unavailable".
        const reason = shortError(err);
        this.logger.warn(
          `External MCP server "${server.name}" unavailable: ${reason}`,
        );
        return { ok: false, reason };
      }
    };

    // Promise.all preserves array order regardless of settle order, so `results[i]`
    // is `servers[i]`'s outcome — the merge below stays deterministic and matches
    // the old sequential order (later servers still override/disambiguate against
    // earlier ones on a tool-key clash).
    const results = await Promise.all(servers.map(perServer));
    for (let i = 0; i < servers.length; i += 1) {
      const server = servers[i];
      const result = results[i];
      if (result.ok !== true) {
        outcomes.push({ name: server.name, ok: false, reason: result.reason });
        continue;
      }
      clients.push(result.client);
      // Namespace each tool with the sanitized server name AND disambiguate
      // against names already merged from earlier servers, so no external
      // tool is silently overwritten on collision. The returned count drives
      // whether this server's prompt guidance is included (≥1 tool merged).
      // #489 (review): the Docmost write-class map keys by DOCMOST tool names and
      // may ONLY be trusted for a server KNOWN to be the internal Docmost MCP
      // server. Every row here is an admin-configured THIRD-PARTY endpoint, so a
      // third-party WRITE tool that happens to be named like a Docmost read
      // (getPage, listPages, ...) must NOT inherit readOnly — that would auto-retry
      // a mutation on a transport error (double-apply, the #435 class). Gate the
      // map on the trust check; untrusted servers get writeClass=undefined -> the
      // recovery wrapper treats them as writes and never auto-retries.
      const trustWriteClass = this.isInternalDocmostServer(server);
      const merged = this.mergeNamespaced(
        tools,
        result.guarded,
        server.name,
        server.id,
        toolMeta,
        i,
        trustWriteClass ? writeClassMap : null,
      );
      outcomes.push({ name: server.name, ok: true });
      // Include this server's guidance ONLY when it actually contributed at
      // least one tool the agent can call (allowlist may have filtered all of
      // them out) AND the admin authored non-blank instructions. The header
      // prefix is the sanitized server name (= the tool namespace prefix).
      const guide = server.instructions?.trim();
      if (merged.count > 0 && guide) {
        instructions.push({
          serverName: server.name,
          toolPrefix: merged.prefix,
          instructions: guide,
        });
      }
    }

    const entry: CacheEntry = {
      tools,
      clients,
      outcomes,
      instructions,
      servers,
      toolMeta,
      expiresAt: Date.now() + CACHE_TTL_MS,
      refCount: 0,
      // A one-shot entry is pre-`evicted` so the shared release path closes it
      // exactly once when the leasing turn releases it (it is never cached).
      evicted: opts?.oneShot === true,
      closed: false,
    };
    // A one-shot entry has NO TTL timer (it is never cached). A cached entry's
    // timer routes through invalidateUser via the identity-aware expireEntry, so
    // ONE user's 60s expiry evicts ONLY that user's key — never the workspace
    // fan-out, which would connect-storm every other user on each expiry.
    if (!opts?.oneShot) {
      const key = this.userKey(workspaceId, userId);
      entry.timer = setTimeout(
        () => this.expireEntry(key, entry),
        CACHE_TTL_MS,
      );
      // Do not keep the process alive just for the cache timer.
      entry.timer.unref?.();
    }
    return entry;
  }

  /**
   * Namespace `picked`'s tools with the server name and merge into `target`,
   * renaming any key that would collide with an already-merged tool (different
   * servers with the same sanitized name, or duplicates after truncation), so
   * no external tool is silently dropped via overwrite.
   *
   * Returns how many tools this server actually contributed and the namespace
   * prefix used (the sanitized server name) so the caller can attach the
   * server's prompt guidance only when ≥1 tool was merged.
   */
  private mergeNamespaced(
    target: Record<string, Tool>,
    picked: Record<string, Tool>,
    serverName: string,
    serverId: string,
    toolMeta: Record<string, ToolProvenance>,
    serverIndex: number,
    // The Docmost write-class map, or `null` for an UNTRUSTED (third-party)
    // server whose tools must all default to write (never auto-retried).
    writeClassMap: Record<string, ToolWriteClass> | null,
  ): { count: number; prefix: string } {
    let count = 0;
    for (const { full, raw, tool } of namespace(picked, serverName)) {
      let key = full;
      if (key in target) {
        const original = key;
        key = disambiguate(full, serverId, (candidate) => candidate in target);
        this.logger.debug(
          `External MCP tool name "${original}" collided; renamed to "${key}"`,
        );
      }
      target[key] = tool;
      // Record provenance so the per-run recovery wrapper (#489) can reconnect
      // this tool's server and re-resolve it by its raw name. writeClass is set
      // ONLY from a TRUSTED (internal-Docmost) map; for a third-party server the
      // map is null -> writeClass stays undefined -> the wrapper treats the tool
      // as a write and never auto-retries it (no double-apply on name collision).
      toolMeta[key] = {
        serverIndex,
        rawName: raw,
        writeClass: writeClassMap ? writeClassMap[raw] : undefined,
      };
      count += 1;
    }
    return { count, prefix: namespacePrefix(serverName) };
  }

  /**
   * Connect to one server: SSRF-check the URL, decrypt the auth headers, and
   * open an @ai-sdk/mcp client with redirect:'error' and a guarded fetch that
   * re-validates the resolved IP on every request AND pins the socket to a
   * validated address (DNS-rebinding defense, no unchecked second resolution).
   */
  private async connect(server: ConnectTarget): Promise<McpClient> {
    // Pre-connect SSRF check (re-resolves DNS each time — not just at save).
    const check = await isUrlAllowed(server.url);
    if (!check.ok) {
      throw new Error(check.reason ?? 'URL blocked by SSRF policy');
    }

    const transportType: 'http' | 'sse' =
      server.transport === 'sse' ? 'sse' : 'http';

    const client = (await createMCPClient({
      transport: {
        type: transportType,
        url: server.url,
        // #686: throws McpAuthUnreadableError when headersEnc is present but
        // undecryptable — the caller (buildEntry) skips the server rather than
        // connecting anonymously.
        headers: this.decryptHeaders(
          server.headersEnc,
          server.id,
          server.workspaceId,
        ),
        // SSRF: reject any redirect response (no redirect-based bypass).
        redirect: 'error',
        // Defense in depth: re-validate the actual request host on EVERY fetch
        // AND pin the socket to a validated IP via the dispatcher's connect
        // lookup, closing the DNS-rebinding TOCTOU between check and connect.
        // #489: the SSE transport uses the raised-bodyTimeout dispatcher (idle
        // between calls is legit); HTTP uses the tight one.
        fetch:
          transportType === 'sse' ? this.guardedFetchSse : this.guardedFetchHttp,
      },
    })) as unknown as McpClient;
    return client;
  }

  /**
   * Race {@link connect} against a SETTLING timeout so a hung MCP handshake can
   * never POISON the per-workspace build cache. `createMCPClient` (inside connect)
   * is NOT bounded internally, and — exactly like @ai-sdk/mcp's tool calls
   * (see wrapToolWithCallTimeout) — its promise does NOT settle on abort. So a
   * transient network blip mid-handshake can make connect hang FOREVER. Because
   * buildAndLease caches the build PROMISE, a never-settling connect would then
   * wedge EVERY later turn for the workspace (each awaits the same pending build,
   * step_count stuck at 0, run row leaks 'running', chat 409s forever). Bounding
   * connect here guarantees buildEntry always gets a client OR a rejection within
   * `ms` — so the build completes (bad server skipped) and the cache stays clean.
   *
   * If connect resolves LATE (after we already rejected on the timeout), we close
   * the orphaned client so its transport/socket is not leaked.
   */
  private connectWithTimeout(
    server: ConnectTarget,
    ms: number,
  ): Promise<McpClient> {
    return new Promise<McpClient>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        reject(new Error(`MCP connect timed out after ${ms}ms`));
      }, ms);
      // Do not keep the process alive just for this connect-timeout timer.
      timer.unref?.();
      this.connect(server).then(
        (client) => {
          if (settled) {
            // The race was already lost to the timeout: close the orphaned client
            // so its socket is not leaked, and drop the late result.
            void client.close().catch(() => undefined);
            return;
          }
          clearTimeout(timer);
          settled = true;
          resolve(client);
        },
        (err: unknown) => {
          if (settled) return; // late rejection after the timeout — already handled
          clearTimeout(timer);
          settled = true;
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  /**
   * Decrypt the stored auth headers. Returns undefined when none are set (a
   * legitimately anonymous server). The plaintext headers live only in this
   * returned object and are passed straight to the transport — never logged.
   *
   * #686: when the blob is PRESENT but undecryptable (e.g. APP_SECRET rotated)
   * this THROWS {@link McpAuthUnreadableError} rather than returning undefined —
   * the connect path must NOT fall back to an anonymous, header-less connection
   * (that would silently drop the server's credentials). buildEntry catches it
   * and skips the server with a clear `auth-unreadable` outcome. The blob is
   * never logged; the server/workspace ids ride on the error for a WARN there.
   */
  private decryptHeaders(
    headersEnc: string | null,
    serverId?: string,
    workspaceId?: string,
  ): Record<string, string> | undefined {
    if (!headersEnc) return undefined;
    try {
      const json = this.secretBox.decryptSecret(headersEnc);
      const parsed = JSON.parse(json) as Record<string, unknown>;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') headers[k] = v;
      }
      return Object.keys(headers).length > 0 ? headers : undefined;
    } catch {
      // Decryption/parse failure of a PRESENT blob. Do NOT connect anonymously —
      // surface a distinct error so the caller skips the server. Never log the
      // blob; the WARN (with ids) is emitted at the skip site in buildEntry.
      throw new McpAuthUnreadableError(serverId, workspaceId);
    }
  }

  /**
   * Wrap one merged external tool with the per-run transport-recovery layer (#489).
   *
   * attempt 1 runs on the server's CURRENT binding (the cached client, or a client
   * a sibling tool already reconnected this run). On a REAL transport error
   * (undici/@ai-sdk socket/body-timeout shapes — {@link isRetryableConnectError},
   * NOT a mock) and ONLY for a declared readOnly tool, it reconnects the server
   * and retries EXACTLY ONCE on the fresh client; a write is surfaced as an
   * indeterminate error (it may have applied before the reset — never
   * blind-retried). A single per-call cap bounds BOTH attempts + the reconnect,
   * and the run's abort signal is checked before the retry AND before minting a
   * fresh connection (no connection is opened for a stopped run).
   */
  private wrapWithTransportRecovery(
    entry: CacheEntry,
    meta: ToolProvenance,
    template: Tool,
    leaseSet: Closable[],
    bindings: Map<number, ServerBinding>,
    capMs: number,
  ): Tool {
    const original = template.execute;
    if (typeof original !== 'function') return template;
    const service = this;
    const { serverIndex, rawName, writeClass } = meta;

    let binding = bindings.get(serverIndex);
    if (!binding) {
      binding = { current: null };
      bindings.set(serverIndex, binding);
    }
    const boundBinding = binding;

    const execute = async (args: unknown, options: ToolCallOptions) => {
      // The per-call cap governs the WHOLE sequence (attempt1 + reconnect +
      // attempt2). Compose it with the run's abort signal so a Stop or the cap
      // ends any awaited call — @ai-sdk/mcp does not settle on abort, so we RACE.
      const capController = new AbortController();
      const capTimer = setTimeout(() => {
        capController.abort(new Error(`MCP tool call timed out after ${capMs}ms`));
      }, capMs);
      capTimer.unref?.();
      const runSignal = options?.abortSignal;
      const composed = runSignal
        ? AbortSignal.any([runSignal, capController.signal])
        : capController.signal;
      const stopped = () => runSignal?.aborted === true || capController.signal.aborted;

      const callOn = async (
        exec: NonNullable<Tool['execute']>,
      ): Promise<unknown> => {
        const aborted = new Promise<never>((_, reject) => {
          const fail = () => reject(abortReason(composed));
          if (composed.aborted) fail();
          else composed.addEventListener('abort', fail, { once: true });
        });
        return Promise.race([exec(args, { ...options, abortSignal: composed }), aborted]);
      };

      const execFor = (
        state: RecoveredServerState | null,
      ): NonNullable<Tool['execute']> | undefined =>
        state ? (state.tools[rawName]?.execute as NonNullable<Tool['execute']>) : original;

      try {
        // Snapshot the target BEFORE the call so a swap by a concurrent call is
        // detected by identity in the catch.
        const attemptState = boundBinding.current;
        const attemptExec = execFor(attemptState);
        if (typeof attemptExec !== 'function') {
          throw new Error(`external MCP tool "${rawName}" is not callable`);
        }
        try {
          return await callOn(attemptExec);
        } catch (err) {
          // Never retry on a Stop or an exhausted cap.
          if (stopped()) throw err;
          // Only a genuine transport break is a recovery candidate.
          if (!isRetryableConnectError(err)) throw err;
          // A write tool is INDETERMINATE on a transport error (may have applied
          // before the reset) — surface that; do NOT auto-retry (double-apply is
          // the #435 incident class).
          if (!isReadOnlyWriteClass(writeClass)) {
            throw new Error(
              `external MCP tool "${rawName}" hit a transport error and MAY have already ` +
                `applied on the server — not retried automatically; verify state before ` +
                `retrying. (${shortError(err)})`,
            );
          }
          // Abort check BEFORE minting a fresh connection (no socket for a
          // stopped run). LIMITATION (#489, LOW): the reconnect's own connect is
          // bounded by CONNECT_TIMEOUT_MS but does NOT itself observe `composed`,
          // so a Stop that lands DURING the handshake is only honored at the next
          // `stopped()` gate (before the retry) — a bounded ≤5s late-abort window;
          // the throwaway client is closed at turn-end regardless. Threading
          // `composed` into the SHARED (CAS-deduped) reconnect is deliberately
          // avoided: it would let the first caller's abort tear down a reconnect a
          // concurrent still-live caller depends on.
          if (stopped()) throw err;
          // CAS-swap by IDENTITY: mint+swap only if nobody swapped since this
          // call's snapshot; a losing concurrent call awaits the same reconnect
          // and retries on the SAME fresh client.
          let target: RecoveredServerState;
          if (boundBinding.current === attemptState) {
            if (!boundBinding.reconnecting) {
              boundBinding.reconnecting = (async () => {
                const server = entry.servers[serverIndex];
                const fresh = await service.reconnectServer(server, capMs);
                leaseSet.push(fresh.lease); // accumulate; released at turn-end
                boundBinding.current = fresh.state;
                return fresh.state;
              })();
              // Clear the in-flight marker once it settles (success or failure) so
              // a LATER death of the new client can reconnect again.
              void boundBinding.reconnecting.then(
                () => (boundBinding.reconnecting = undefined),
                () => (boundBinding.reconnecting = undefined),
              );
            }
            target = await boundBinding.reconnecting;
          } else {
            target = boundBinding.current as RecoveredServerState;
          }
          // Abort check BEFORE the retry.
          if (stopped()) throw err;
          const retryExec = execFor(target);
          if (typeof retryExec !== 'function') throw err;
          return await callOn(retryExec);
        }
      } finally {
        clearTimeout(capTimer);
      }
    };
    return { ...template, execute } as unknown as Tool;
  }

  /**
   * Reconnect ONE server for an in-run recovery (#489): open a fresh client and
   * list+wrap its tools. The throwaway client is NOT cached — it is owned by the
   * RUN via the returned lease (closed at turn-end), independent of the shared
   * cache entry (whose TTL rebuild heals future turns). On a failure the fresh
   * client is closed so its socket never leaks.
   *
   * RECOVERY RE-READ (#686): before reopening a connection we re-read the row via
   * the scope-agnostic {@link AiMcpServerRepo.findByIdRaw}. If the row is now
   * MISSING, DISABLED, or was EDITED (its `updatedAt` moved) since this toolset
   * was cached, we REFUSE to reconnect (no retry) — a run must never reopen a
   * connection with stale decrypted config, most critically a personal server's
   * now-changed auth headers. The cache TTL rebuild heals future turns.
   */
  private async reconnectServer(
    server: AiMcpServer,
    capMs: number,
  ): Promise<{ state: RecoveredServerState; lease: Closable }> {
    const fresh = await this.repo.findByIdRaw(server.id);
    if (
      !fresh ||
      fresh.enabled === false ||
      new Date(fresh.updatedAt as unknown as string).getTime() !==
        new Date(server.updatedAt as unknown as string).getTime()
    ) {
      throw new Error(
        `external MCP server "${server.name}" changed (removed, disabled, or edited) ` +
          `since the toolset was built — not reconnecting with stale config`,
      );
    }
    const client = await this.connectWithTimeout(server, CONNECT_TIMEOUT_MS);
    let tools: Record<string, Tool>;
    try {
      const raw = await withTimeout(client.tools(), CONNECT_TIMEOUT_MS);
      // Allowlist semantics (#476/#685): null/absent = no restriction (all
      // tools); ANY array — including `[]` — is authoritative, so an EMPTY
      // allowlist yields ZERO tools (deny-all). This MUST match buildEntry
      // above: do NOT add a `.length > 0` escape, which reads `[]` as falsy
      // and silently widens deny-all to allow-all exactly on recovery-reconnect
      // (a fail-closed → fail-open flip precisely when the transport degrades;
      // the repo also fails corrupt allowlist rows closed to `[]`).
      const allow = server.toolAllowlist;
      const picked = Array.isArray(allow) ? pick(raw, allow) : raw;
      tools = wrapToolsWithCallTimeout(picked, capMs);
    } catch (err) {
      void client.close().catch(() => undefined);
      throw err;
    }
    let released = false;
    const lease: Closable = {
      close: async () => {
        if (released) return;
        released = true;
        await client.close().catch(() => undefined);
      },
    };
    return { state: { client, tools }, lease };
  }

  /** Mark an entry evicted; close its clients now if nothing is leasing them. */
  private evict(entry: CacheEntry): void {
    clearTimeout(entry.timer);
    entry.evicted = true;
    if (entry.refCount <= 0 && !entry.closed) {
      entry.closed = true;
      void this.closeClients(entry.clients);
    }
    // Otherwise the last active lease's release() will close them.
  }

  /** Close clients, swallowing close errors so they never break a response. */
  private async closeClients(clients: McpClient[]): Promise<void> {
    await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
  }
}

/**
 * Apply the SSRF connect-time rule to a set of DNS-resolved addresses: block if
 * ANY resolved address is disallowed by `isIpAllowed`, and block an EMPTY set
 * (nothing safe to connect to). Only an all-public, non-empty set is allowed.
 *
 * This is the connect-time half of the DNS-rebinding defense: the dispatcher's
 * lookup hands net/tls.connect ONLY a set that passed this check, so the kernel
 * can never connect to an address that did not pass the guard. Pure — no I/O.
 */
export function validateResolvedAddresses(addrs: readonly LookupAddress[]): {
  ok: boolean;
  blockedHost?: string;
} {
  if (addrs.length === 0) {
    return { ok: false };
  }
  const blocked = addrs.find((a) => !isIpAllowed(a.address).ok);
  if (blocked) {
    return { ok: false, blockedHost: blocked.address };
  }
  return { ok: true };
}

/**
 * Build the SSRF-pinned undici dispatcher. Its custom connect.lookup resolves
 * the host, validates EVERY resolved address with the same ssrf-guard, and
 * returns ONLY a validated address to net/tls.connect — so there is no second,
 * unchecked DNS resolution: the kernel can only connect to an address that
 * passed the guard. The hostname (SNI / Host header) is left untouched, so TLS
 * certificate validation still uses the real hostname (we never rewrite the URL
 * to an IP literal).
 */
function buildPinnedDispatcher(bodyTimeoutMs: number): Agent {
  // External-MCP traffic uses a DEDICATED, shorter HEADERS silence timeout
  // (`AI_MCP_STREAM_TIMEOUT_MS`, default 1 min) — deliberately tighter than the
  // chat provider's 15-min `streamTimeoutMs()` — so a byte-silent/hung MCP
  // upstream is broken in ~1 min instead of 15. We keep the keep-alive options
  // from `streamingDispatcherOptions()` but OVERRIDE the timeouts. `bodyTimeout`
  // is passed in per-transport (#489): tight for HTTP (fresh request per call),
  // raised for SSE (one long-lived body across calls — idle BETWEEN calls is
  // legit). The per-call total cap (`AI_MCP_CALL_TIMEOUT_MS`) is the complementary
  // guard for chatty-but-stuck calls that keep the socket warm yet never return.
  const headersMs = mcpStreamTimeoutMs();
  return new Agent({
    ...streamingDispatcherOptions(),
    headersTimeout: headersMs,
    bodyTimeout: bodyTimeoutMs,
    connect: {
      lookup: (hostname, _options, callback) => {
        // Always resolve ALL addresses ourselves; do not trust the caller's
        // `all` flag. Validate each, then hand back the validated set.
        dnsLookup(hostname, { all: true }, (err, addresses) => {
          if (err) {
            callback(err, '', 0);
            return;
          }
          const addrs = addresses as LookupAddress[];
          const verdict = validateResolvedAddresses(addrs);
          if (!verdict.ok) {
            // Refuse the connection: net/tls.connect never sees this address.
            // An empty set is treated as blocked (nothing safe to connect to).
            const reason =
              addrs.length === 0
                ? `No address resolved for ${hostname}`
                : `Blocked address for ${hostname}`;
            callback(new Error(reason), '', 0);
            return;
          }
          // undici/net invoke this lookup with `all: true`, so the callback
          // must receive an ARRAY of validated {address, family} entries (the
          // single-address form throws ERR_INVALID_IP_ADDRESS at connect). Every
          // entry has already passed isIpAllowed, so the socket can only connect
          // to a validated address — no second, unchecked DNS resolution.
          const validated: LookupAddress[] = addrs.map((a) => ({
            address: a.address,
            family: a.family,
          }));
          (
            callback as unknown as (
              err: NodeJS.ErrnoException | null,
              addresses: LookupAddress[],
            ) => void
          )(null, validated);
        });
      },
    },
  });
}

/**
 * A fetch wrapper that re-validates the request URL's host against the SSRF
 * policy before each request AND routes the request through the SSRF-pinned
 * dispatcher, so the socket can only connect to an address that passed the
 * guard. This closes the DNS-rebinding TOCTOU between the pre-flight check and
 * the actual HTTP call, and covers every follow-up request the streamable-HTTP
 * transport makes.
 */
const guardedFetch = async (
  dispatcher: Dispatcher,
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> => {
  const rawUrl =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  let host: string;
  try {
    host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, '');
  } catch {
    throw new Error('blocked request: invalid URL');
  }
  // If the host is an IP literal, check it directly; otherwise the full URL
  // check (which re-resolves DNS) runs. Either way a blocked host throws.
  const check = isIP(host) ? isIpAllowed(host) : await isUrlAllowed(rawUrl);
  if (!check.ok) {
    throw new Error(`blocked request: ${check.reason ?? 'SSRF policy'}`);
  }
  // The dispatcher's connect.lookup re-validates and pins the actual socket IP,
  // eliminating the unchecked second resolution undici would otherwise perform.
  return fetch(input, { ...init, dispatcher } as RequestInit);
};

/** Keep only the named tools from a raw toolset. Unknown names are ignored. */
function pick(
  tools: Record<string, Tool>,
  names: string[],
): Record<string, Tool> {
  const allow = new Set(names);
  const out: Record<string, Tool> = {};
  for (const [name, t] of Object.entries(tools)) {
    if (allow.has(name)) out[name] = t;
  }
  return out;
}

/**
 * Prefix every tool name with a sanitized server name so external tools from
 * different servers never collide on merge, and so the final name respects the
 * provider constraint ^[a-zA-Z0-9_-]+$ with a bounded length.
 */
function namespace(
  tools: Record<string, Tool>,
  serverName: string,
): Array<{ full: string; raw: string; tool: Tool }> {
  const prefix = namespacePrefix(serverName);
  const out: Array<{ full: string; raw: string; tool: Tool }> = [];
  const taken: Record<string, true> = {};
  for (const [name, t] of Object.entries(tools)) {
    const safe = sanitizeName(name);
    let full = capName(`${prefix}_${safe}`);
    // Duplicate names within ONE server can still collide after sanitize/
    // truncate — suffix-disambiguate so the second tool is not overwritten.
    if (full in taken) {
      full = disambiguate(full, '', (candidate) => candidate in taken);
    }
    taken[full] = true;
    // Keep the RAW (un-namespaced) name alongside the merged key so the per-run
    // recovery wrapper (#489) can re-resolve the same tool on a fresh client.
    out.push({ full, raw: name, tool: t });
  }
  return out;
}

/**
 * The tool-name namespace prefix for a server: its sanitized name, or `mcp`
 * when the name sanitizes to empty. Tools are merged as `${prefix}_${tool}`, so
 * the prompt guidance refers to the server's tools as `${prefix}_*`.
 */
function namespacePrefix(serverName: string): string {
  return sanitizeName(serverName) || 'mcp';
}

/** Reduce an arbitrary string to ^[a-zA-Z0-9_-]+, collapsing runs to '_'. */
function sanitizeName(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_TOOL_NAME_LENGTH);
}

/** Cap a name to the provider length limit. */
function capName(name: string): string {
  return name.length > MAX_TOOL_NAME_LENGTH
    ? name.slice(0, MAX_TOOL_NAME_LENGTH)
    : name;
}

/**
 * Produce a collision-free variant of `name` within the provider constraint
 * (^[a-zA-Z0-9_-]+$, length cap). It first tries incorporating the server's
 * stable `id` (sanitized), then appends an incrementing numeric suffix, always
 * trimming the base so the suffix fits inside MAX_TOOL_NAME_LENGTH. `taken`
 * reports whether a candidate name is already used.
 */
function disambiguate(
  name: string,
  serverId: string,
  taken: (candidate: string) => boolean,
): string {
  // First try incorporating the server's stable id (when one is available).
  const idPart = sanitizeName(serverId);
  if (idPart) {
    const room = MAX_TOOL_NAME_LENGTH - (idPart.length + 1);
    const base = room > 0 ? name.slice(0, room) : '';
    const withId = capName(base ? `${base}_${idPart}` : idPart);
    if (withId.length > 0 && !taken(withId)) return withId;
  }
  // Then append an incrementing numeric suffix, trimming the base so it fits.
  for (let n = 2; n < 100_000; n += 1) {
    const suffix = `_${n}`;
    const base = name.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length);
    const candidate = `${base}${suffix}`;
    if (!taken(candidate)) return candidate;
  }
  // Extremely unlikely fallthrough: a timestamp keeps it unique, no overwrite.
  return capName(`${name.slice(0, MAX_TOOL_NAME_LENGTH - 14)}_${Date.now()}`);
}

/**
 * Wrap every tool's execute with a per-call total-timeout guard so a single
 * external MCP tool call that keeps the connection warm but never returns is
 * aborted after `ms` wall-clock (complements the transport silence timeout).
 */
export function wrapToolsWithCallTimeout(
  tools: Record<string, Tool>,
  ms: number,
): Record<string, Tool> {
  const out: Record<string, Tool> = {};
  for (const [name, t] of Object.entries(tools)) {
    out[name] = wrapToolWithCallTimeout(t, ms);
  }
  return out;
}

/**
 * Per-call total-timeout wrapper for one MCP tool. A fresh AbortController +
 * timer bounds the call; it is composed with the turn's abortSignal via
 * AbortSignal.any so EITHER the per-call timeout OR a client disconnect aborts
 * the call. We RACE the call against the composed abort signal rather than just
 * awaiting it, because @ai-sdk/mcp does NOT settle its in-flight promise on abort
 * (verified in @ai-sdk/mcp@1.0.52: request() only does throwIfAborted() once
 * before send and only re-checks the signal inside the response-message handler,
 * which runs ONLY when a response arrives). So for a warm-but-stuck call awaiting
 * `original` alone would hang forever even after the timer aborts.
 */
export function wrapToolWithCallTimeout(tool: Tool, ms: number): Tool {
  const original = tool.execute;
  if (typeof original !== 'function') return tool;
  const execute = async (args: unknown, options: ToolCallOptions) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`MCP tool call timed out after ${ms}ms`));
    }, ms);
    timer.unref?.();
    const abortSignal = options?.abortSignal
      ? AbortSignal.any([options.abortSignal, controller.signal])
      : controller.signal;
    // Reject as soon as the composed signal fires, independent of whether
    // `original` ever settles. The losing `original` promise is left pending; it
    // is cleaned up when the client is closed at turn end, and Promise.race
    // attaches a rejection handler to BOTH inputs so a late rejection of either
    // is never an unhandled rejection (do NOT add an extra .catch — it could
    // swallow the real result and would break the race semantics).
    const aborted = new Promise<never>((_, reject) => {
      const fail = () => reject(abortReason(abortSignal));
      if (abortSignal.aborted) fail();
      else abortSignal.addEventListener('abort', fail, { once: true });
    });
    try {
      return await Promise.race([
        original(args, { ...options, abortSignal }),
        aborted,
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  // `Tool` is a union whose `execute` overloads conflict; cast narrowly so the
  // wrapped tool keeps every other field while swapping only `execute`.
  return { ...tool, execute } as unknown as Tool;
}

/**
 * undici / Node network error CODES that mean the connection broke (not an
 * application-level error) — a transient transport failure a readOnly call may
 * safely retry after reconnecting. Matched against the REAL error shapes (#489):
 * a socket reset surfaces as `TypeError: fetch failed` whose `.cause` is an
 * undici `SocketError { code:'UND_ERR_SOCKET' }`; a body-timeout as
 * `TypeError: terminated` whose `.cause` is `BodyTimeoutError`. Classifying by
 * these real codes/names (not by mock errors) is essential — a mock-shaped
 * predicate would leave eviction silently dead in production while CI is green.
 */
const RETRYABLE_TRANSPORT_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CLOSED',
  'UND_ERR_DESTROYED',
]);

/** undici error CLASS names for the same transport-break conditions. */
const RETRYABLE_TRANSPORT_ERROR_NAMES: ReadonlySet<string> = new Set([
  'SocketError',
  'BodyTimeoutError',
  'HeadersTimeoutError',
  'ConnectTimeoutError',
  'ClientClosedError',
  'ClientDestroyedError',
]);

/**
 * Whether `err` is a retryable TRANSPORT break (a broken socket / body timeout),
 * classified by the REAL undici/@ai-sdk error shapes (#489). undici surfaces a
 * reset as `TypeError('fetch failed'|'terminated')` with the real error in
 * `.cause`, and @ai-sdk/mcp may wrap it again in an `MCPClientError` (cause
 * chain), so we walk `.cause` (bounded depth) checking `.code` and `.name`. An
 * app-level tool error (a 4xx, a validation failure) is NOT retryable and returns
 * false — only a connection-level failure heals with a reconnect.
 */
export function isRetryableConnectError(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== 'object' || depth > 6) return false;
  const e = err as {
    code?: unknown;
    name?: unknown;
    cause?: unknown;
  };
  if (typeof e.code === 'string' && RETRYABLE_TRANSPORT_ERROR_CODES.has(e.code)) {
    return true;
  }
  if (typeof e.name === 'string' && RETRYABLE_TRANSPORT_ERROR_NAMES.has(e.name)) {
    return true;
  }
  if (e.cause != null) return isRetryableConnectError(e.cause, depth + 1);
  return false;
}

/** The signal's reason as an Error (informative thrown value on abort/timeout). */
function abortReason(signal: AbortSignal): Error {
  const r = signal.reason;
  return r instanceof Error
    ? r
    : new Error(typeof r === 'string' ? r : 'MCP tool call aborted');
}

/** Reject a promise after `ms`, so a hung connect/tools() never stalls a turn. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${ms}ms`));
    }, ms);
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Produce a short, non-sensitive error string. Upstream error bodies and any
 * URL/header content are deliberately discarded — only the message head is kept.
 */
function shortError(err: unknown): string {
  const message =
    err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const head = (message || 'connection failed').split('\n')[0];
  return head.length > 200 ? `${head.slice(0, 200)}…` : head;
}
