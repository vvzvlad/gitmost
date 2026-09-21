import { HocuspocusProvider } from "@hocuspocus/provider";
import { TiptapTransformer } from "@hocuspocus/transformer";
import * as Y from "yjs";
import WebSocket from "ws";
import {
  buildCollabWsUrl,
  applyDocToFragment,
  MutationResult,
} from "./collaboration.js";
import { summarizeChange } from "./diff.js";

/**
 * Live per-page collaboration session cache (issue #400).
 *
 * The one-shot write path (collaboration.mutatePageContent /
 * client.mutateLiveContentUnlocked) used to open a NEW HocuspocusProvider, run
 * the full connect -> auth -> onLoadDocument -> initial-sync handshake, apply a
 * single edit, wait for persistence, and then `provider.destroy()` — for EVERY
 * content mutation. Disconnecting after every edit means that once the pause
 * between calls exceeds the server's write debounce, the server does a full
 * store -> unload -> reload per cell, causing 25s connect timeouts and
 * event-loop lag under a burst of edits on one page.
 *
 * This module keeps ONE live provider + ydoc per (wsUrl, pageId, token) alive
 * across a SERIES of edits. While the provider stays connected the server never
 * enters store -> unload -> reload, its debounce coalesces N writes into 1-2
 * stores, and the repeated auth/load/initial-sync disappears.
 *
 * The synchronous read -> transform -> write section and the per-edit
 * persistence-ack logic are preserved VERBATIM from the one-shot machine — the
 * only change is that they run on a persistent provider instead of a throwaway
 * one. See CollabSession.mutate.
 */

/** Time we wait for the initial handshake/sync before giving up. */
const CONNECT_TIMEOUT_MS = 25000;
/** Time we wait for the server to acknowledge our write before giving up. */
const PERSIST_TIMEOUT_MS = 20000;

/**
 * Marker property set on the Error thrown when the Hocuspocus handshake REJECTS
 * our collab token (onAuthenticationFailed). The client wraps content writes so
 * that on this specific failure it invalidates its cached collab token and
 * retries once with a fresh one — symmetric to the HTTP-401 reauth path (#486).
 * A plain message-match would be brittle; a tagged property is unambiguous and
 * survives teardown (which rejects pending ops with this SAME error object).
 */
const COLLAB_AUTH_FAILED_MARKER = "collabAuthFailed";

/** True when `e` is the tagged collab-WS auth-failure error (see marker above). */
export function isCollabAuthFailedError(e: unknown): boolean {
  return !!(
    e &&
    typeof e === "object" &&
    (e as Record<string, unknown>)[COLLAB_AUTH_FAILED_MARKER] === true
  );
}

/**
 * Marker set on the Error a still-in-flight mutate is rejected with when its
 * session is LRU-evicted while busy (#494). Unlike a plain destroy/failure, this
 * write is INDETERMINATE: the local update may already have been sent to (and
 * persisted by) the server before the eviction, so a blind retry risks a DUPLICATE
 * write (the #435 double-apply class). A tagged property (not a message match)
 * lets a caller distinguish "verify before retry" from a clean failure.
 */
const COLLAB_INDETERMINATE_MARKER = "collabIndeterminate";

/** True when `e` is the tagged "write may have applied — verify before retry"
 *  error raised when a busy session is LRU-evicted (see marker above). */
export function isCollabIndeterminateError(e: unknown): boolean {
  return !!(
    e &&
    typeof e === "object" &&
    (e as Record<string, unknown>)[COLLAB_INDETERMINATE_MARKER] === true
  );
}

/** Build the tagged INDETERMINATE error an in-flight mutate is rejected with when
 *  its session must be evicted while busy (#494). */
function makeCollabIndeterminateError(pageId: string): Error {
  const err = new Error(
    `Collaboration write INDETERMINATE (pageId ${pageId}): the live session was ` +
      `evicted under the LRU cap while this write was in flight, and its update ` +
      `MAY already have reached and persisted on the server. Do NOT blindly ` +
      `retry — re-read the page and verify whether the edit applied first (a ` +
      `blind retry risks a duplicate write).`,
  ) as Error & { [COLLAB_INDETERMINATE_MARKER]?: boolean };
  err[COLLAB_INDETERMINATE_MARKER] = true;
  return err;
}

