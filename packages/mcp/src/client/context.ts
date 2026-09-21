// Shared client context + core seams (issue #450). The abstract base of the
// DocmostClient mixin chain: it owns ALL shared instance state (the axios
// client, apiUrl, auth tokens, the resolvePageId cache, the collab-token cache,
// the sandbox/metrics sinks) and the core HTTP/auth/pagination/write seams every
// domain module builds on. Domain modules are mixins layered on top; the final
// DocmostClient (client.ts) assembles them. Extracted VERBATIM from the original
// monolith — only field/seam visibility was widened from `private` to
// `protected` so sibling mixins can reach the shared state through `this`, and
// the cross-module methods that live in other mixins are declared `abstract`
// here so `this.<method>` type-checks. No behaviour changed.
import axios, { AxiosInstance } from "axios";
import FormData from "form-data";
import {
  updatePageContentRealtime,
  replacePageContent,
  markdownToProseMirror,
  markdownToProseMirrorCanonical,
  mutatePageContent,
  assertYjsEncodable,
  MutationResult,
} from "../lib/collaboration.js";
import {
  acquireCollabSession,
  isCollabAuthFailedError,
} from "../lib/collab-session.js";
import { withPageLock, isUuid } from "../lib/page-lock.js";
import { ConflictError } from "./conflict-error.js";
import type { PageId } from "../lib/page-id.js";
import { getCollabToken, performLogin } from "../lib/auth-utils.js";
import {
  formatDocmostAxiosError,
  formatSpaceNotAccessible,
} from "./errors.js";
import { GetPageConversionCache } from "./getpage-cache.js";

// A generic mixin base constructor (issue #450). Each domain mixin is a factory
// `<T extends GConstructor<DocmostClientContext>>(Base: T) => class extends Base`
// so the mixins compose into one prototype chain sharing this context.
export type GConstructor<T = {}> = abstract new (...args: any[]) => T;

/**
 * Configuration for a DocmostClient / MCP server instance. A discriminated
 * union: either service-account credentials (email/password — the client calls
 * performLogin, powering the external /mcp HTTP endpoint and the stdio CLI) OR
 * a token getter (getToken — the client uses the returned BARE access JWT as
 * the Bearer and never calls performLogin; used for the internal per-user path).
 *
 * Both branches may ALSO carry an optional `getCollabToken` provider. When set,
 * content mutations (which go over the collaboration websocket) use the token it
 * returns INSTEAD of calling `POST /auth/collab-token`. The internal per-user
 * agent path uses this to hand the client a provenance collab token (signed
 * `actor:'agent'`+`aiChatId`), so agent content edits are attributed without a
 * spoofable client-side field. When absent the client keeps the original
 * `/auth/collab-token` path (service-account/stdio unchanged).
 *
 * Housed here (not in index.ts) so client.ts has no type dependency on index.ts;
 * index.ts re-exports it for the package's public surface.
 */
// Sink the stash tool writes blobs into. The host app binds this to its in-RAM
// SandboxStore and composes the public `uri` (the package never sees the store
// or any env). `put` returns the anonymous read URL plus integrity metadata.
export type SandboxPut = (
  buf: Buffer,
  mime: string,
) => { uri: string; sha256: string; size: number };

export type DocmostMcpConfig = { apiUrl: string } & (
  | { email: string; password: string }
  | { getToken: () => Promise<string> } // returns a BARE JWT; the client adds "Bearer "
) & {
    // Optional collab-token provider (returns a ready collab JWT). Common to
    // both branches; see the type doc above.
    getCollabToken?: () => Promise<string>;
    // Optional blob sandbox sink. Present only where the stash tool is wired;
    // when absent, stashPage throws a clear "not configured" error. The
    // optional `has`/`evict` probes let stashPage keep its mirror counts honest
    // under the store's FIFO eviction (see stashPage); older sinks omit them.
    //
    // `maxBytes` / `maxImageBytes` (#613) are the sink's REAL per-blob caps —
    // the host reads them from its own configuration (on the Docmost server:
    // SANDBOX_MAX_BYTES / SANDBOX_MAX_IMAGE_BYTES, which an operator may raise)
    // and passes them in, so downloadFile pre-checks and error messages quote
    // the values the sink will ACTUALLY enforce instead of a compile-time guess.
    // Omitted by a standalone/stdio host (or an older binding) → downloadFile
    // falls back to the upstream DEFAULTS (8 MiB / 20 MiB).
    sandbox?: {
      put: SandboxPut;
      has?: (uri: string) => boolean;
      evict?: (uri: string) => void;
      maxBytes?: number;
      maxImageBytes?: number;
    };
    // Dependency-neutral metrics sink. When present, the client emits generic
    // (name, value, labels) samples; the HOST maps those names onto its own
    // metrics registry (the package never depends on prom-client or the server).
    // Absent in standalone/stdio mode → the client is a complete no-op here.
    onMetric?: (
      name: string,
      value: number,
      labels?: Record<string, string>,
    ) => void;
  };


/**
 * Collab-token cache TTL in milliseconds (issue #435). Read fresh from the
 * environment on every mint — like collab-session.ts readConfig — so tests and a
 * live rollback can change it without reloading the module.
 *
 * Why a cache at all: the live CollabSession registry (#400/#431) keys sessions
 * on (wsUrl, pageId, collabToken) for identity isolation (invariant 4). But BOTH
 * collab-token sources mint a FRESH token per mutation — the in-app provider
 * re-signs a JWT whose iat/exp (seconds) changes every second, and the external
 * MCP POSTs /auth/collab-token each call — so the token in the key changed on
 * every op and the session was almost never reused (connect-storms, 25s
 * timeouts, zombie sessions). Caching the token per-client keeps the key stable
 * across a burst of mutations so ONE session is reused.
 *
 * Default 5 min: well under the 24h collab-token lifetime AND <= the collab
 * session max-age (10 min, MCP_COLLAB_SESSION_MAX_AGE_MS), so the
 * permission-staleness window is not widened beyond what #431 already accepted.
 * The rollback knob is an EXPLICIT 0 (or a negative number): that DISABLES the
 * cache — an exact fetch-per-call legacy path, mirroring how idleMs<=0 disables
 * the session cache. Unset OR unparseable (e.g. a typo like "5min", "abc") falls
 * back to the 5-min default with the cache ON — parseInt yields NaN, which is
 * treated as "not configured", not as "disabled". So to turn the cache off you
 * must set the value to exactly 0, not to garbage.
 */
function readCollabTokenTtlMs(): number {
  const raw = parseInt(process.env.MCP_COLLAB_TOKEN_TTL_MS ?? "", 10);
  return Number.isFinite(raw) ? Math.max(0, raw) : 5 * 60 * 1000;
}

/**
 * Accessible-space index cache TTL in milliseconds (issue #534). Read fresh from
 * the environment on every access — mirroring readCollabTokenTtlMs above — so a
 * test or a live rollback can change it without reloading the module.
 *
 * The index (see getAccessibleSpaceIndex) is fetched ONLY on the enrich-on-404
 * slow path to turn an opaque "Space permissions not found" 404 into a factual
 * "spaceId X is not among your accessible spaces" hint; a short TTL keeps a burst
 * of failing tool calls from re-sweeping /spaces each time while never widening
 * the permission-staleness window meaningfully. Default 60s. An EXPLICIT 0 (or
 * negative) DISABLES the cache (exact fetch-per-enrichment). Unset/unparseable
 * (NaN) falls back to the 60s default with the cache ON.
 */
