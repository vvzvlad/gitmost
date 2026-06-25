import { isIP } from 'node:net';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
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
} from '../../../integrations/ai/ai-streaming-fetch';
import { SecretBoxService } from '../../../integrations/crypto/secret-box';
import { isUrlAllowed, isIpAllowed } from './ssrf-guard';

/** A closable external MCP client handle. */
export interface Closable {
  close: () => Promise<void>;
}

/** The minimal shape of an @ai-sdk/mcp client we depend on. */
interface McpClient {
  tools(): Promise<Record<string, Tool>>;
  close(): Promise<void>;
}

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
interface CacheEntry {
  tools: Record<string, Tool>;
  clients: McpClient[];
  outcomes: ServerOutcome[];
  /** Prompt guidance for qualifying servers (see McpServerInstruction). */
  instructions: McpServerInstruction[];
  expiresAt: number;
  /** Active leases (turns currently using these clients). */
  refCount: number;
  /** Set once the entry is evicted from the map; close when refCount hits 0. */
  evicted: boolean;
  /** Set once the clients have actually been closed (guards double-close). */
  closed: boolean;
  timer: NodeJS.Timeout;
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
   * In-flight-deduplicated, per-workspace toolset builds. We store the BUILD
   * PROMISE (not the resolved entry) so two concurrent turns for the same
   * workspace await the SAME build instead of each connecting to every server
   * and leaking the loser's live clients (see getOrBuildEntry).
   */
  private readonly cache = new Map<string, Promise<CacheEntry>>();
  /**
   * A single shared SSRF-pinned dispatcher for ALL outbound external-MCP fetches.
   * Its custom connect.lookup runs per connection, so one instance safely guards
   * every server's connections (we never connect to an unvalidated IP).
   */
  private readonly dispatcher: Dispatcher = buildPinnedDispatcher();
  /** guardedFetch bound to the pinned dispatcher; reused by every transport. */
  private readonly guardedFetch: typeof fetch = (input, init) =>
    guardedFetch(this.dispatcher, input, init);

  constructor(
    private readonly repo: AiMcpServerRepo,
    private readonly secretBox: SecretBoxService,
  ) {}

  /**
   * Build (or reuse a cached) external toolset for a workspace. Returns the
   * merged tools, the open client handles to release, and per-server outcomes.
   *
   * The returned `clients` are release handles: calling `close()` on each one
   * decrements the cache lease (and closes the real client only once no lease
   * remains and the entry has been evicted). The caller MUST close every handle
   * in the streamText onFinish/onError/onAbort lifecycle.
   */
  async toolsFor(workspaceId: string): Promise<ExternalToolset> {
    const entry = await this.getOrBuildEntry(workspaceId);
    // Lease the SHARED awaited entry for this turn. Because concurrent callers
    // await the same in-flight build, every lease here increments the refCount
    // of the one entry that actually owns the live clients (no leaked loser).
    entry.refCount += 1;
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
    // One release handle drives the whole leased entry; closing it releases all
    // underlying clients together (they share the same lease lifecycle).
    return {
      tools: entry.tools,
      clients: [release],
      outcomes: entry.outcomes,
      instructions: entry.instructions,
    };
  }

