import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
  onCloseParameters,
  onStatelessParameters,
  onSyncedParameters,
} from "@hocuspocus/provider";
import { notifications } from "@mantine/notifications";
import i18n from "i18next";
import { jwtDecode } from "jwt-decode";
import { queryClient } from "@/main.tsx";
import { getCollabToken } from "@/features/auth/services/auth-service";
import { ICollabToken } from "@/features/auth/types/auth.types";
import { IPage } from "@/features/page/types/page.types.ts";
import {
  VERSION_SAVED_MESSAGE_TYPE,
  type VersionSavedMessage,
  saveVersionPending,
} from "@/features/page-history/version-messages";
import { isYdocBodyNonEmpty } from "@/features/editor/local-first-body";
import {
  pageYdocDbName,
  pageYdocRoomName,
  registerPageSessionDestroyHooks,
  registerPageYdoc,
  rememberYdocDbName,
  unregisterPageYdoc,
} from "@/features/editor/page-ydoc-eviction";
import { canOpenLocalYdoc } from "@/features/editor/page-ydoc-tombstones";
import { markReconciled } from "@/features/editor/page-ydoc-reconciled";
import { isSessionExpired } from "@/features/user/session-verified";
import { FIVE_MINUTES } from "@/lib/constants.ts";

/**
 * #709 — warm collab sessions: ONE cache per tab, the sole owner of every
 * page's collab session (ydoc, local persistence, own socket, provider). The
 * page editor takes a session on mount and hands it back on unmount; a handed
 * back session is PARKED — kept connected in the background, receiving remote
 * edits — so returning to a recently opened page binds the live editor to an
 * already synced and confirmed doc, editable together with the text.
 *
 * Only a WARM session (parked, synced and authorized read-write on its CURRENT
 * connection) is ever handed out again; any other parked session is destroyed
 * when its page is opened, and the page opens cold, as before. Each session has
 * its OWN socket: hocuspocus remembers a failed document auth for the lifetime
 * of a connection and a socket's message queue survives a disconnect, so with a
 * shared socket one failure would break every page of the tab.
 */

// #707 — the longest the remote provider waits for the local ydoc's "synced"
// before attaching to the socket without it.
const LOCAL_ATTACH_DEADLINE_MS = 1000;

// "5 pages, up to ~50 MB" (owner's choice): at most five PARKED sessions — the
// active one is not counted (it is held today as well).
export const MAX_PARKED_SESSIONS = 5;
// ~50 MB of heap at the measured heap / encoded-update ratio of 6.47:
// 7.5 × 6.47 ≈ 48.5 MiB.
export const MAX_PARKED_ENCODED_BYTES = 7.5 * 1024 * 1024;
// "5 minutes after leaving" (owner's choice) — as long as the page query itself
// stays in the query cache without observers.
export const PARKED_TTL_MS = FIVE_MINUTES;

export interface PageSession {
  dbName: string;
  pageId: string;
  slugId: string | undefined;
  ydoc: Y.Doc;
  // #640 — remote-only when the page is tombstoned / scope unresolved / session
  // expired: the local persistence is then not constructed at all.
  local: IndexeddbPersistence | null;
  socket: HocuspocusProviderWebsocket;
  remote: HocuspocusProvider;
  localSynced: boolean;
  // #564 — the local ydoc actually holds body content (y-indexeddb emits
  // "synced" for an EMPTY doc too, so the event alone proves nothing).
  ydocNonEmpty: boolean;
  alive: boolean;
  holder: "active" | "parked";
  encodedBytes: number;
  parkTimer: ReturnType<typeof setTimeout> | undefined;
  attachDeadline: ReturnType<typeof setTimeout> | undefined;
  /** Listeners are called SYNCHRONOUSLY from the session's handlers. */
  subscribe(listener: () => void): () => void;
}

// Keyed by the scoped DB name (the user scope is part of the key). Insertion
// order is the LRU order: a session is re-inserted at the tail when parked.
const sessions = new Map<string, PageSession>();