function readSpacesCacheTtlMs(): number {
  const raw = parseInt(process.env.MCP_SPACES_CACHE_TTL_MS ?? "", 10);
  return Number.isFinite(raw) ? Math.max(0, raw) : 60000;
}

/**
 * #654 — read-your-own-writes window in milliseconds. After a write to page P
 * the client marks P `recentlyWritten` for this long; a structural read of P
 * within the window sets the `preferLive` hint so the server serves the live
 * (acked-but-maybe-unflushed) content instead of the debounce-stale DB row.
 *
 * Default 60_000 (> Hocuspocus maxDebounce=45_000 + slack): once the window
 * lapses the DB row is guaranteed to reflect the store, so the hint is pointless
 * and is dropped (the read reverts to the cheap DB path, no owner probe). Read
 * fresh from the env on every access (mirroring the caches above) so a rollback
 * can change it without reloading the module. Unset/unparseable (NaN) or a
 * non-positive value falls back to the 60s default.
 */
function readRyowWindowMs(): number {
  const raw = parseInt(process.env.GITMOST_RYOW_WINDOW_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 60000;
}

/**
 * The set of spaces the current token can see, plus a `complete` flag that is
 * false when the /spaces listing was truncated at the pagination ceiling. Used
 * by the enrich-on-404 diagnostics: an authoritative membership test is only
 * possible when `complete` is true (see withSpaceAccessDiagnostics).
 */
export type AccessibleSpaceIndex = {
  ids: Set<string>;
  spaces: { id: string; name: string }[];
  complete: boolean;
};

export abstract class DocmostClientContext {
  protected client: AxiosInstance;
  protected token: string | null = null;
  protected apiUrl: string;
  // email/password are only set on the service-account (credentials) variant;
  // null on the getToken variant (where there are no credentials to log in with).
  protected email: string | null = null;
  protected password: string | null = null;
  // Per-user token provider. When set, login() calls it to obtain a BARE access
  // JWT instead of performLogin, and the 401/403 re-auth path re-calls it.
  protected getTokenFn: (() => Promise<string>) | null = null;
  // Optional collab-token provider. When set, getCollabTokenWithReauth() returns
  // its token instead of calling POST /auth/collab-token; on a 401/403 it is
  // re-invoked once. Used by the internal agent to carry signed provenance.
  protected getCollabTokenFn: (() => Promise<string>) | null = null;
  // Optional blob-sandbox sink for the stash tool. Null when not configured.
  protected sandboxPut: SandboxPut | null = null;
  // Optional probes paired with the sink. `has` lets stashPage detect a blob
  // FIFO-evicted by a LATER put in the same stash; `evict` lets it free this
  // op's image blobs if the final doc put throws. Null when the sink omits them.
  protected sandboxHas: ((uri: string) => boolean) | null = null;
  protected sandboxEvict: ((uri: string) => void) | null = null;
  // The sink's REAL per-blob caps, as reported by the host (#613). Null when the
  // host does not report them (standalone/stdio, or an older binding) → the
  // consumer (downloadFile) falls back to the upstream defaults. A non-finite /
  // non-positive value from a misconfigured host is IGNORED (treated as absent)
  // so a bad number can never disable or zero out the size guards.
  protected sandboxMaxBytes: number | null = null;
  protected sandboxMaxImageBytes: number | null = null;
  // Optional dependency-neutral metrics sink (see DocmostMcpConfig.onMetric).
  // Null on the legacy positional form and whenever the host omits it → no-op.
  protected onMetricFn:
    | ((name: string, value: number, labels?: Record<string, string>) => void)
    | null = null;
  // In-flight login dedup: when the token expires, the 401 interceptor,
  // ensureAuthenticated, getCollabTokenWithReauth and the two multipart retries
  // can all call login() at once. Memoizing a single promise collapses that
  // thundering herd into ONE /auth/login request that everyone awaits.
  protected loginPromise: Promise<void> | null = null;
  // Canonical-UUID cache for resolvePageId: maps an agent-supplied slugId to the
  // page's canonical UUID, so repeated collab edits on the same page do not
  // re-fetch /pages/info. A UUID input short-circuits before this cache (see
  // resolvePageId), so only slugId->uuid entries are stored/read here.
  protected pageIdCache = new Map<string, string>();

  // #654 — recently-written pages for read-your-own-writes: maps a page's
  // canonical UUID to the wall-clock time its RYOW window EXPIRES. Written by
  // rememberWrite on every content mutation whose verify reports a real change;
  // read by shouldPreferLive to decide the opt-in `preferLive` freshness hint.
  // Per-instance (a DocmostClient is built per user / per chat) so it can never
  // leak across identities, and lost on client teardown (RYOW is intra-turn
  // only, by design). rememberWrite full-sweeps expired entries on every write,
  // so the map cannot grow unbounded on a long-lived stdio client.
  protected recentlyWritten = new Map<string, number>();

  // Collab-token cache (issue #435): the last minted collab token plus the
  // wall-clock time it was minted, so a burst of content mutations reuses ONE
  // token and therefore ONE live CollabSession (whose registry key includes the
  // token — #400 invariant 4). Per-instance: a DocmostClient is built per
  // user/per chat request, so a cached token can never leak across identities.
  // Reset whenever the client's identity changes (login() / this.token cleared);
  // bypassed on a forced refresh (the 401/403 reauth path). null = no token yet.
  protected collabTokenCache: { token: string; mintedAt: number } | null = null;

  // Accessible-space index cache + single-flight (issue #534). TWO separate
  // fields, mirroring loginPromise (in-flight dedup) vs collabTokenCache
  // (persistent value):
  //   - spaceIndexCache: the last SUCCESSFULLY-FETCHED, COMPLETE index plus the
  //     wall-clock time it was fetched. Written ONLY from a resolved /spaces
  //     sweep whose result was complete (a truncated list is never cached, since
  //     it cannot answer "is this spaceId missing?"). Per-instance (a
  //     DocmostClient is built per user / per chat) so it can never leak across
  //     identities; invalidated on every identity change exactly like
  //     collabTokenCache (login() + the 401/403 reauth interceptor).
  //   - spaceIndexInFlight: dedups concurrent enrich-on-404 fetches into ONE
  //     /spaces sweep. CRITICAL INVARIANT: this promise is nulled in `.finally`
  //     on BOTH resolve AND reject — a rejected/settled promise is NEVER
  //     memoized, so a transient /spaces blip during one failed tool call cannot
  //     poison the diagnostics for the rest of the session.
  protected spaceIndexCache: {
    index: AccessibleSpaceIndex;
    fetchedAt: number;
  } | null = null;
  protected spaceIndexInFlight: Promise<AccessibleSpaceIndex> | null = null;

  // Content-addressed conversion cache for getPage (issue #479). Keyed on
  // (canonical pageId, updatedAt, optionsHash) -> the converted Markdown, so a
  // re-read of an UNCHANGED page skips the expensive convertProseMirrorToMarkdown
  // tree walk. Per-instance (a DocmostClient is built per user / per chat), so a
  // cached conversion can never leak across identities. See getpage-cache.ts.
  protected getPageCache = new GetPageConversionCache();

  // #487: an OPTIONAL abort signal the in-app tool host sets before each tool
  // call (a composite of the turn's Stop signal + a per-call wall-clock cap). It
  // is checked at safe-points BETWEEN the sequential HTTP calls of a paginated
  // read (paginateAll) and just before the atomic collab commit of a write (the
  // mutatePage/replacePage/mutateLiveContentUnlocked seams), so a Stop / cap
  // stops the NEXT network call from STARTING. An already-started single call may
  // still land — a documented limitation (#487).
  //
  // SINGLE-WRITER by phase-1 assumption: exactly one DocmostClient is built per
  // turn and shared by every tool call; the host sets this per call and does NOT
  // restore the prior value on unwind (set-and-leave) — a fresh client per turn
  // plus overwrite-by-the-next-call keeps it correct, and leaving a settled
  // call's signal in place is what makes a discarded race-loser throw on its
  // next safe-point. If the model emits PARALLEL in-app
  // tool calls they share this one field, so the per-call CAP of one call is not
  // guaranteed to bound another's in-flight pagination — but every composite the
  // host sets carries the SAME turn Stop signal, so a Stop still aborts whichever
  // signal is current. #487.
  protected toolAbortSignal: AbortSignal | null = null;

  /**
   * #487: set (or clear with null) the in-app tool abort signal governing the
   * NEXT client call's safe-points. The host wraps each in-app tool call: it sets
   * the composite (Stop + per-call cap) here before invoking the tool and leaves
   * it in place afterwards (set-and-leave, NOT restored) — the next call
   * overwrites it, and a fresh client is built per turn. Public so the
   * server-side tool wrapper can reach it; harmless (a no-op) when never set.
   */
  public setToolAbortSignal(signal: AbortSignal | null): void {
    this.toolAbortSignal = signal;
  }

  /** #487: the abort signal currently governing this client's safe-points. */
  public getToolAbortSignal(): AbortSignal | null {
    return this.toolAbortSignal;
  }

  // Two construction forms:
  //  - new DocmostClient(config)                  // discriminated union (current)
  //  - new DocmostClient(baseURL, email, password) // legacy positional creds
  // The positional form is retained so existing callers/tests keep working; it
  // is exactly equivalent to the credentials branch of the object form.
  constructor(config: DocmostMcpConfig);
  constructor(baseURL: string, email: string, password: string);
  constructor(
    configOrBaseURL: DocmostMcpConfig | string,
    email?: string,
    password?: string,
  ) {
    // Normalize the legacy positional form into the object union.
    const config: DocmostMcpConfig =
      typeof configOrBaseURL === "string"
        ? { apiUrl: configOrBaseURL, email: email!, password: password! }
        : configOrBaseURL;

    this.apiUrl = config.apiUrl;
    if ("getToken" in config) {
      // Token variant: carry the user's JWT via getToken; no credentials, so
      // login() must never call performLogin (there is nothing to log in with).
      this.getTokenFn = config.getToken;
    } else {
      // Service-account variant: behaves exactly as before (performLogin).
      this.email = config.email;
      this.password = config.password;
    }
    // Optional, available to both variants. When present, content mutations get
    // their collab token from here instead of POST /auth/collab-token.
    if (config.getCollabToken) {
      this.getCollabTokenFn = config.getCollabToken;
    }
    if (config.sandbox) {
      this.sandboxPut = config.sandbox.put;
      this.sandboxHas = config.sandbox.has ?? null;
      this.sandboxEvict = config.sandbox.evict ?? null;
      const positive = (v: unknown): number | null =>
        typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
      this.sandboxMaxBytes = positive(config.sandbox.maxBytes);
      this.sandboxMaxImageBytes = positive(config.sandbox.maxImageBytes);
    }
    // Legacy positional form carries no onMetric → null (complete no-op).
    this.onMetricFn = config.onMetric ?? null;
    this.client = axios.create({
      baseURL: this.apiUrl,
      // Default request timeout so a hung connection cannot wedge a per-page
      // lock or block the server indefinitely. Multipart uploads override this
      // with a longer per-request timeout.
      timeout: 30000,
      headers: {
        "Content-Type": "application/json",
      },
    });

    // Re-authenticate transparently on a 401/403 once: the JWT authToken can
    // expire while the server is long-running, after which every cached-token
    // request would otherwise fail until a manual restart. On such a response,
    // clear the stale token, perform a fresh login, and replay the original
    // request exactly once (guarded by config._retry to avoid infinite loops;
    // the login request itself is never retried).
    this.client.interceptors.response.use(
      (response) => response,
      async (error) => {
        const config = error.config;
        const status = error.response?.status;
        const isAuthError = status === 401 || status === 403;
        const isLoginRequest =
          typeof config?.url === "string" && config.url.includes("/auth/login");

        if (config && isAuthError && !config._retry && !isLoginRequest) {
          config._retry = true;
          // Drop the stale token + Authorization header before re-login. Also
          // clear the collab-token cache (#435): a new identity/login must not
          // keep serving a collab token minted under the old one.
          this.token = null;
          this.collabTokenCache = null;
          // #534: a new identity/login must not keep serving a space index
          // computed under the old token (same reasoning as collabTokenCache).
          this.spaceIndexCache = null;
          delete this.client.defaults.headers.common["Authorization"];
          try {
            await this.login();
          } catch (loginError) {
            // Re-login failed: surface the original error to the caller.
            return Promise.reject(error);
          }
          // Re-issue the original request with the freshly minted Bearer token.
          // Read it from the default header that login() just set, not from
          // this.token, to avoid a theoretical "Bearer null" if this.token was
          // cleared between login() resolving and this point.
          config.headers = config.headers || {};
          config.headers["Authorization"] =
            this.client.defaults.headers.common["Authorization"];
          return this.client.request(config);
        }

        return Promise.reject(error);
      },
    );

    // Diagnostics interceptor (issue #437). Registered AFTER the re-login
    // interceptor so a successful re-login retry (which resolves to a real
    // response) is never seen here as an error; only a genuine failure reaches
    // this rejection handler. It reformats error.message IN PLACE (see
    // formatDocmostAxiosError — kept as a mutation, not a custom Error class, so
    // the surrounding axios.isAxiosError / error.response?.status / config._retry
    // checks keep working) and re-rejects the SAME error. The _docmostFormatted
    // flag makes a re-processed retry-failure a no-op.
    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        formatDocmostAxiosError(error);
        return Promise.reject(error);
      },
    );
  }


  // --- Cross-module seams (issue #450) -----------------------------------
  // A method in one domain mixin sometimes calls a PROTECTED method owned by
  // another mixin (e.g. nodes-write -> validateDocUrls in doc-validate). Those
  // callees are `protected`, so they cannot be surfaced through the public
  // per-mixin interfaces. Declaring them here on the shared base lets `this.<m>`
  // type-check across modules. Each is a stub that is ALWAYS overridden by the
  // owning mixin (layered above this base in the chain), so the body never runs;
  // it throws only to make an impossible mis-wiring loud instead of silent.
  // (The PUBLIC cross-module callees — getPage, getPageJson, listComments,
  // deleteComment, listPageHistory — arrive via the mixins' public interfaces,
  // so they are not restated here.)
  protected enumerateSpacePages(
    _spaceId: string,
    _rootPageId?: string,
  ): Promise<{ pages: any[]; truncated: boolean }> {
    throw new Error("enumerateSpacePages not wired (missing ReadMixin)");
  }
  protected validateDocUrls(_node: any, _depth?: number): void {
    throw new Error("validateDocUrls not wired (missing DocValidateMixin)");
  }
  protected validateDocStructure(_node: any, _depth?: number): void {
    throw new Error("validateDocStructure not wired (missing DocValidateMixin)");
  }
  protected assertValidNodeShape(_op: string, _node: any): void {
    throw new Error("assertValidNodeShape not wired (missing DocValidateMixin)");
  }
  protected fetchInternalFile(
    _src: string,
    _maxBytes?: number,
  ): Promise<{ buffer: Buffer; mime: string }> {
    throw new Error("fetchInternalFile not wired (missing StashMixin)");
  }
  protected uploadAttachmentBuffer(
    _pageId: string,
    _buffer: Buffer,
    _fileName: string,
    _mime: string,
  ): Promise<{ id: string; fileName: string; fileSize: number }> {
    throw new Error("uploadAttachmentBuffer not wired (missing MediaMixin)");
  }
  protected fetchAttachmentText(_src: string): Promise<string> {
    throw new Error("fetchAttachmentText not wired (missing MediaMixin)");
  }
  // PUBLIC cross-module callees. Declared here too (as always-overridden stubs)
  // so a mixin calling e.g. `this.getPageJson` type-checks against the base —
  // the mixin's own public interface only covers its own methods. The real
  // implementations live in ReadMixin / CommentsMixin / PagesMixin and shadow
  // these on the prototype chain.
  getPage(_pageId: string): Promise<any> {
    throw new Error("getPage not wired (missing ReadMixin)");
  }
  getPageJson(_pageId: string): Promise<any> {
    throw new Error("getPageJson not wired (missing ReadMixin)");
  }
  // Called by MediaMixin.uploadFile (#608) to insert the just-uploaded node.
  // Real implementation lives in NodesWriteMixin and shadows this on the
  // prototype chain; the stub keeps the base type-checkable in isolation.
  // Signature mirrors INodesWriteMixin.insertNode 1:1 (nodes-write.ts).
  insertNode(
    _pageId: string,
    _input: { markdown?: string; node?: any },
    _opts: {
      position: "before" | "after" | "append";
      anchorNodeId?: string;
      anchorText?: string;
    },
  ): Promise<any> {
    throw new Error("insertNode not wired (missing NodesWriteMixin)");
  }
  listComments(_pageId: string, _includeResolved?: boolean): Promise<any> {
    throw new Error("listComments not wired (missing CommentsMixin)");
  }
  deleteComment(_commentId: string): Promise<any> {
    throw new Error("deleteComment not wired (missing CommentsMixin)");
  }
  listPageHistory(_pageId: string, _cursor?: string): Promise<any> {
    throw new Error("listPageHistory not wired (missing PagesMixin)");
  }

  /** Application base URL (API URL without the /api suffix). */
  get appUrl(): string {
    return this.apiUrl.replace(/\/api\/?$/, "");
  }


  async login() {
    // Reuse an in-flight login if one is already running so concurrent callers
    // share a single token fetch instead of each issuing their own.
    if (!this.loginPromise) {
      // Token variant: re-fetch a BARE JWT via getToken() (there are no
      // credentials to log in with — on a 401/403 the interceptor below calls
      // login() again, which re-invokes getToken()). Credentials variant:
      // performLogin against /auth/login exactly as before.
      const fetchToken = this.getTokenFn
        ? this.getTokenFn()
        : performLogin(this.apiUrl, this.email!, this.password!);
      this.loginPromise = fetchToken
        .then((token) => {
          // Guard against an empty/invalid token (e.g. a getToken provider that
          // resolves to "" or null): without this an empty token would set a
          // literal "Authorization: Bearer null"/"Bearer " header and every
          // request would 401 with a confusing error. Fail loudly instead.
          if (typeof token !== "string" || token.length === 0) {
            throw new Error("getToken returned an empty token");
          }
          this.token = token;
          // Identity (re)established: drop any collab token minted under a
          // previous identity so the #435 cache can never outlive it.
          this.collabTokenCache = null;
          // #534: likewise drop the accessible-space index of the old identity.
          this.spaceIndexCache = null;
          this.client.defaults.headers.common["Authorization"] =
            `Bearer ${token}`;
        })
        .finally(() => {
          this.loginPromise = null;
        });
    }
    return this.loginPromise;
  }


  async ensureAuthenticated() {
    if (!this.token) {
      await this.login();
    }
  }

  /**
   * Fetch a collaboration token, transparently re-authenticating once on a
   * 401/403. getCollabToken() uses bare axios internally, so it is NOT covered
   * by this.client's response interceptor; this helper replicates that
   * behaviour for collab-token requests: ensure a token, try once, and on an
   * expired-token auth error perform a fresh login and retry exactly once.
   *
   * Collab-token cache (issue #435): both sources — the getCollabToken provider
   * (in-app agent) AND the REST /auth/collab-token endpoint (external MCP) — mint
   * a FRESH token per call, whose string therefore changes every op. Since the
   * live CollabSession registry keys on the token string (#400/#431 invariant 4),
   * that churned the key and defeated session reuse. So we cache the last minted
   * token per-client for readCollabTokenTtlMs() and hand it back for a burst of
   * mutations, keeping the session key stable. `forceRefresh` bypasses the cache
   * (the 401/403 reauth retry uses it, so the retry cannot be handed the same
   * stale token that just failed — otherwise reauth would be a no-op). TTL 0
   * disables the cache: exact fetch-per-call legacy behaviour.
   */
  protected async getCollabTokenWithReauth(
    forceRefresh = false,
  ): Promise<string> {
    const ttl = readCollabTokenTtlMs();
    // Serve the cached collab token while it is still fresh (identity isolation
    // is preserved: the cache is a per-instance field on a client built per
    // user/per chat request, and it is cleared on every identity change).
    if (
      !forceRefresh &&
      ttl > 0 &&
      this.collabTokenCache &&
      Date.now() - this.collabTokenCache.mintedAt < ttl
    ) {
      return this.collabTokenCache.token;
    }

    // Collab-token PROVIDER path: when a getCollabToken provider was supplied
    // (the internal agent's provenance collab token), use it instead of the
    // REST /auth/collab-token endpoint. Re-invoke it once on a 401/403 (e.g. the
    // signed token expired between content mutations in a long agent turn).
    if (this.getCollabTokenFn) {
      try {
        const token = await this.getCollabTokenFn();
        if (typeof token !== "string" || token.length === 0) {
          throw new Error("getCollabToken returned an empty token");
        }
        return this.rememberCollabToken(token, ttl);
      } catch (e) {
        // On an auth error retry EXACTLY once, forcing a refresh so the retry
        // re-invokes the provider (bypassing the cache) for a genuinely fresh
        // token. `!forceRefresh` bounds it to a single retry (no loop).
        if (this.isCollabAuthError(e) && !forceRefresh) {
          return this.getCollabTokenWithReauth(true);
        }
        throw e;
      }
    }

    await this.ensureAuthenticated();
    try {
      const token = await getCollabToken(this.apiUrl, this.token!);
      return this.rememberCollabToken(token, ttl);
    } catch (e) {
      // getCollabToken wraps the AxiosError in a plain Error but attaches the
      // HTTP status as `.status`, so isCollabAuthError detects an auth failure
      // via either the raw AxiosError shape OR the attached status.
      if (this.isCollabAuthError(e) && !forceRefresh) {
        // Fresh login (which clears this.token AND the collab-token cache), then
        // retry exactly once with the cache bypassed via forceRefresh.
        await this.login();
        return this.getCollabTokenWithReauth(true);
      }
      throw e;
    }
  }

  /**
   * Store a freshly minted collab token in the per-client cache (issue #435) and
   * return it unchanged. No-op write when the cache is disabled (ttl<=0) or the
   * token is empty, so a disabled cache is exact fetch-per-call legacy behaviour
   * and a bad token is never cached.
   */
  protected rememberCollabToken(token: string, ttl: number): string {
    if (ttl > 0 && typeof token === "string" && token.length > 0) {
      this.collabTokenCache = { token, mintedAt: Date.now() };
    }
    return token;
  }

  /**
   * True when an error carries a 401/403 — either as a raw AxiosError
   * (`error.response.status`) or as the plain-Error `.status` that
   * lib/auth-utils.getCollabToken attaches after wrapping the AxiosError.
   */
  protected isCollabAuthError(e: unknown): boolean {
    const axiosStatus = axios.isAxiosError(e) ? e.response?.status : undefined;
    const attachedStatus = (e as any)?.status;
    return (
      axiosStatus === 401 ||
      axiosStatus === 403 ||
      attachedStatus === 401 ||
      attachedStatus === 403
    );
  }

  /**
   * Run a collab write and, on a Hocuspocus HANDSHAKE auth failure, self-heal
   * once (#486). Symmetric to the HTTP-401 path in getCollabTokenWithReauth: the
   * REST interceptor and login() already drop the cached collab token on a 401/
   * 403, but a rejected WEBSOCKET handshake left the stale token in the cache, so
   * every subsequent mutation kept re-presenting the same bad token for up to the
   * collab-token TTL (minutes) with no self-heal. Here, when the write rejects
   * with the tagged collab-auth error, we invalidate the cached token and retry
   * the write EXACTLY once with a force-refreshed token. Not a loop: a second
   * failure (or any non-auth error) propagates unchanged.
   *
   * `write` receives the token to use, so the retry can hand it a genuinely fresh
   * one rather than re-running with the same stale string.
   */
  protected async writeWithCollabAuthRetry<T>(
    collabToken: string,
    write: (token: string) => Promise<T>,
  ): Promise<T> {
    try {
      return await write(collabToken);
    } catch (e) {
      // INVARIANT (#494/#435): this auto-retry MUST stay auth-only. A collab
      // write can fail INDETERMINATE — its update may already have reached and
      // persisted on the server (e.g. an LRU eviction of a busy session, tagged
      // via isCollabIndeterminateError). Blindly retrying such a write duplicates
      // it (the #435 double-apply class). If this gate is ever widened to retry a
      // broader error class, FIRST check `isCollabIndeterminateError(e)` and do
      // NOT retry an indeterminate write — re-read and verify before any retry.
      if (!isCollabAuthFailedError(e)) throw e;
      // The WS handshake rejected our token: drop it from the cache so it can't
      // be reused for the rest of the TTL, mint a fresh one (forceRefresh bypasses
      // the cache and re-invokes the provider/login), and retry the write once.
      this.collabTokenCache = null;
      const fresh = await this.getCollabTokenWithReauth(true);
      return await write(fresh);
    }
  }

  /**
   * Connect to the collaboration websocket, read the live doc, apply
   * `transform`, write the result, and wait for the server to persist it —
   * WITHOUT acquiring the per-page lock.
   *
   * This mirrors collaboration.mutatePageContent EXCEPT that it does not call
   * withPageLock. It exists solely so replaceImage can hold ONE withPageLock
   * across its scan -> upload -> write sequence: the per-page mutex is NOT
   * reentrant, so calling the normal (self-locking) mutatePageContent inside an
   * outer withPageLock for the same pageId would deadlock. The caller MUST hold
   * the page lock for the whole operation; this helper assumes that invariant.
   *
   * `transform` receives the live ProseMirror doc and returns the NEW full doc
   * to write, or `null` to abort with no write. Errors thrown by `transform`
   * propagate to the caller.
   *
   * Resolves a `MutationResult { doc, verify }` mirroring mutatePageContent, so
   * every content mutator (including replaceImage) can return a verifiable
   * change report. The report is computed AFTER the atomic read->write and
   * never throws.
   */
  protected async mutateLiveContentUnlocked(
    pageId: string,
    collabToken: string,
    transform: (liveDoc: any) => any | null,
  ): Promise<MutationResult> {
    // Reuse a live CollabSession for the page (issue #400) instead of opening a
    // fresh provider per op. acquireCollabSession does NOT take the per-page
    // lock — the caller (replaceImage) already holds ONE withPageLock across its
    // scan -> upload -> write sequence, and the mutex is not reentrant, so
    // taking it here would deadlock. The synchronous read->write section and the
    // unsyncedChanges/connectionLost ack logic live in CollabSession.mutate,
    // preserved verbatim from the old inline machine (incl. the #152 structural
    // diff that keeps a live editor's cursor anchored).
    // Wrap in the collab-auth self-heal (#486): a rejected WS handshake drops the
    // cached collab token and retries once with a fresh one (the retry passes the
    // refreshed token down to acquireCollabSession via `token`).
    const result = await this.writeWithCollabAuthRetry(
      collabToken,
      async (token) => {
        const session = await acquireCollabSession(pageId, token, this.apiUrl, {
          // Only the actual 25s collab connect timeout emits this — the connect-
          // vs-unload signal; the other failure paths must NOT emit it.
          onConnectTimeout: () =>
            this.onMetricFn?.("collab_connect_timeouts_total", 1),
        });
        try {
          // #487 PRE-COMMIT safe-point (reentrant twin of mutatePageContent): a
          // Stop/cap after acquiring the session but before the atomic write skips
          // this commit. Same limitation applies (stops the NEXT commit only).
          this.toolAbortSignal?.throwIfAborted();
          return await session.mutate(transform);
        } catch (e) {
          // Drop the session on any failure so the next call reconnects fresh.
          session.destroy("mutate failed");
          throw e;
        }
      },
    );
    // #654 — replaceImage's write primitive (a THIRD path, not via
    // mutatePageContent) still arms read-your-own-writes (no-op when unchanged).
    this.rememberWrite(pageId, result?.verify);
    return result;
  }

  /**
   * Generic pagination handler for Docmost API endpoints. Thin wrapper over
   * paginateAllWithMeta that discards the `truncated` flag — the historical
   * contract every caller (getSpaces, etc.) relies on. Callers that need to KNOW
   * whether the result set was complete (e.g. #534's getAccessibleSpaceIndex,
   * which must not assert "spaceId missing" against a truncated list) call
   * paginateAllWithMeta directly.
   */
  async paginateAll<T = any>(
    endpoint: string,
    basePayload: Record<string, any> = {},
    limit: number = 100,
  ): Promise<T[]> {
    return (await this.paginateAllWithMeta<T>(endpoint, basePayload, limit))
      .items;
  }

  /**
   * Generic pagination handler that ALSO surfaces whether the result was
   * truncated at the MAX_PAGES ceiling. `paginateAll` swallows this flag (it only
   * warns); callers that must distinguish "complete listing" from "gave up at the
   * cap" use this overload. `truncated` is true iff the loop stopped at the
   * ceiling while the server still reported more pages.
   */
  async paginateAllWithMeta<T = any>(
    endpoint: string,
    basePayload: Record<string, any> = {},
    limit: number = 100,
  ): Promise<{ items: T[]; truncated: boolean }> {
    await this.ensureAuthenticated();

    const clampedLimit = Math.max(1, Math.min(100, limit));

    // Hard ceiling on the number of pages to fetch: guards against a server
    // that returns a perpetually-true hasNextPage (which would otherwise loop
    // forever and accumulate duplicates).
    const MAX_PAGES = 50;

    let cursor: string | undefined;
    let allItems: T[] = [];
    let truncated = false;

    for (let page = 0; page < MAX_PAGES; page++) {
      // #487 safe-point: a Stop (or the in-app tool per-call cap) that fires
      // BETWEEN sequential page fetches must stop the NEXT request from starting
      // — a read tool that would otherwise paginate for minutes is interrupted
      // here. throwIfAborted() rejects with the signal's reason.
      this.toolAbortSignal?.throwIfAborted();
      const payload: Record<string, any> = {
        ...basePayload,
        limit: clampedLimit,
      };
      if (cursor) payload.cursor = cursor;

      const response = await this.client.post(endpoint, payload);

      const data = response.data;
      const items = data.data?.items || data.items || [];
      const meta = data.data?.meta || data.meta;

      allItems = allItems.concat(items);

      // Advance strictly via the server-issued cursor. A missing nextCursor (or
      // hasNextPage false) means we reached the end. A cursor identical to the
      // one we just sent means the server did not understand our pagination
      // param — stop instead of re-fetching page one forever and duplicating.
      const next = meta?.hasNextPage ? meta?.nextCursor : null;
      if (!next || next === cursor) {
        // If the server still reports more pages but stopped issuing a usable
        // cursor at the ceiling, flag the result as truncated below.
        if (page === MAX_PAGES - 1 && meta?.hasNextPage) truncated = true;
        break;
      }
      cursor = next;

      // Reaching the ceiling with more pages still available means the result
      // set is truncated.
      if (page === MAX_PAGES - 1) truncated = true;
    }

    // If the loop stopped because it hit the MAX_PAGES ceiling while the server
    // still reported more results, the result set is truncated — warn so the
    // caller is not silently handed an incomplete list.
    if (truncated) {
      console.warn(
        `paginateAll: results from "${endpoint}" truncated at the ${MAX_PAGES}-page cap; more pages exist on the server`,
      );
    }

    return { items: allItems, truncated };
  }

  /**
   * The set of spaces the current token can access (issue #534), fetched from the
   * single source of truth — the `/spaces` listing — with a per-instance
   * short-TTL cache and single-flight dedup. Used ONLY by the enrich-on-404 slow
   * path (withSpaceAccessDiagnostics), so the happy path incurs ZERO extra
   * requests.
   *
   * `complete` is `!truncated`: it is false when the /spaces listing was cut at
   * the pagination ceiling. A truncated index can never authoritatively answer
   * "is this spaceId missing?", so only a complete result is cached AND only a
   * complete result is allowed to drive the "not accessible" rewrite.
   *
   * Cache/single-flight discipline (see the spaceIndexCache / spaceIndexInFlight
   * field docs):
   *   - serve a fresh, complete cached index without any request;
   *   - otherwise collapse concurrent callers onto ONE in-flight /spaces sweep;
   *   - write the persistent cache ONLY from a resolved, complete fetch;
   *   - null the in-flight promise on BOTH resolve and reject (never memoize a
   *     rejected promise — a transient /spaces failure must be retried fresh).
   */
  async getAccessibleSpaceIndex(): Promise<AccessibleSpaceIndex> {
    const ttl = readSpacesCacheTtlMs();

    // Fast path: a still-fresh, complete cached index needs no request at all.
    if (
      ttl > 0 &&
      this.spaceIndexCache &&
      Date.now() - this.spaceIndexCache.fetchedAt < ttl
    ) {
      return this.spaceIndexCache.index;
    }

    // Single-flight: a concurrent enrichment joins the in-flight sweep instead of
    // issuing its own. (A settled/rejected promise is never left here — see the
    // `.finally` below — so this only ever joins a genuinely in-progress fetch.)
    if (this.spaceIndexInFlight) return this.spaceIndexInFlight;

    const fetchPromise = (async (): Promise<AccessibleSpaceIndex> => {
      const { items, truncated } = await this.paginateAllWithMeta("/spaces", {});
      const spaces = items.map((s: any) => ({
        id: s?.id,
        name: s?.name,
      }));
      return {
        ids: new Set(spaces.map((s) => s.id)),
        spaces,
        complete: !truncated,
      };
    })();

    this.spaceIndexInFlight = fetchPromise
      .then((index) => {
        // Cache ONLY a complete result, and only while the cache is enabled.
        if (ttl > 0 && index.complete) {
          this.spaceIndexCache = { index, fetchedAt: Date.now() };
        }
        return index;
      })
      .finally(() => {
        // CRITICAL (#534): clear the in-flight slot on BOTH resolve and reject.
        // Nulling on reject too means a transient /spaces error is retried by the
        // NEXT enrichment with a fresh fetch, never re-serving the rejection.
        this.spaceIndexInFlight = null;
      });

    return this.spaceIndexInFlight;
  }

  /**
   * Wrap a client method whose 404 means "the supplied spaceId is not accessible"
   * and, ONLY on that 404, replace the opaque server text ("Space permissions not
   * found") with a factual, actionable message naming the spaceId and the spaces
   * the token can actually see (issue #534). A HINT layered on top of the
   * backend, which stays authoritative — so it FAILS OPEN on ANY uncertainty:
   * every branch below that is not a confident "this spaceId is genuinely
   * missing" rethrows the ORIGINAL server error unchanged. The happy path returns
   * fn()'s value with zero extra requests.
   *
   * WRAP-ALLOWLIST INVARIANT (load-bearing — read before wrapping a new method):
   * among the currently wrapped tools a 404 comes ONLY from the spaceId
   * membership / space-permissions check — their pageId / rootPageId /
   * parentPageId branches resolve to 403 or 200, NEVER 404. If a future change
   * adds a `NotFoundException` to `/pages/tree`, `/pages/recent`,
   * `/pages/sidebar-pages` or `/search` (e.g. "page not found"), this enrichment
   * would MISATTRIBUTE that 404 to the spaceId. Re-audit the wrapped call before
   * relying on this, and only wrap paths where the sole 404 cause is the space.
   */
  protected async withSpaceAccessDiagnostics<T>(
    spaceId: string,
    mcpName: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      // Abort/cap wins FIRST and is detected by the SIGNAL FLAG, not e.name: a
      // per-call cap may be an AbortSignal.timeout() (reason name "TimeoutError")
      // or a custom reason, so `e.name === 'AbortError'` is NOT reliable (#534
      // hole B). A stopped/capped turn must propagate its reason, never trigger a
      // /spaces sweep or a rewrite.
      if (this.toolAbortSignal?.aborted) throw e;

      // Only a 404 is enrichable; any other status/shape is a different failure.
      if (!(axios.isAxiosError(e) && e.response?.status === 404)) throw e;

      let idx: AccessibleSpaceIndex;
      try {
        idx = await this.getAccessibleSpaceIndex();
      } catch (fetchErr) {
        // The /spaces sweep itself failed. If we were aborted mid-sweep,
        // propagate the abort reason; otherwise FAIL OPEN with the ORIGINAL
        // server error rather than a misleading "not found".
        if (this.toolAbortSignal?.aborted) throw fetchErr;
        if (process.env.DEBUG) {
          console.error("space-diag: /spaces fetch failed:", fetchErr);
        }
        throw e;
      }

      // Fail open when the listing is incomplete (can't assert "missing") or when
      // the spaceId IS present (the 404 is about something else, not the space).
      if (!idx.complete) throw e;
      if (idx.ids.has(spaceId)) throw e;

      // Confident: the spaceId is well-formed but not among the accessible
      // spaces. Replace the opaque server text with the actionable fact.
      throw new Error(formatSpaceNotAccessible(mcpName, spaceId, idx.spaces));
    }
  }


  /**
   * Raw page info including the ProseMirror JSON content and slugId.
   *
   * With `format:"text"` (#502) the server instead renders `content` as a flat,
   * deterministic text string (its `jsonToText` path — the SAME serializer that
   * feeds search), so the MCP text read reuses the server's ONE serializer
   * rather than shipping a second one. Every other caller omits `format` and
   * gets the JSON content unchanged.
   */
  async getPageRaw(
    pageId: string,
    format?: "text",
    opts?: { includeContentHash?: boolean; preferLive?: boolean },
  ) {
    await this.ensureAuthenticated();
    const body: Record<string, unknown> = { pageId };
    if (format) body.format = format;
    // #654 — opt-in read-your-own-writes hint. The 4 structural read tools set
    // this (via shouldPreferLive) after their own recent write; the server then
    // serves the LIVE content (readLiveIfLoaded) instead of the debounce-stale DB
    // row. getPageRaw does NOT resolve or decide the hint (that would recurse
    // through resolvePageId -> getPageRaw) — it only forwards the flag.
    if (opts?.preferLive) body.preferLive = true;
    // #647 §E/§F — opt-in ONLY (getPage requests it). When set, the server
    // returns a `contentHash` computed coherently with the (live-when-loaded)
    // `content`, which getPage uses to key its conversion cache so a read right
    // after a write returns the fresh markdown (RYOW), not a stale cache entry
    // addressed by a debounce-lagging updatedAt.
    if (opts?.includeContentHash) body.includeContentHash = true;
    const response = await this.client.post("/pages/info", body);
    return response.data?.data ?? response.data;
  }

  /**
   * Resolve an agent-supplied pageId to the page's CANONICAL UUID (`page.id`),
   * so every collaboration document the MCP opens is named `page.<uuid>` — the
   * SAME name the web editor always uses (`page.${page.id}`).
   *
   * The agent commonly passes a 10-char public slugId (from URLs/listings) as
   * the pageId. The web editor opens the collab doc by UUID, but the MCP used to
   * pass that slugId straight into the collab doc name (`page.<slugId>`). For one
   * DB row that produced TWO independent Yjs documents whose debounced stores
   * clobbered each other — the agent's edit was silently lost (#260).
   *
   * A UUID input short-circuits with no network round-trip. A slugId is resolved
   * once via getPageRaw and cached (both slugId->uuid and uuid->uuid), so
   * repeated edits on the same page add no extra request.
   */
  protected async resolvePageId(pageId: string): Promise<PageId> {
    // This is the ONE canonicalization seam, so it is where the `PageId` brand
    // is minted (#435). The value is validated here — a UUID input by isUuid, a
    // resolved id as the server's own page.id — so the downstream write path
    // (withPageLock / mutatePageContent) can require the brand and reject any
    // unresolved raw id at compile time. The brand is a pure compile-time marker
    // applied by cast (no runtime guard): the guarantee is that this seam is the
    // only place a `PageId` is produced, so every branded value went through the
    // UUID/resolve check above.
    if (isUuid(pageId)) return pageId as PageId;
    const cached = this.pageIdCache.get(pageId);
    if (cached) return cached as PageId;
    const data = await this.getPageRaw(pageId);
    const uuid = data?.id;
    if (typeof uuid !== "string" || !uuid) {
      throw new Error(
        `Could not resolve a canonical page id for "${pageId}"`,
      );
    }
    this.pageIdCache.set(pageId, uuid);
    return uuid as PageId;
  }

  /**
   * #654 — record that the current client just committed a real change to a page,
   * opening its read-your-own-writes window. Called from every content-mutation
   * seam/site on a verify that reports an ACTUAL change (`changed===true`); a
   * no-op/aborted write (`changed:false`) is ignored so it never triggers a
   * needless owner probe. `pageUuid` is the resolved canonical UUID the write
   * locked on — the SAME key shouldPreferLive/readLiveIfLoaded use.
   *
   * Full-sweeps expired entries first (the map is tiny) so it cannot grow on a
   * long-lived stdio client, then arms P for RYOW_WINDOW_MS.
   */
  protected rememberWrite(pageUuid: string, verify: any): void {
    if (!verify || verify.changed !== true) return;
    const now = Date.now();
    for (const [key, expiresAt] of this.recentlyWritten) {
      if (expiresAt <= now) this.recentlyWritten.delete(key);
    }
    this.recentlyWritten.set(pageUuid, now + readRyowWindowMs());
  }

  /**
   * #654 — should a structural read of `pageId` set the `preferLive` hint? True
   * iff this client wrote to the page within its (unexpired) RYOW window.
   *
   * Cache-ONLY resolution (NO network, NO resolvePageId — that would recurse into
   * getPageRaw): a UUID input is its own key; a slugId is resolved via pageIdCache
   * (populated slug->uuid at write time). An unknown slug -> false (best-effort:
   * write-by-uuid then read-by-slug cannot match). An expired entry is swept
   * lazily here and counted as `expired` (a DISTINCT client counter, NOT a
   * db-row fallback — the hint was never sent).
   */
  protected shouldPreferLive(pageId: string): boolean {
    const uuid = isUuid(pageId) ? pageId : this.pageIdCache.get(pageId);
    if (!uuid) return false;
    const expiresAt = this.recentlyWritten.get(uuid);
    if (expiresAt === undefined) return false;
    if (Date.now() >= expiresAt) {
      this.recentlyWritten.delete(uuid);
      this.onMetricFn?.("mcp_ryow_expired_total", 1);
      return false;
    }
    return true;
  }

  /**
   * #654 — translate a `/pages/info` response's `contentSource`/`fallbackReason`
   * (present only when `preferLive` was sent) into RYOW metrics, and return the
   * compact `freshness` token surfaced in the 4 structural tools' RESULTS so the
   * model can see a degradation and re-read. `live` => the read got the live doc;
   * `stale-fallback` => it fell back to the (possibly stale) DB row. Returns
   * undefined when `preferLive` was not requested (no freshness field emitted).
   */
  protected ryowFreshness(
    preferLive: boolean,
    data: any,
  ): "live" | "stale-fallback" | undefined {
    if (!preferLive) return undefined;
    if (data?.contentSource === "live") {
      this.onMetricFn?.("mcp_ryow_live_total", 1);
      return "live";
    }
    // contentSource === 'db' (or missing on an older server) -> stale fallback.
    const reason =
      typeof data?.fallbackReason === "string"
        ? data.fallbackReason
        : "not_loaded";
    this.onMetricFn?.("mcp_ryow_dbrow_total", 1, { reason });
    return "stale-fallback";
  }


  /**
   * Page-locked write seam over collaboration.mutatePageContent. Production just
   * delegates; it exists as an overridable method so the insertFootnote wrapper
   * (transform abort-on-not-found + response shaping) can be unit-tested without
   * standing up a live Hocuspocus collab socket.
   *
   * SELF-RESOLVES the pageId to the canonical UUID (issue #449, "resolve-then-
   * lock"): every write must lock and key its CollabSession by the UUID, never a
   * raw slugId (#260). resolvePageId is cached/idempotent, so a caller that
   * already resolved pays no extra round-trip; centralizing it here means a
   * caller that reaches this seam with a raw slugId still locks correctly instead
   * of silently splitting the mutex key. withPageLock also asserts the key is a
   * UUID as a hard backstop.
   */
  protected async mutatePage(
    pageId: string,
    collabToken: string,
    apiUrl: string,
    transform: (doc: any) => any,
  ): Promise<{ doc?: any; verify?: any }> {
    const pageUuid = await this.resolvePageId(pageId);
    // #486: on a rejected collab-WS handshake, invalidate + refresh the token and
    // retry the write once (symmetric to the HTTP-401 reauth path).
    const result = await this.writeWithCollabAuthRetry(collabToken, (token) =>
      // #487: thread the in-app tool signal to mutatePageContent's pre-commit
      // safe-point so a Stop/cap during the connect/lock window skips the write.
      mutatePageContent(
        pageUuid,
        token,
        apiUrl,
        transform,
        this.toolAbortSignal ?? undefined,
      ),
    );
    // #654 — arm read-your-own-writes for this page (no-op when nothing changed).
    this.rememberWrite(pageUuid, result?.verify);
    return result;
  }

  /**
   * Full-document write seam over collaboration.replacePageContent. Production
   * just delegates; it exists as an overridable method so the full-doc write
   * tools (updatePageJson, copyPageContent) can have their footnote-
   * canonicalization binding unit-tested without a live Hocuspocus collab socket.
   *
   * SELF-RESOLVES the pageId to the canonical UUID (issue #449, "resolve-then-
   * lock") for the same reason as mutatePage above — the lock/CollabSession key
   * is guaranteed canonical here, not left to the caller's discipline.
   */
  protected async replacePage(
    pageId: string,
    doc: any,
    collabToken: string,
    apiUrl: string,
  ): Promise<{ doc?: any; verify?: any }> {
    const pageUuid = await this.resolvePageId(pageId);
    // #486: on a rejected collab-WS handshake, invalidate + refresh the token and
    // retry the write once (symmetric to the HTTP-401 reauth path).
    const result = await this.writeWithCollabAuthRetry(collabToken, (token) =>
      // #487: same pre-commit safe-point as mutatePage, for full-document writes.
      replacePageContent(
        pageUuid,
        doc,
        token,
        apiUrl,
        this.toolAbortSignal ?? undefined,
      ),
    );
    // #654 — arm read-your-own-writes for this page (no-op when nothing changed).
    this.rememberWrite(pageUuid, result?.verify);
    return result;
  }

  /**
   * #647 §D/§G/§H — server-side GUARDED full replace. POSTs the final document to
   * `/pages/update` as `operation:'replace'` + `baseHash`, so the authoritative
   * collab process applies it ONLY if the live page still hashes to `baseHash`
   * (compare-and-swap on the owner). This REPLACES the old client-collab write
   * seam (`replacePage` / `mutatePageContent`) for the two full-overwrite tools:
   * with the CAS on the server, the client no longer needs `withPageLock` or a
   * collab-WS session (both are gone from this path — the server CAS is the
   * concurrency control now).
   *
   * On HTTP 409 the server rejected the write (a concurrent edit landed); we
   * translate it to a typed {@link ConflictError} carrying the server's
   * `currentHash` so the caller can surface a "re-read and retry" message. Any
   * other error propagates unchanged.
   *
   * `content` is sent as-is (a ProseMirror JSON object for format:'json', a
   * markdown string for format:'markdown'); the server parses/canonicalizes it
   * through the SAME path as a normal update before the CAS.
   */
  protected async guardedReplacePage(
    pageId: string,
    content: unknown,
    format: "json" | "markdown",
    baseHash: string,
  ): Promise<{ applied: true; newHash?: string }> {
    const pageUuid = await this.resolvePageId(pageId);
    try {
      const response = await this.client.post("/pages/update", {
        pageId: pageUuid,
        content,
        operation: "replace",
        format,
        baseHash,
      });
      const data = response.data?.data ?? response.data;
      // The REST update returns the refreshed page; the CAS applied (a rejection
      // would have been a 409 thrown above). Surface the server hash if present.
      return { applied: true, newHash: data?.contentHash };
    } catch (e: any) {
      if (axios.isAxiosError(e) && e.response?.status === 409) {
        const body: any = e.response.data;
        const currentHash =
          body?.currentHash ?? body?.message?.currentHash ?? undefined;
        throw new ConflictError(
          `Page ${pageId} changed since it was read (baseHash ${baseHash} != ` +
            `current ${currentHash ?? "unknown"}). Re-read the page ` +
            `(getPageJson / getPage) to get a fresh baseHash, then retry.`,
          currentHash,
        );
      }
      throw e;
    }
  }

  /**
   * Export a page to a single self-contained Docmost-flavoured markdown file:
   * meta block + body (with inline comment anchors + diagrams) + comment
   * threads. Lossless round-trip target; see importPageMarkdown for the inverse.
   */
}