  /** Invalidate the cached toolset for a workspace (call on any CRUD change). */
  invalidate(workspaceId: string): void {
    const pending = this.cache.get(workspaceId);
    if (!pending) return;
    this.cache.delete(workspaceId);
    // The map holds a build PROMISE; evict once it resolves (a rejected build
    // owns no clients, so there is nothing to close).
    pending.then(
      (entry) => this.evict(entry),
      () => undefined,
    );
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
      client = await this.connect(server);
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
   * Return the per-workspace cache entry, building it at most ONCE for any set
   * of concurrent callers. We store the build PROMISE in the map: the first
   * caller installs it, concurrent callers await the same one, and refcount/
   * lease then operate on the single shared entry — so no second build's live
   * clients leak unclosed.
   */
  private async getOrBuildEntry(workspaceId: string): Promise<CacheEntry> {
    const pending = this.cache.get(workspaceId);
    if (pending) {
      const entry = await pending;
      if (entry.expiresAt > Date.now() && !entry.evicted) {
        return entry;
      }
      // Expired (or evicted under us): drop this promise and rebuild fresh.
      // Only delete if the map still points at THIS promise, so we don't
      // clobber a fresh build another caller already installed.
      if (this.cache.get(workspaceId) === pending) {
        this.cache.delete(workspaceId);
        this.evict(entry);
      }
    }

    // Install the in-flight build promise BEFORE awaiting, so concurrent callers
    // reuse it. On rejection, remove it so a later call retries.
    const build = this.buildEntry(workspaceId).catch((err: unknown) => {
      if (this.cache.get(workspaceId) === build) {
        this.cache.delete(workspaceId);
      }
      throw err;
    });
    this.cache.set(workspaceId, build);
    return build;
  }

  /** Connect to all enabled servers and assemble one cache entry. */
  private async buildEntry(workspaceId: string): Promise<CacheEntry> {
    const servers = await this.repo.listEnabled(workspaceId);
    const tools: Record<string, Tool> = {};
    const clients: McpClient[] = [];
    const outcomes: ServerOutcome[] = [];
    // Per-call total wall-clock cap, read once for this build (env-overridable).
    const callTimeoutMs = mcpCallTimeoutMs();
    const instructions: McpServerInstruction[] = [];

    for (const server of servers) {
      try {
        const client = await this.connect(server);
        const raw = await withTimeout(client.tools(), CONNECT_TIMEOUT_MS);
        clients.push(client);
        const allow = server.toolAllowlist;
        const picked =
          Array.isArray(allow) && allow.length > 0 ? pick(raw, allow) : raw;
        // Bound each tool's execute with a per-call total-timeout guard before
        // merging, so a single chatty-but-stuck call is aborted after the cap.
        const guarded = wrapToolsWithCallTimeout(picked, callTimeoutMs);
        // Namespace each tool with the sanitized server name AND disambiguate
        // against names already merged from earlier servers, so no external
        // tool is silently overwritten on collision. The returned count drives
        // whether this server's prompt guidance is included (≥1 tool merged).
        const merged = this.mergeNamespaced(
          tools,
          guarded,
          server.name,
          server.id,
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
      } catch (err) {
        // A failed server is skipped — the turn proceeds with the rest. Log a
        // short warning (never the URL/headers) so ops can see degradation, and
        // record the outcome so the UI can show "tool X unavailable".
        const reason = shortError(err);
        this.logger.warn(
          `External MCP server "${server.name}" unavailable: ${reason}`,
        );
        outcomes.push({ name: server.name, ok: false, reason });
      }
    }

    const entry: CacheEntry = {
      tools,
      clients,
      outcomes,
      instructions,
      expiresAt: Date.now() + CACHE_TTL_MS,
      refCount: 0,
      evicted: false,
      closed: false,
      timer: setTimeout(() => this.invalidate(workspaceId), CACHE_TTL_MS),
    };
    // Do not keep the process alive just for the cache timer.
    entry.timer.unref?.();
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
  ): { count: number; prefix: string } {
    let count = 0;
    for (const [name, tool] of Object.entries(namespace(picked, serverName))) {
      let key = name;
      if (key in target) {
        const original = key;
        key = disambiguate(name, serverId, (candidate) => candidate in target);
        this.logger.debug(
          `External MCP tool name "${original}" collided; renamed to "${key}"`,
        );
      }
      target[key] = tool;
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
  private async connect(
    server: Pick<AiMcpServer, 'transport' | 'url' | 'headersEnc'>,
  ): Promise<McpClient> {
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
        headers: this.decryptHeaders(server.headersEnc),
        // SSRF: reject any redirect response (no redirect-based bypass).
        redirect: 'error',
        // Defense in depth: re-validate the actual request host on EVERY fetch
        // AND pin the socket to a validated IP via the dispatcher's connect
        // lookup, closing the DNS-rebinding TOCTOU between check and connect.
        fetch: this.guardedFetch,
      },
    })) as unknown as McpClient;
    return client;
  }

  /**
   * Decrypt the stored auth headers. Returns undefined when none are set. The
   * plaintext headers live only in this returned object and are passed straight
   * to the transport — never logged.
   */
  private decryptHeaders(
    headersEnc: string | null,
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
      // Decryption/parse failure (e.g. APP_SECRET rotated). Connect WITHOUT the
      // (now unreadable) auth headers will likely 401 and be skipped — never
      // crash and never log the blob.
      this.logger.warn('Failed to decrypt MCP server auth headers');
      return undefined;
    }
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
function buildPinnedDispatcher(): Agent {
  // External-MCP traffic uses a DEDICATED, shorter silence timeout
  // (`AI_MCP_STREAM_TIMEOUT_MS`, default 5 min) — deliberately tighter than the
  // chat provider's 15-min `streamTimeoutMs()` — so a byte-silent/hung MCP
  // upstream is broken in ~5 min instead of 15. We keep the keep-alive options
  // from `streamingDispatcherOptions()` but OVERRIDE headers/body timeouts.
  // Accepted trade-off: a legitimately long but byte-silent single tool call,
  // and an SSE transport idling >5 min BETWEEN tool calls, are also cut here; the
  // per-call total cap (wrapToolsWithCallTimeout, `AI_MCP_CALL_TIMEOUT_MS`) is the
  // complementary guard for chatty-but-stuck calls that keep the socket warm yet
  // never return.
  const mcpSilenceMs = mcpStreamTimeoutMs();
  return new Agent({
    ...streamingDispatcherOptions(),
    headersTimeout: mcpSilenceMs,
    bodyTimeout: mcpSilenceMs,
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
): Record<string, Tool> {
  const prefix = namespacePrefix(serverName);
  const out: Record<string, Tool> = {};
  for (const [name, t] of Object.entries(tools)) {
    const safe = sanitizeName(name);
    let full = capName(`${prefix}_${safe}`);
    // Duplicate names within ONE server can still collide after sanitize/
    // truncate — suffix-disambiguate so the second tool is not overwritten.
    if (full in out) {
      full = disambiguate(full, '', (candidate) => candidate in out);
    }
    out[full] = t;
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