/**
 * Tunables, read fresh from the environment on every acquire so tests (and a
 * live rollback) can change them without reloading the module. Mirrors how
 * http.ts parses MCP_SESSION_IDLE_MS.
 *   - MCP_COLLAB_SESSION_IDLE_MS: idle TTL, reset after every op. Default 60s.
 *     0 (or negative) DISABLES the cache — every op opens its own provider and
 *     destroys it after the op, i.e. the exact legacy per-op-provider behavior
 *     (the rollback path).
 *   - MCP_COLLAB_SESSION_MAX_AGE_MS: hard lifetime checked at acquire; bounds
 *     the permission-staleness window. Default 10 min.
 *   - MCP_COLLAB_SESSION_MAX_ENTRIES: registry cap; the least-recently-used
 *     session is destroy-evicted when the cap is reached. Default 32.
 */
interface SessionConfig {
  idleMs: number;
  maxAgeMs: number;
  maxEntries: number;
}

function parseEnvInt(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readConfig(): SessionConfig {
  // idleMs: allow 0 (disable). A malformed value falls back to the default.
  const idleRaw = parseInt(process.env.MCP_COLLAB_SESSION_IDLE_MS ?? "", 10);
  const idleMs = Number.isFinite(idleRaw) ? Math.max(0, idleRaw) : 60 * 1000;
  const maxAgeMs = Math.max(
    0,
    parseEnvInt(process.env.MCP_COLLAB_SESSION_MAX_AGE_MS, 10 * 60 * 1000),
  );
  const maxEntriesRaw = parseEnvInt(
    process.env.MCP_COLLAB_SESSION_MAX_ENTRIES,
    32,
  );
  const maxEntries = maxEntriesRaw > 0 ? maxEntriesRaw : 32;
  return { idleMs, maxAgeMs, maxEntries };
}

/**
 * The subset of HocuspocusProvider this module depends on, so the provider can
 * be replaced with a fake in unit tests (there is no server in the test env).
 */
export interface CollabProviderLike {
  synced: boolean;
  unsyncedChanges: number;
  destroy(): void;
  on(event: "unsyncedChanges", handler: (data: { number: number }) => void): void;
  on(event: "stateless", handler: (data: { payload: string }) => void): void;
  off(event: "unsyncedChanges", handler: (data: { number: number }) => void): void;
  off(event: "stateless", handler: (data: { payload: string }) => void): void;
  // Send a stateless (out-of-band, non-doc) message to the server. Used by the
  // #370 explicit save-version path (payload `{type:'save-version'}`); the server
  // replies with a broadcast `{type:'version.saved', …}` on the same channel.
  sendStateless(payload: string): void;
}

/** The configuration object passed to the provider factory. */
export interface CollabProviderConfig {
  url: string;
  name: string;
  document: Y.Doc;
  token: string;
  WebSocketPolyfill: unknown;
  onConnect: () => void;
  onSynced: () => void;
  onDisconnect: () => void;
  onClose: () => void;
  onAuthenticationFailed: () => void;
}

export type CollabProviderFactory = (
  config: CollabProviderConfig,
) => CollabProviderLike;

const defaultProviderFactory: CollabProviderFactory = (config) =>
  // @ts-ignore - WebSocketPolyfill is required for the Node.js environment.
  new HocuspocusProvider(config) as unknown as CollabProviderLike;

let providerFactory: CollabProviderFactory = defaultProviderFactory;

/**
 * TEST SEAM: swap the provider factory (pass null to restore the real one).
 * Not part of the public API — used only by the unit tests, which cannot reach
 * a real collaboration server.
 */
export function __setCollabProviderFactory(
  factory: CollabProviderFactory | null,
): void {
  providerFactory = factory ?? defaultProviderFactory;
}

/** Optional per-acquire hooks (metrics), passed through from the call site. */
export interface AcquireOptions {
  /** Invoked when the initial connect handshake times out (CONNECT_TIMEOUT_MS). */
  onConnectTimeout?: () => void;
}

type SessionState = "connecting" | "ready" | "dead";

/**
 * One live provider + ydoc for a single (wsUrl, pageId, token) triple.
 *
 * Lifecycle: connecting -> ready -> dead. A session becomes `dead` on the first
 * disconnect/close/auth-failure at ANY time, on an idle/eviction/max-age
 * teardown, or on an explicit destroy(); death is terminal and removes the
 * session from the registry so the next acquire opens a fresh one. We never use
 * the provider's auto-reconnect — destroying on the first disconnect closes the
 * "reconnect drove unsyncedChanges to 0 without retransmitting our write" class
 * of false success.
 */
export class CollabSession {
  readonly key: string;
  readonly pageId: string;
  readonly wsUrl: string;
  readonly token: string;
  readonly createdAt: number;
  state: SessionState = "connecting";
  /**
   * Set true on disconnect/close/auth-failure so a reconnect-driven
   * unsyncedChanges->0 cannot be mistaken for a successful persist of our
   * write (preserved verbatim from the one-shot machine).
   */
  connectionLost = false;

  provider: CollabProviderLike | undefined;
  private readonly ydoc: Y.Doc;
  private readonly cfg: SessionConfig;
  /**
   * Ephemeral sessions (cache disabled, MCP_COLLAB_SESSION_IDLE_MS<=0) are never
   * registered and self-destroy after their single op — the legacy
   * provider-per-op behavior.
   */
  private readonly ephemeral: boolean;
  private readonly opts: AcquireOptions | undefined;

  private dead = false;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private openPromise: Promise<void> | undefined;
  private openResolve: (() => void) | undefined;
  private openReject: ((err: Error) => void) | undefined;
  private openSettled = false;
  /**
   * The rejector of the CURRENT in-flight mutate, if any. A disconnect/close/
   * auth-failure or timeout at ANY time rejects the in-flight op through this
   * with the SAME error text the one-shot machine emitted.
   */
  private inflightReject: ((err: Error) => void) | undefined;

  constructor(
    key: string,
    pageId: string,
    wsUrl: string,
    token: string,
    cfg: SessionConfig,
    ephemeral: boolean,
    opts: AcquireOptions | undefined,
  ) {
    this.key = key;
    this.pageId = pageId;
    this.wsUrl = wsUrl;
    this.token = token;
    this.cfg = cfg;
    this.ephemeral = ephemeral;
    this.opts = opts;
    this.createdAt = Date.now();
    this.ydoc = new Y.Doc();
  }

  /**
   * Shared diagnostic suffix (issue #437) appended to the connect-timeout,
   * persist-timeout and connection-closed error texts: names the offending
   * pageId and tells the agent this class of failure is transient (retry once)
   * vs. a persistent collab-server outage, so it can self-correct instead of
   * blind-looping. The Yjs-encode error is deliberately NOT touched — it
   * already names the offending attribute.
   */
  private hint(): string {
    return (
      `(pageId ${this.pageId}; transient — retry once; persistent failures ` +
      `mean the collab server is unreachable/overloaded)`
    );
  }

  /**
   * A cached session may be reused only when it is fully ready, still synced,
   * has not lost its connection, and has not exceeded its max age (invariant 5
   * "validate on reuse" + the max-age acquire check).
   */
  isReusable(): boolean {
    return (
      !this.dead &&
      this.state === "ready" &&
      !this.connectionLost &&
      !!this.provider &&
      this.provider.synced === true &&
      Date.now() - this.createdAt < this.cfg.maxAgeMs
    );
  }

  /**
   * Connect and wait for the initial sync (onSynced) within CONNECT_TIMEOUT_MS.
   * Idempotent: repeated calls return the same in-flight/settled promise.
   */
  open(): Promise<void> {
    if (this.openPromise) return this.openPromise;
    this.openPromise = new Promise<void>((resolve, reject) => {
      this.openResolve = resolve;
      this.openReject = reject;

      this.connectTimer = setTimeout(() => {
        // The 25s connect timeout: the collab connection never became ready.
        this.opts?.onConnectTimeout?.();
        this.teardown(
          new Error(
            `Connection timeout to collaboration server ${this.hint()}`,
          ),
          false,
        );
      }, CONNECT_TIMEOUT_MS);

      if (process.env.DEBUG)
        console.error(`Connecting to WebSocket: ${this.wsUrl}`);

      this.provider = providerFactory({
        url: this.wsUrl,
        name: `page.${this.pageId}`,
        document: this.ydoc,
        token: this.token,
        WebSocketPolyfill: WebSocket,
        onConnect: () => {
          if (process.env.DEBUG) console.error("WS Connect");
        },
        // An unexpected disconnect/close at ANY time (during the connect-wait,
        // between edits, or during a persistence wait) makes the session dead:
        // surface it now instead of hanging, reject any in-flight op with the
        // same error text as the one-shot machine, and remove ourselves from
        // the registry so the next acquire opens fresh. `teardown` is idempotent
        // so the onClose our own destroy() triggers is a harmless no-op.
        onDisconnect: () => {
          if (process.env.DEBUG) console.error("WS Disconnect");
          this.teardown(
            new Error(
              `Collaboration connection closed before the update was persisted/synced ${this.hint()}`,
            ),
            true,
          );
        },
        onClose: () => {
          if (process.env.DEBUG) console.error("WS Close");
          this.teardown(
            new Error(
              `Collaboration connection closed before the update was persisted/synced ${this.hint()}`,
            ),
            true,
          );
        },
        onSynced: () => {
          if (this.dead || this.openSettled) return;
          if (process.env.DEBUG) console.error("Connected and synced!");
          if (this.connectTimer) {
            clearTimeout(this.connectTimer);
            this.connectTimer = undefined;
          }
          this.state = "ready";
          this.openSettled = true;
          this.openResolve?.();
        },
        onAuthenticationFailed: () => {
          // Tag the error so the client can tell a REJECTED collab token apart
          // from a generic disconnect and invalidate + refresh it (#486).
          const err = new Error(
            "Authentication failed for collaboration connection",
          ) as Error & { [COLLAB_AUTH_FAILED_MARKER]?: boolean };
          err[COLLAB_AUTH_FAILED_MARKER] = true;
          this.teardown(err, true);
        },
      });
    });
    return this.openPromise;
  }

  /**
   * Run one atomic read -> transform -> write against the LIVE doc and wait for
   * the server to acknowledge the write.
   *
   * INVARIANT 1 (read->write atomicity): between `TiptapTransformer.fromYdoc`
   * and `applyDocToFragment` there is NO `await`. Yjs applies remote updates
   * only when the event loop yields, so this synchronous block sees a consistent
   * live doc and no concurrent human edit can interleave and be clobbered —
   * exactly as in the one-shot onSynced code, just on a persistent provider.
   *
   * INVARIANT 2 (per-edit ack): after the write, resolve immediately if
   * unsyncedChanges is already 0, else wait for the unsyncedChanges->0 event
   * (PERSIST_TIMEOUT_MS), guarded by connectionLost so a reconnect handshake
   * cannot report a false success.
   *
   * CONCURRENCY: not safe to invoke concurrently on ONE session — the caller
   * MUST serialize (hold the per-page lock), mirroring acquireCollabSession.
   * The in-flight op is tracked in a single `inflightReject` field, so an
   * overlapping second call would clobber the first's rejector and leave it
   * hanging on disconnect. A fail-fast guard below rejects the overlap instead.
   * Sequential (awaited) mutates are fine: localFinish clears inflightReject
   * before the promise settles, so the guard is clear by the time the next runs.
   */
  mutate(
    transform: (liveDoc: any) => any | null,
  ): Promise<MutationResult> {
    // Belt-and-suspenders (acquire already validated): refuse to write on a
    // session that is not in a live, synced, ready state.
    if (
      this.dead ||
      this.state !== "ready" ||
      this.connectionLost ||
      !this.provider ||
      this.provider.synced !== true
    ) {
      return Promise.reject(
        new Error("Collaboration session is not in a ready state"),
      );
    }

    // Fail-fast on concurrent use: a second overlapping mutate would overwrite
    // the first's inflightReject, so a disconnect would only reject the second
    // and hang the first until PERSIST_TIMEOUT_MS. Reject the overlap WITHOUT
    // touching the in-flight op's state (no localFinish/teardown here).
    if (this.inflightReject) {
      return Promise.reject(
        new Error(
          "mutate already in-flight; caller must serialize (hold the page lock)",
        ),
      );
    }

    return new Promise<MutationResult>((resolve, reject) => {
      let settled = false;
      let persistTimer: ReturnType<typeof setTimeout> | undefined;
      let unsyncedHandler:
        | ((data: { number: number }) => void)
        | undefined;
      // The verifiable result resolved on every success/abort path. Set on
      // abort (no-op report) and after a real write (computed change report).
      let mutationResult: MutationResult;

      const localFinish = (err: Error | null, value?: MutationResult) => {
        if (settled) return;
        settled = true;
        if (persistTimer) clearTimeout(persistTimer);
        if (unsyncedHandler && this.provider) {
          try {
            this.provider.off("unsyncedChanges", unsyncedHandler);
          } catch (e) {}
        }
        this.inflightReject = undefined;
        if (err) reject(err);
        else resolve(value as MutationResult);
        // Post-settle lifecycle: an ephemeral (cache-disabled) session dies with
        // its single op; a cached session that is still alive re-arms its idle
        // TTL so the clock starts from the LAST op.
        if (this.ephemeral) {
          this.destroy("ephemeral op complete");
        } else if (!this.dead) {
          this.armIdle();
        }
      };

      // Register so a disconnect/close/auth-failure/teardown rejects THIS op
      // with the connection-loss error text. localFinish's `settled` guard makes
      // a racing teardown + normal resolve safe (first one wins).
      this.inflightReject = (e: Error) => localFinish(e);

      // Resolve once the server acknowledges our update: the provider increments
      // unsyncedChanges when the local update is sent and decrements it on the
      // server's SyncStatus(applied=true); reaching 0 means the authoritative
      // in-memory ydoc on the server now contains our write.
      const waitForPersistence = () => {
        if (settled) return;
        // A missing provider is a failure, not a success: without it the write
        // can never have been acknowledged.
        if (!this.provider) {
          localFinish(new Error("collab provider gone before persistence"));
          return;
        }
        if (this.provider.unsyncedChanges === 0) {
          localFinish(null, mutationResult);
          return;
        }
        persistTimer = setTimeout(() => {
          localFinish(
            new Error(
              `Timeout waiting for collaboration server to persist the update ${this.hint()}`,
            ),
          );
        }, PERSIST_TIMEOUT_MS);
        unsyncedHandler = (data: { number: number }) => {
          // Only treat unsyncedChanges->0 as success when the connection is
          // still up. A transient disconnect + reconnect handshake can drive the
          // counter back to 0 without our write being re-transmitted; in that
          // case let the disconnect/close error win instead.
          if (data.number === 0 && !this.connectionLost) {
            localFinish(null, mutationResult);
          }
        };
        this.provider.on("unsyncedChanges", unsyncedHandler);
      };

      // CRITICAL: everything between reading the live doc and writing it back
      // must stay synchronous (no await). While the JS event loop is not
      // yielded, no incoming remote update can interleave, so any already-synced
      // concurrent edits are preserved in liveDoc.
      //
      // INVARIANT 1 is machine-checked: the BEGIN/END markers below delimit the
      // no-await window, and test/unit/no-await-critical-window.test.mjs scans
      // this source and FAILS if any `await` (or `for await`/`yield`) appears
      // between them. Do NOT add an await inside this block — an accidental
      // async boundary here silently reopens the clobber-live-edits race (#152).
      let newDoc: any;
      let beforeDoc: any;
      try {
        // === MUTATE-CRITICAL-WINDOW: BEGIN (no await between here and END #449) ===
        let liveDoc = TiptapTransformer.fromYdoc(this.ydoc, "default");
        if (
          !liveDoc ||
          typeof liveDoc !== "object" ||
          !Array.isArray(liveDoc.content)
        ) {
          liveDoc = { type: "doc", content: [] };
        }

        // Snapshot the before-doc for the change report. Docs are
        // JSON-serializable, so this is a safe deep clone.
        beforeDoc = JSON.parse(JSON.stringify(liveDoc));

        newDoc = transform(liveDoc);

        if (newDoc == null) {
          // Transform aborted — write nothing, return the live doc with a no-op
          // change report.
          mutationResult = {
            doc: liveDoc,
            verify: {
              changed: false,
              textInserted: 0,
              textDeleted: 0,
              blocksChanged: 0,
              marks: {},
              summary: "no changes (transform aborted)",
            },
          };
          localFinish(null, mutationResult);
          return;
        }

        // Structural diff into the live fragment (issue #152): preserves the Yjs
        // ids of unchanged nodes, so an open editor's cursor is not yanked to the
        // end of the document on every agent write.
        applyDocToFragment(this.ydoc, newDoc);
        // === MUTATE-CRITICAL-WINDOW: END (#449) ===
      } catch (e) {
        // Includes errors thrown by transform (e.g. "afterText not found",
        // "text not found"): propagate them verbatim to the caller.
        localFinish(e instanceof Error ? e : new Error(String(e)));
        return;
      }

      // Compute the verifiable change report AFTER the transact write: it only
      // needs the JSON before/after, so it cannot affect the atomic read->write
      // window, and summarizeChange never throws.
      mutationResult = {
        doc: newDoc,
        verify: summarizeChange(beforeDoc, newDoc),
      };
      if (process.env.DEBUG)
        console.error("Content written, waiting for server to persist...");
      waitForPersistence();
    });
  }

  /**
   * Send a stateless message over the live collaboration connection and resolve
   * with the FIRST reply whose parsed payload satisfies `predicate`, rejecting on
   * a bounded `timeoutMs`.
   *
   * Used by the #370 explicit save-version path: the client sends
   * `{type:'save-version'}` and awaits the server's broadcast
   * `{type:'version.saved', historyId, kind, alreadySaved}`. The stateless channel
   * (not a REST read) is deliberate — the server versions the LIVE in-memory ydoc,
   * which the up-to-10s-stale page row would not yet reflect.
   *
   * `predicate` receives each incoming stateless message (already JSON-parsed) and
   * returns the resolved value for a match or `undefined` to keep waiting; a
   * malformed / unrelated payload is ignored. The listener is registered BEFORE
   * the send so a fast reply is never missed.
   *
   * Lifecycle mirrors mutate(): it registers through `inflightReject` so a
   * disconnect/close/auth-failure/teardown rejects THIS wait with the same
   * connection-loss error, refuses to run on a non-ready session, fails fast on a
   * concurrent in-flight op (the caller MUST hold the per-page lock), and re-arms
   * the idle TTL (or self-destroys an ephemeral session) on completion.
   *
   * NOTE: the server broadcast carries no request-correlation id, so under a
   * genuinely concurrent save on the SAME page (e.g. a human Cmd+S racing the
   * agent) this resolves on whichever `version.saved` arrives first. The per-page
   * lock serializes THIS process's saves; a cross-client race is inherent to the
   * broadcast design and is benign (the result still describes a real save of this
   * page's current content, and the server's save is promote-not-duplicate).
   */
  sendStatelessAndAwait<T>(
    payload: string,
    predicate: (message: any) => T | undefined,
    timeoutMs: number,
  ): Promise<T> {
    // Belt-and-suspenders (acquire already validated): refuse to send on a
    // session that is not in a live, synced, ready state.
    if (
      this.dead ||
      this.state !== "ready" ||
      this.connectionLost ||
      !this.provider ||
      this.provider.synced !== true
    ) {
      return Promise.reject(
        new Error("Collaboration session is not in a ready state"),
      );
    }

    // Fail-fast on concurrent use: a second overlapping op would overwrite the
    // first's inflightReject and hang it on disconnect (same guard as mutate).
    if (this.inflightReject) {
      return Promise.reject(
        new Error(
          "stateless op already in-flight; caller must serialize (hold the page lock)",
        ),
      );
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let statelessHandler: ((data: { payload: string }) => void) | undefined;

      const localFinish = (err: Error | null, value?: T) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (statelessHandler && this.provider) {
          try {
            this.provider.off("stateless", statelessHandler);
          } catch (e) {}
        }
        this.inflightReject = undefined;
        if (err) reject(err);
        else resolve(value as T);
        // Post-settle lifecycle, identical to mutate's localFinish.
        if (this.ephemeral) {
          this.destroy("ephemeral op complete");
        } else if (!this.dead) {
          this.armIdle();
        }
      };

      // Register so a disconnect/close/auth-failure/teardown rejects THIS op with
      // the connection-loss error text (the `settled` guard makes a racing
      // teardown + normal resolve safe — first one wins).
      this.inflightReject = (e: Error) => localFinish(e);

      // Register the reply listener BEFORE sending so a fast server broadcast is
      // never missed.
      statelessHandler = (data: { payload: string }) => {
        if (settled) return;
        let message: any;
        try {
          message = JSON.parse(data.payload);
        } catch {
          return; // unrelated / malformed stateless message — keep waiting
        }
        const matched = predicate(message);
        if (matched !== undefined) localFinish(null, matched);
      };
      this.provider!.on("stateless", statelessHandler);

      timer = setTimeout(() => {
        localFinish(
          new Error(
            `Timeout waiting for a stateless reply from the collaboration server ${this.hint()}`,
          ),
        );
      }, timeoutMs);

      try {
        this.provider!.sendStateless(payload);
      } catch (e) {
        localFinish(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** (Re)arm the idle TTL so the clock starts from the most recent activity. */
  armIdle(): void {
    if (this.dead || this.ephemeral) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.cfg.idleMs > 0) {
      this.idleTimer = setTimeout(() => {
        this.destroy("idle timeout");
      }, this.cfg.idleMs);
      // Never let the idle timer keep the process alive.
      (this.idleTimer as any).unref?.();
    }
  }

  /**
   * Idempotent teardown: mark dead, clear timers, remove from the registry, fail
   * any pending open/in-flight op, and destroy the provider. `inflightError` is
   * the error a pending open or in-flight op is rejected with; `connectionLoss`
   * marks the session as connection-lost so the ack guard cannot report a false
   * success on a racing unsyncedChanges->0.
   */
  private teardown(inflightError: Error | null, connectionLoss: boolean): void {
    if (this.dead) return;
    this.dead = true;
    this.state = "dead";
    if (connectionLoss) this.connectionLost = true;

    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }

    // Remove ourselves from the registry (only if we are still the live entry —
    // a re-open under the same key must not be evicted by our teardown).
    if (sessions.get(this.key) === this) {
      sessions.delete(this.key);
    }

    // Fail a pending open() and any in-flight mutate with the terminal error.
    if (!this.openSettled) {
      this.openSettled = true;
      this.openReject?.(
        inflightError ?? new Error("Collaboration session destroyed"),
      );
    }
    if (this.inflightReject) {
      const rej = this.inflightReject;
      this.inflightReject = undefined;
      rej(inflightError ?? new Error("Collaboration session destroyed"));
    }

    if (this.provider) {
      try {
        this.provider.destroy();
      } catch (e) {}
      this.provider = undefined;
    }
  }

  /**
   * True while a mutate is in flight (an update may already be on the wire /
   * persisted server-side). The LRU-eviction path (#494) uses this to AVOID
   * evicting a session mid-write when an idle victim exists, and to tag the error
   * as INDETERMINATE when evicting a busy one is unavoidable.
   */
  isBusy(): boolean {
    return !this.dead && this.inflightReject !== undefined;
  }

  /**
   * Evict this session for the LRU cap (#494). When a mutate is IN FLIGHT its
   * update may already have reached the server, so rejecting it as a plain
   * failure would make a retry-prone agent re-issue the write and DUPLICATE it
   * (the #435 class). Reject the in-flight op with the tagged INDETERMINATE error
   * (verify-before-retry) instead. When idle, this is an ordinary destroy.
   */
  evictForCap(): void {
    if (this.dead) return;
    if (this.isBusy()) {
      if (process.env.DEBUG)
        console.error(
          `Evicting BUSY collab session ${this.pageId} (LRU cap) — in-flight write is INDETERMINATE`,
        );
      this.teardown(makeCollabIndeterminateError(this.pageId), false);
    } else {
      this.destroy("evicted (LRU cap)");
    }
  }

  /**
   * Public idempotent teardown used by the acquire/eviction paths and by a
   * caller that wants the session dropped after a failed op ("next call
   * reconnects fresh").
   */
  destroy(reason: string): void {
    if (this.dead) return;
    if (process.env.DEBUG)
      console.error(`Destroying collab session ${this.pageId}: ${reason}`);
    this.teardown(new Error(`Collaboration session destroyed: ${reason}`), false);
  }
}

/** key = wsUrl + pageId + collabToken (identity isolation: invariant 4). */
const sessions = new Map<string, CollabSession>();

function sessionKey(wsUrl: string, pageId: string, token: string): string {
  // The token is part of the key so sessions are NEVER shared between different
  // users' MCP sessions (HTTP mode), and a token rotation makes a new entry
  // while the old one idles out.
  return `${wsUrl} ${pageId} ${token}`;
}

/**
 * Get a live, synced CollabSession for a page, reusing a cached one when it is
 * still valid or opening a fresh one otherwise. Does NOT take the per-page lock
 * — the caller MUST already hold it (both call sites run inside withPageLock,
 * which is not reentrant, so acquiring the lock here would deadlock
 * mutateLiveContentUnlocked).
 */
export async function acquireCollabSession(
  pageId: string,
  collabToken: string,
  baseUrl: string,
  opts?: AcquireOptions,
): Promise<CollabSession> {
  const cfg = readConfig();
  const wsUrl = buildCollabWsUrl(baseUrl);

  // Cache disabled (rollback path): open an unregistered ephemeral session that
  // self-destroys after its single op — the exact legacy per-op-provider flow.
  if (cfg.idleMs <= 0) {
    const session = new CollabSession(
      sessionKey(wsUrl, pageId, collabToken),
      pageId,
      wsUrl,
      collabToken,
      cfg,
      true,
      opts,
    );
    await session.open();
    return session;
  }

  const key = sessionKey(wsUrl, pageId, collabToken);
  const existing = sessions.get(key);
  if (existing) {
    if (existing.isReusable()) {
      // Reuse. Refresh LRU order (re-insert = most recently used) and re-arm the
      // idle TTL so the reuse counts as activity.
      sessions.delete(key);
      sessions.set(key, existing);
      existing.armIdle();
      if (process.env.DEBUG)
        console.error(`Reusing collab session for page ${pageId}`);
      return existing;
    }
    // Stale (not synced / past max age / lost): drop it and open fresh.
    existing.destroy("stale on reuse");
  }

  // Enforce the registry cap before inserting: evict least-recently-used entries
  // until there is room. PREFER an IDLE victim (#494): a session with an in-flight
  // mutate may have already sent (and persisted) its update, so evicting it would
  // reject that write as a FALSE failure → a retry-prone agent re-issues it →
  // DUPLICATE write (the #435 class). So walk LRU order and skip non-idle sessions,
  // evicting the oldest IDLE one. Only when EVERY cached session is non-idle (eviction
  // unavoidable to admit this write) do we evict the LRU non-idle one — via
  // evictForCap(), which rejects an in-flight op with a tagged INDETERMINATE
  // "verify before retry" error rather than a plain failure.
  //
  // "Non-idle" = busy OR still opening. `sessions.set(key)` below runs BEFORE the
  // `await session.open()` that resolves it, so a `connecting` session is in the
  // map while its handshake is still in flight. Such a session is NOT busy yet
  // (isBusy() needs an in-flight mutate), but it is ALSO not a legitimate idle
  // victim: in multi-user HTTP two acquires for DIFFERENT pages interleave across
  // that await, and under saturation the second acquire would otherwise pick the
  // first's freshly-inserted `connecting` session as an "idle" victim and destroy
  // it, rejecting the first's pending open() as "evicted (LRU cap)" — a spurious
  // failure of a write that never even started. So exclude `state !== "ready"`
  // from the idle scan; a connecting session falls into the last-resort bucket and
  // is evicted ONLY when every other entry is busy-or-connecting too.
  while (sessions.size >= cfg.maxEntries) {
    let idleKey: string | undefined;
    let oldestBusyKey: string | undefined;
    for (const [k, s] of sessions) {
      if (s.isBusy() || s.state !== "ready") {
        if (oldestBusyKey === undefined) oldestBusyKey = k;
        continue;
      }
      idleKey = k; // first (LRU) genuinely-idle session
      break;
    }
    const victimKey = idleKey ?? oldestBusyKey;
    if (victimKey === undefined) break; // registry empty (shouldn't happen)
    // evictForCap() picks the plain-destroy vs INDETERMINATE-reject path itself
    // based on whether the victim is busy.
    sessions.get(victimKey)?.evictForCap();
    // teardown removes it from the map; guard against a no-op.
    if (sessions.has(victimKey)) sessions.delete(victimKey);
  }

  const session = new CollabSession(
    key,
    pageId,
    wsUrl,
    collabToken,
    cfg,
    false,
    opts,
  );
  sessions.set(key, session);
  try {
    await session.open();
  } catch (e) {
    // Failed connect/sync: make sure it is not left cached.
    session.destroy("open failed");
    throw e;
  }
  session.armIdle();
  if (process.env.DEBUG)
    console.error(`Opened new collab session for page ${pageId}`);
  return session;
}

/**
 * Destroy every cached session. Wired into the process shutdown so a hanging
 * session does not keep a doc loaded on the server past exit.
 */
export function destroyAllSessions(): void {
  for (const session of [...sessions.values()]) {
    session.destroy("process shutdown");
  }
  sessions.clear();
}

/** TEST-ONLY: number of currently cached sessions. */
export function __sessionCountForTests(): number {
  return sessions.size;
}