function isWarm(s: PageSession): boolean {
  return (
    s.alive &&
    s.holder === "parked" &&
    s.remote.isSynced &&
    s.remote.isAuthenticated &&
    s.remote.authorizedScope === "read-write"
  );
}

// A missing or unparseable token, or one without a numeric `exp`, counts as
// expired (`Date.now()/1000 >= undefined` is `false`, which would otherwise
// treat it as valid).
function collabTokenExpired(token: string | undefined): boolean {
  if (!token) return true;
  try {
    const exp = jwtDecode<{ exp?: number }>(token).exp;
    return typeof exp !== "number" || Date.now() / 1000 >= exp;
  } catch {
    return true;
  }
}

// Parallel calls share one request.
function fetchCollabToken(): Promise<ICollabToken> {
  return queryClient.fetchQuery({
    queryKey: ["collab-token"],
    queryFn: getCollabToken,
    staleTime: 0,
  });
}

/** A warm session for this DB name, or null. Pure read — called in render. */
export function peekWarmSession(dbName: string): PageSession | null {
  const s = sessions.get(dbName);
  return s && isWarm(s) ? s : null;
}

export function acquirePageSession(opts: {
  dbName: string;
  pageId: string;
  slugId: string | undefined;
  scopeKey: string;
  collaborationURL: string;
}): PageSession {
  const existing = sessions.get(opts.dbName);
  if (existing) {
    if (existing.holder === "active") {
      // Not expected: the page editor is the single mount point.
      console.error(
        "[page-session-cache] acquire of an already active session",
        {
          pageId: opts.pageId,
        },
      );
      return existing;
    }
    if (isWarm(existing)) {
      existing.holder = "active";
      clearTimeout(existing.parkTimer);
      existing.parkTimer = undefined;
      // The server checks permissions only when it authorizes the document and
      // a warm session does not reconnect, so ask it to re-check them on the
      // open connection (onTokenSync). A refusal closes the document with
      // "Unauthorized" — see the close handler in createSession.
      void existing.remote.sendToken();
      return existing;
    }
    destroySession(existing);
  }
  return createSession(opts);
}

export function releasePageSession(session: PageSession): void {
  if (!session.alive) return;
  // Read-only sessions are not parked. Before the auth answer the scope is
  // still undefined: such a session is parked and finishes loading in the
  // background.
  if (session.remote.authorizedScope === "readonly") {
    destroySession(session);
    return;
  }
  session.holder = "parked";
  sessions.delete(session.dbName);
  sessions.set(session.dbName, session);
  session.encodedBytes = Y.encodeStateAsUpdate(session.ydoc).byteLength;
  session.parkTimer = setTimeout(() => destroySession(session), PARKED_TTL_MS);
  // Never evict synchronously here: the leaving page's cleanup and the next
  // page's effects run in the same passive flush, and the next page must get
  // the chance to take its session first.
  queueMicrotask(enforceParkedBudget);
}

export function destroyPageSession(dbName: string): void {
  const s = sessions.get(dbName);
  if (s) destroySession(s);
}

export function destroyAllPageSessions(): void {
  for (const s of [...sessions.values()]) destroySession(s);
}

// Evict the longest-parked sessions until both limits hold. Active sessions
// are never counted and never evicted.
function enforceParkedBudget(): void {
  const parked = [...sessions.values()].filter((s) => s.holder === "parked");
  let count = parked.length;
  let bytes = parked.reduce((sum, s) => sum + s.encodedBytes, 0);
  for (const s of parked) {
    if (count <= MAX_PARKED_SESSIONS && bytes <= MAX_PARKED_ENCODED_BYTES) {
      break;
    }
    count -= 1;
    bytes -= s.encodedBytes;
    destroySession(s);
  }
}

// A failed construction step is logged with the page and the step, then
// rethrown to the caller.
function createStep<T>(pageId: string, step: string, run: () => T): T {
  try {
    return run();
  } catch (err) {
    console.error("[page-session-cache] session create step failed", {
      pageId,
      step,
      err,
    });
    throw err;
  }
}

function destroySession(session: PageSession): void {
  session.alive = false;
  clearTimeout(session.parkTimer);
  clearTimeout(session.attachDeadline);
  const steps: [string, () => void][] = [
    ["socket.destroy", () => session.socket.destroy()],
    ["remote.destroy", () => session.remote.destroy()],
    ["local.destroy", () => session.local?.destroy()],
    ["unregisterPageYdoc", () => unregisterPageYdoc(session.dbName)],
  ];
  try {
    for (const [step, run] of steps) {
      try {
        run();
      } catch (err) {
        console.error("[page-session-cache] session destroy step failed", {
          pageId: session.pageId,
          step,
          err,
        });
      }
    }
  } finally {
    if (sessions.get(session.dbName) === session) {
      sessions.delete(session.dbName);
    }
  }
}

function createSession({
  dbName,
  pageId,
  slugId,
  scopeKey,
  collaborationURL,
}: {
  dbName: string;
  pageId: string;
  slugId: string | undefined;
  scopeKey: string;
  collaborationURL: string;
}): PageSession {
  // #640, invariant 1 — the DB name is SCOPE-NAMESPACED, the collab ROOM name
  // is NOT. The room name must stay `page.<pageId>` or the server resolves the
  // wrong id and every collab connection breaks (see page-ydoc-eviction).
  const roomName = pageYdocRoomName(pageId);
  // #640 — open LOCAL persistence only when it is safe to lean on local
  // content. Fail-closed on all three:
  //  - anon scope (not yet resolved): a signed-out/first-frame state must not
  //    write a body under `anon:anon` (invariant 2);
  //  - session expired past OFFLINE_GRACE (30d, part 6): refuse local body;
  //  - the page is TOMBSTONED (access revoked, part 5): y-indexeddb creates
  //    the DB on construction, so gating here — not at paint — is what keeps a
  //    revoked page from resurrecting an (empty) database every visit. Checked
  //    under BOTH aliases so a slugId-only tombstone still blocks.
  const scopeResolved = !scopeKey.split(":").includes("anon");
  const openLocal =
    scopeResolved &&
    !isSessionExpired() &&
    canOpenLocalYdoc(dbName) &&
    canOpenLocalYdoc(pageYdocDbName(scopeKey, slugId ?? pageId));
  const ydoc = new Y.Doc();
  const local = openLocal
    ? createStep(
        pageId,
        "IndexeddbPersistence",
        () => new IndexeddbPersistence(dbName, ydoc),
      )
    : null;
  if (openLocal) {
    // Record the scoped DB name so the cross-user purge can delete it by name
    // on browsers without `indexedDB.databases()` (Firefox). Only when a DB is
    // actually created — a remote-only ydoc leaves nothing on disk.
    rememberYdocDbName(dbName);
  }

  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());

  // #707 — status is subscribed on the SOCKET, not the provider: the provider
  // only wires its own onStatus inside attach(), so socket status events that
  // land before the (deferred) attach would otherwise be lost. Here it only
  // notifies the session's subscribers: `yjsConnectionStatusAtom` is written by
  // the page editor from the session it is bound to, so a parked socket never
  // touches the global atom.
  const socket = createStep(
    pageId,
    "HocuspocusProviderWebsocket",
    () =>
      new HocuspocusProviderWebsocket({
        url: collaborationURL,
        onStatus: notify,
      }),
  );

  // The deadline callback and attach check `alive`: a destroyed session must
  // never attach its provider again.
  const attach = () => {
    if (!session.alive) return;
    remote.attach();
  };

  const onLocalSyncedHandler = () => {
    session.localSynced = true;
    // y-indexeddb emits "synced" even when the stored doc is EMPTY, so probe
    // the actual body fragment: an empty ydoc must NOT trigger the early swap
    // (it would blank the body until the network answers — guard 1).
    session.ydocNonEmpty = isYdocBodyNonEmpty(ydoc);
    // #707 — attach only now, so step1 carries the local copy's state vector
    // and the server answers with the diff instead of the whole document.
    clearTimeout(session.attachDeadline);
    attach();
    notify();
  };

  const onSyncedHandler = (event: onSyncedParameters) => {
    if (event.state) {
      // #640 R1 — durable "this ydoc reconciled with the server at least
      // once" mark, keyed by the scoped DB name. Ф7 (offline editing) reads
      // THIS instead of the session-scoped isRemoteConfirmed. See
      // page-ydoc-reconciled for the forward-compat purge/quarantine rule.
      markReconciled(dbName);
      // A parked session that finished loading in the background has grown:
      // re-measure it and re-apply the budget.
      if (session.holder === "parked") {
        session.encodedBytes = Y.encodeStateAsUpdate(ydoc).byteLength;
        queueMicrotask(enforceParkedBudget);
      }
    }
    // #564, guard 2 — THIS event IS the remote confirmation, and the page
    // editor's Yjs write guard must open SYNCHRONOUSLY inside this very emit:
    // extensions dispatch from `provider.on("synced")` (UniqueID's `createIds`
    // runs in this emit and dispatches once). This handler is the provider's
    // FIRST "synced" listener (a configuration callback), and subscribers are
    // notified synchronously, so the bound editor re-reads `remote.isSynced`
    // before any extension's listener runs.
    notify();
  };

  const onStatelessHandler = ({ payload }: onStatelessParameters) => {
    try {
      const message = JSON.parse(payload);
      // #370 — a version was saved somewhere; live-refresh the history panel
      // on every client. Only the client that pressed Save (tracked by the
      // module-level flag) shows the confirmation toast — and only from the
      // session of the page on screen.
      if (message?.type === VERSION_SAVED_MESSAGE_TYPE) {
        const versionMsg = message as VersionSavedMessage;
        queryClient.invalidateQueries({
          queryKey: ["page-history-list"],
        });
        if (session.holder === "active" && saveVersionPending.current) {
          saveVersionPending.current = false;
          notifications.show({
            message: versionMsg.alreadySaved
              ? i18n.t("Already saved as the latest version")
              : i18n.t("Version saved"),
          });
        }
        return;
      }
      if (message?.type !== "page.updated" || !message.updatedAt) return;
      const pageData = queryClient.getQueryData<IPage>(["pages", slugId]);
      if (pageData) {
        queryClient.setQueryData(["pages", slugId], {
          ...pageData,
          updatedAt: message.updatedAt,
          ...(message.lastUpdatedBy && {
            lastUpdatedBy: message.lastUpdatedBy,
          }),
        });
      }
    } catch {
      // ignore unrelated stateless messages
    }
  };

  const onAuthenticationFailedHandler = () => {
    // Late auth failure after teardown: the socket is already destroyed, so
    // reconnecting it would resurrect a dead provider.
    if (!session.alive) return;
    // A missing, unparseable or expired token triggers a refresh, so the
    // editor reconnects even when the initial token fetch failed.
    const token = queryClient.getQueryData<ICollabToken>([
      "collab-token",
    ])?.token;
    if (!collabTokenExpired(token)) return;
    fetchCollabToken()
      .then((result) => {
        if (!session.alive || !result?.token) return;
        socket.disconnect();
        setTimeout(() => {
          if (!session.alive) return;
          // The lazy token callback reads the fresh token fetchQuery just cached.
          socket.connect();
        }, 100);
      })
      .catch((err) => {
        console.error("[page-session-cache] collab token refresh failed", {
          pageId,
          err,
        });
      });
  };

  const onCloseHandler = ({ event }: onCloseParameters) => {
    // The provider reset `isSynced` / `isAuthenticated`; let the bound editor
    // re-read them.
    notify();
    // A server CLOSE message carries only the reason string — the provider
    // fills in code 1000 — while a socket closed by the server arrives with
    // its real code. So this is the server refusing the document on THIS
    // connection: the re-check of permissions on a warm return (onTokenSync)
    // found access revoked or downgraded.
    if (event?.code !== 1000 || event?.reason !== "Unauthorized") return;
    console.warn(
      "[page-session-cache] the server closed the page's collab document as Unauthorized",
      { pageId },
    );
    // Refetch the page: a 403/404 evicts it (and destroys this session), a
    // 200 with canEdit=false makes the body read-only. The active session is
    // not recreated — its socket, receiving no messages, reconnects by itself
    // (~30 s) and the server authorizes the document with the new rights.
    queryClient.invalidateQueries({ queryKey: ["pages", pageId] });
    queryClient.invalidateQueries({ queryKey: ["pages", slugId] });
    if (session.holder === "parked") destroySession(session);
  };

  const remote = createStep(
    pageId,
    "HocuspocusProvider",
    () =>
      new HocuspocusProvider({
        websocketProvider: socket,
        // #640, invariant 1 — the un-namespaced ROOM name (`page.<pageId>`),
        // never the scoped DB name, so the server resolves the pageId via
        // split('.')[1] and every authenticated collab connection succeeds
        // (#626 regression fix).
        name: roomName,
        document: ydoc,
        // Ф7 (#643) — a LAZY token callback, not a by-value token. Hocuspocus
        // accepts a (possibly async) function and awaits it before
        // authenticating. At t0 the collab-token query may not have resolved
        // yet; passing an empty token by value makes the server reject the
        // socket → onAuthenticationFailed → a 100ms reconnect. The callback
        // instead WAITS for a token, and never hands out an expired one: the
        // first warm return after the token expired (24 h) would otherwise
        // turn the permission re-check into a false "revoked".
        token: async () => {
          const token = queryClient.getQueryData<ICollabToken>([
            "collab-token",
          ])?.token;
          if (!collabTokenExpired(token)) return token;
          return (await fetchCollabToken())?.token;
        },
        onAuthenticationFailed: onAuthenticationFailedHandler,
        onSynced: onSyncedHandler,
        onStateless: onStatelessHandler,
        onClose: onCloseHandler,
      }),
  );

  const session: PageSession = {
    dbName,
    pageId,
    slugId,
    ydoc,
    local,
    socket,
    remote,
    localSynced: false,
    ydocNonEmpty: false,
    alive: true,
    holder: "active",
    encodedBytes: 0,
    parkTimer: undefined,
    attachDeadline: undefined,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  if (local) {
    local.on("synced", onLocalSyncedHandler);
    // #707 — a hung or failed IndexedDB never emits "synced", so the attach
    // waits at most LOCAL_ATTACH_DEADLINE_MS; past it the local copy counts
    // as empty and we attach as before (full exchange).
    const localOpenedAt = Date.now();
    session.attachDeadline = setTimeout(() => {
      if (!session.alive) return;
      console.error(
        `[page-session-cache] local ydoc did not sync within ${LOCAL_ATTACH_DEADLINE_MS}ms; attaching without it`,
        { pageId, elapsedMs: Date.now() - localOpenedAt },
      );
      session.localSynced = true;
      session.ydocNonEmpty = false;
      attach();
      notify();
    }, LOCAL_ATTACH_DEADLINE_MS);
    // #564 guard 3 / #640 part 7 — hand the LIVE persistence to the global
    // 403/404 subscriber (installed at app level in main.tsx, because the
    // revoked-page case never mounts the editor at all), keyed by both aliases
    // a page query can use. Registered whenever a local persistence was
    // actually opened, regardless of the flag: deleting revoked content is not
    // gated on the local-first experiment.
    registerPageYdoc({ dbName, persistence: local, keys: [pageId, slugId] });
  } else {
    // #707 — no local persistence: the local side is ready and empty, so
    // attach right away.
    session.localSynced = true;
    attach();
  }

  sessions.set(dbName, session);
  return session;
}

// page-ydoc-eviction cannot import this module (this module imports
// `queryClient` from main.tsx, which imports page-ydoc-eviction), so the
// eviction (403/404) and purge paths reach the sessions through these hooks.
registerPageSessionDestroyHooks({
  destroyPageSession,
  destroyAllPageSessions,
});
