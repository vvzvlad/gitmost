import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useLayoutEffect } from "react";
import { render, act, waitFor, cleanup } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Provider, createStore, getDefaultStore } from "jotai";
import * as Y from "yjs";

/**
 * #564 — local-first phase 2 (body-instant), the REAL PageEditor.
 *
 * Everything load-bearing here is production code: the real Y.Doc, the real
 * tiptap collab extensions (ySync/yCursor via @tiptap/extension-collaboration),
 * the real editor-sync-state gates and the real Yjs write guard. Only the two
 * I/O edges are faked, because they are the states we must be able to HOLD:
 *
 *  - `y-indexeddb` — a fake persistence whose "synced" event we fire by hand, so
 *    "the local ydoc is hydrated (with / without content)" is a state we control.
 *  - `@hocuspocus/provider` — a fake socket whose status callback and a fake
 *    provider whose sync callback we fire by hand, so "the remote never answers",
 *    "the remote drops" and "the remote syncs" are states we control.
 *    WebSocketStatus keeps the real string values.
 *
 * The editability assertions are made at the YJS level, not the UI level: a
 * simulated USER edit (a real `keydown` Enter dispatched on the ProseMirror DOM,
 * the path prosemirror-view gates on `view.editable`) must produce ZERO Y.Doc
 * updates while read-only, and a real update once editing is allowed. The second
 * half is what makes the first non-vacuous: the same simulated edit demonstrably
 * reaches Yjs when the guard opens.
 *
 * ONE more thing is narrowed, and only for a test-infra reason: `mainExtensions`
 * is swapped for a StarterKit-based list (`collabExtensions` — ySync, the caret,
 * intentional-clear — stays REAL, and so does everything PageEditor does with
 * them). Mounting the full docmost extension list under vitest crashes inside
 * prosemirror-view ("Cannot read properties of undefined (reading
 * 'localsInner')"): `@docmost/editor-ext` resolves to SOURCE and is transformed
 * by vite, while `@tiptap/*` is externalized to node, so the two ends up holding
 * two different `prosemirror-view` module instances; decorations built by one
 * fail `instanceof DecorationSet` in the other and `DecorationGroup.from` builds
 * a group with `undefined` members. That is a module-resolution artifact of the
 * test runner, unrelated to #564, and none of the guards under test live in
 * those node extensions.
 */

const hoisted = vi.hoisted(() => ({
  providers: [] as any[],
  persistences: [] as any[],
  sockets: [] as any[],
  idStampAttempts: 0,
}));

vi.mock("@/lib/config.ts", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getCollaborationUrl: () => "ws://localhost/collab",
  };
});

vi.mock("y-indexeddb", () => {
  class FakeIndexeddbPersistence {
    name: string;
    doc: Y.Doc;
    handlers = new Map<string, ((...a: any[]) => void)[]>();
    destroyed = false;
    clearData = vi.fn(async () => {
      this.destroyed = true;
    });
    constructor(name: string, doc: Y.Doc) {
      this.name = name;
      this.doc = doc;
      hoisted.persistences.push(this);
    }
    on(event: string, cb: (...a: any[]) => void) {
      const list = this.handlers.get(event) ?? [];
      list.push(cb);
      this.handlers.set(event, list);
    }
    off(event: string, cb: (...a: any[]) => void) {
      const list = (this.handlers.get(event) ?? []).filter((h) => h !== cb);
      this.handlers.set(event, list);
    }
    destroy() {
      this.destroyed = true;
    }
    /** test driver: IndexedDB finished loading (with whatever is in the doc) */
    emitSynced() {
      (this.handlers.get("synced") ?? []).forEach((cb) => cb(this));
    }
  }
  return { IndexeddbPersistence: FakeIndexeddbPersistence };
});

vi.mock("@hocuspocus/provider", async () => {
  const { Awareness } = await import("y-protocols/awareness.js");
  const WebSocketStatus = {
    Connecting: "connecting",
    Connected: "connected",
    Disconnected: "disconnected",
  } as const;

  class HocuspocusProviderWebsocket {
    // The real constructor connects right away and emits Connecting
    // synchronously.
    status = "connecting";
    connect = vi.fn();
    disconnect = vi.fn();
    destroy = vi.fn();
    private opts: any;
    constructor(opts: any) {
      this.opts = opts;
      hoisted.sockets.push(this);
    }
    /**
     * test driver: the socket status changed. Fired through the SOCKET's own
     * `onStatus` config (#707) — it reaches the editor whether or not the
     * provider has attached yet. Like the real socket, `status` is updated
     * before the event.
     */
    emitStatus(status: string) {
      this.status = status;
      this.opts.onStatus?.({ status });
    }
  }

  class HocuspocusProvider {
    document: Y.Doc;
    awareness: any;
    configuration: { token?: any };
    isSynced = false;
    isAuthenticated = false;
    authorizedScope: "read-write" | "readonly" | undefined = undefined;
    attach = vi.fn();
    detach = vi.fn();
    destroy = vi.fn();
    sendStateless = vi.fn();
    sendToken = vi.fn(async () => {});
    // Real hocuspocus is an EventEmitter and extensions subscribe through it —
    // @tiptap/extension-unique-id does `provider.on("synced", createIds)`.
    callbacks: Record<string, ((...a: any[]) => void)[]> = {};
    private opts: any;
    constructor(opts: any) {
      this.opts = opts;
      this.document = opts.document;
      this.awareness = new Awareness(opts.document);
      this.configuration = { token: opts.token };
      // Like the real provider, the `onSynced` CONFIGURATION callback is
      // registered in the constructor — the first "synced" listener.
      if (opts.onSynced) this.on("synced", opts.onSynced);
      hoisted.providers.push(this);
    }
    on(event: string, cb: (...a: any[]) => void) {
      (this.callbacks[event] ??= []).push(cb);
    }
    off(event: string, cb: (...a: any[]) => void) {
      this.callbacks[event] = (this.callbacks[event] ?? []).filter(
        (h) => h !== cb,
      );
    }
    /**
     * test driver: the remote room synced (or un-synced).
     *
     * The ORDER here is the real one and is load-bearing for #564 F3: hocuspocus
     * registers the `onSynced` CONFIGURATION callback as the first "synced"
     * listener, so the session's handler (and through it the page editor) runs
     * BEFORE any listener an extension attached later (UniqueID's `createIds`)
     * — all inside this single synchronous emit. If the write guard only opened
     * on a React state update, `createIds` would run while it was still closed.
     * Like the real `synced` setter, `isSynced` is set first and only `true`
     * emits.
     */
    emitSynced(state: boolean) {
      this.isSynced = state;
      if (state) {
        [...(this.callbacks.synced ?? [])].forEach((cb) => cb({ state }));
      }
    }
    /** test driver: the server authorized the document with this scope. */
    authenticate(scope: "read-write" | "readonly") {
      this.isAuthenticated = true;
      this.authorizedScope = scope;
    }
    /**
     * test driver: the provider closed — a server CLOSE message (code 1000,
     * the socket stays open) or the socket itself closing (its real code). Like
     * the real provider, it resets the sync/auth state, then calls `onClose`.
     */
    emitClose(event: { code: number; reason: string }) {
      this.isAuthenticated = false;
      this.isSynced = false;
      this.opts.onClose?.({ event });
    }
  }

  return {
    HocuspocusProvider,
    HocuspocusProviderWebsocket,
    WebSocketStatus,
  };
});

// See the header note: only the extension LIST is trimmed; `collabExtensions`
// (and everything page-editor does with it) is the real thing.
//
// One extension is ADDED: `SyncedIdStamper`, a faithful stand-in for
// @tiptap/extension-unique-id — the real one, with a collab provider, does
// `provider.on("synced", createIds)`, and `createIds` synchronously
// `view.dispatch`es the id-assigning transaction and then IMMEDIATELY
// unsubscribes. It gets exactly ONE shot, inside the provider's synced emit
// (#564 F3). The stamper reproduces that timing exactly and lets the #564 tests
// count id-stamp attempts and inject a visible edit, which the real extension
// cannot do.
//
// #709 — the REAL UniqueID (the local override in @docmost/editor-ext) is in
// the trimmed list too: the warm-session tests assert on what it does on an
// already synced provider (ids right away, no "synced" listener). Its
// not-yet-synced path — subscribe, then unsubscribe on destroy — is covered in
// packages/editor-ext/src/lib/unique-id/unique-id.test.ts. Like the override,
// the stamper unsubscribes when its editor is destroyed.
vi.mock("@/features/editor/extensions/extensions", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { StarterKit } = await import("@tiptap/starter-kit");
  const { Extension } = await import("@tiptap/core");
  const { UniqueID } = await import("@docmost/editor-ext");

  const SyncedIdStamper = (provider: any) =>
    Extension.create<unknown, { unsubscribe: (() => void) | null }>({
      name: "testSyncedIdStamper",
      addStorage() {
        return { unsubscribe: null };
      },
      onCreate() {
        const { editor } = this;
        const createIds = () => {
          hoisted.idStampAttempts += 1;
          // The one and only dispatch — a doc change, exactly like assigning
          // `data-id`s to every node that lacks one.
          editor.view.dispatch(editor.state.tr.insertText("[ids]", 1));
          // ...and it unsubscribes right away, precisely like UniqueID.
          provider.off("synced", createIds);
        };
        provider.on("synced", createIds);
        this.storage.unsubscribe = () => provider.off("synced", createIds);
      },
      onDestroy() {
        this.storage.unsubscribe?.();
      },
    });

  return {
    ...actual,
    mainExtensions: [
      StarterKit.configure({ undoRedo: false } as never),
      UniqueID.configure({ types: ["paragraph", "heading"] }),
    ],
    collabExtensions: (provider: any, user: any) => [
      ...(actual.collabExtensions as any)(provider, user),
      SyncedIdStamper(provider),
    ],
  };
});

// Needs the (untrimmed) SearchAndReplace extension's commands; nothing to do
// with #564.
vi.mock(
  "@/features/editor/components/search-and-replace/search-and-replace-dialog.tsx",
  () => ({ default: () => null }),
);

// PageEditor renders the lazy Excalidraw menu as soon as the editor becomes
// editable. Under vitest that `import()` reaches the real `@excalidraw/excalidraw`
// package, which is externalized to node and whose chunk imports the extensionless
// specifier "roughjs/bin/rough" — unresolvable by Node's ESM loader. The rejected
// lazy import lands as an UNHANDLED rejection some ticks later and vitest charges
// it to whichever test happens to be running, failing tests at random. It is a
// module-resolution artifact of the test runner and the menu has nothing to do
// with #564, so it is stubbed out.
vi.mock("@/features/editor/components/excalidraw/excalidraw-menu-lazy", () => ({
  default: () => null,
}));

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useParams: () => ({ pageSlug: "page-slug-1" }) };
});

vi.mock("@/main.tsx", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient() };
});

vi.mock("@/features/auth/queries/auth-query.tsx", () => ({
  useCollabToken: () => ({
    data: { token: "test-token" },
    refetch: vi.fn(async () => ({ data: { token: "test-token" } })),
  }),
}));

// #709 — the session's token callback reads the collab token from the query
// cache and fetches it through `getCollabToken` when missing or expired.
vi.mock("@/features/auth/services/auth-service", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCollabToken: vi.fn(async () => ({ token: "test-token" })),
}));

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

import PageEditor from "./page-editor";
import { queryClient } from "@/main.tsx";
import { bodyLocalOnlyAtom } from "@/features/editor/atoms/editor-atoms";
import {
  pageEditorAtom,
  yjsConnectionStatusAtom,
} from "@/features/editor/atoms/editor-atoms";
import {
  resetPageYdocRegistryForTests,
  pageYdocDbName,
  evictPageYdoc,
  installYdocPurgeBroadcastListener,
  purgePageYdocDatabases,
} from "./page-ydoc-eviction";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";
import { scopeKeyAtom } from "@/features/page/tree/atoms/open-tree-nodes-atom";
import {
  resetTombstonesForTests,
  addTombstones,
} from "./page-ydoc-tombstones";
import {
  markReconciled,
  resetReconciledForTests,
} from "./page-ydoc-reconciled";
import {
  clearSessionVerifiedForTests,
  recordSessionVerified,
} from "@/features/user/session-verified";
import {
  acquirePageSession,
  destroyAllPageSessions,
  destroyPageSession,
  MAX_PARKED_ENCODED_BYTES,
  MAX_PARKED_SESSIONS,
  PARKED_TTL_MS,
  type PageSession,
  peekWarmSession,
  releasePageSession,
} from "./page-session-cache";
import { getCollabToken } from "@/features/auth/services/auth-service";
import { FIVE_MINUTES } from "@/lib/constants.ts";
import type { Editor } from "@tiptap/react";

const PAGE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PAGE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
// #626 — the ydoc DB name is now namespaced by the (workspace, user) scope key.
// The `currentUser` seeded in beforeEach below resolves scopeKeyAtom to this.
const SCOPE = "w-1:u-1";

const STATIC_CONTENT = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "Server seeded copy" }],
    },
  ],
};

/** Write a paragraph of text into the ydoc the way y-prosemirror stores it. */
function seedYdoc(doc: Y.Doc, text: string): void {
  const fragment = doc.getXmlFragment("default");
  const paragraph = new Y.XmlElement("paragraph");
  const xmlText = new Y.XmlText();
  xmlText.insert(0, text);
  paragraph.insert(0, [xmlText]);
  fragment.insert(0, [paragraph]);
}

function lastPersistence() {
  return hoisted.persistences[hoisted.persistences.length - 1];
}
function lastProvider() {
  return hoisted.providers[hoisted.providers.length - 1];
}
function lastSocket() {
  return hoisted.sockets[hoisted.sockets.length - 1];
}

interface WrapOpts {
  content?: any;
  editable?: boolean;
  bodyContentPending?: boolean;
}

function wrap(
  store: ReturnType<typeof createStore>,
  pageId: string,
  opts?: WrapOpts,
) {
  const content = opts && "content" in opts ? opts.content : STATIC_CONTENT;
  return (
    <QueryClientProvider client={queryClient}>
      <MantineProvider>
        <Provider store={store}>
          <MemoryRouter>
            <PageEditor
              pageId={pageId}
              editable={opts?.editable ?? true}
              content={content}
              bodyContentPending={opts?.bodyContentPending}
            />
          </MemoryRouter>
        </Provider>
      </MantineProvider>
    </QueryClientProvider>
  );
}

function renderEditor(store: ReturnType<typeof createStore>, pageId: string) {
  return render(wrap(store, pageId));
}

/**
 * Simulate a USER edit: a real `keydown` Enter on the ProseMirror DOM. This is
 * the exact path prosemirror-view gates on `view.editable` (edit handlers are not
 * invoked on a non-editable view), and when it IS invoked the base keymap splits
 * the block — a doc change that y-prosemirror writes straight into the Y.Doc.
 */
function simulateUserEdit(editor: Editor): void {
  editor.commands.focus("end");
  editor.view.dom.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function getEditor(store: ReturnType<typeof createStore>): Editor {
  const editor = store.get(pageEditorAtom) as Editor | null;
  if (!editor) throw new Error("editor not published");
  return editor;
}

// Warm the store with the resolved (workspace, user) scope BEFORE the first
// render. In production the #640 `getOnInit` on `currentUserAtom` reads the
// persisted user at atom CONSTRUCTION (app boot — localStorage is already
// populated from the prior session), so the very first frame, and therefore the
// one-shot `[pageId]` provider effect that reads `scopeKeyAtom`, already sees the
// real scope. Under vitest the atom module is evaluated BEFORE this file's
// `beforeEach` sets localStorage, so at getOnInit time storage is still empty and
// the store starts at "anon:anon"; the storage-backed `onMount` resolves it only
// one re-render LATER — after the one-shot effect has already run and (correctly)
// refused to construct a local persistence under an unresolved scope. Seeding the
// store here reproduces the production first-frame precondition; it changes no
// assertion, only the precondition the harness cannot express through localStorage
// timing. (See the note in current-user-atom.ts.)
function makeStore() {
  const store = createStore();
  store.set(currentUserAtom, {
    user: { id: "u-1", name: "Tester", settings: {} },
    workspace: { id: "w-1" },
  } as never);
  return store;
}

beforeEach(() => {
  hoisted.providers.length = 0;
  hoisted.persistences.length = 0;
  hoisted.sockets.length = 0;
  hoisted.idStampAttempts = 0;
  resetPageYdocRegistryForTests();
  // #640 fail-closed latches are module-level: clear them so one test's tombstone
  // / expired-session state can never leak into the next.
  resetTombstonesForTests();
  resetReconciledForTests();
  clearSessionVerifiedForTests();
  localStorage.setItem(
    "currentUser",
    JSON.stringify({
      user: { id: "u-1", name: "Tester", settings: {} },
      workspace: { id: "w-1" },
    }),
  );
});

afterEach(() => {
  cleanup();
  // #709 — the session cache is module-level: unmounting parks the sessions.
  destroyAllPageSessions();
  queryClient.removeQueries({ queryKey: ["collab-token"] });
  // The #641 test fires a window `offline` event, which also pauses the query
  // client's fetches (the session's token callback fetches through it).
  onlineManager.setOnline(true);
  localStorage.clear();
  resetTombstonesForTests();
  resetReconciledForTests();
  clearSessionVerifiedForTests();
});

describe("#564 body-instant: live body from the local ydoc, read-only until remote", () => {
  it("renders the body live from a NON-EMPTY local ydoc with no remote connection, read-only", async () => {
    const store = makeStore();
    const { container } = renderEditor(store, PAGE_A);

    const persistence = lastPersistence();
    seedYdoc(persistence.doc, "Local body text");
    // The remote provider is never told to connect/sync in this test.
    act(() => persistence.emitSynced());

    // Body swapped to the LIVE editor and shows the local ydoc's content.
    await waitFor(() => {
      expect(container.querySelector(".editor-container")).not.toBeNull();
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Local body text");
    });

    const editor = getEditor(store);
    // Read-only at the ProseMirror level...
    expect(editor.isEditable).toBe(false);
    expect(editor.view.editable).toBe(false);

    // ...AND at the Yjs level: a real user edit produces no Y.Doc update.
    const updates = vi.fn();
    persistence.doc.on("update", updates);
    act(() => simulateUserEdit(editor));
    expect(updates).not.toHaveBeenCalled();
    expect(persistence.doc.getXmlFragment("default").length).toBe(1);

    // And the Yjs gate is not merely `view.editable`: a doc-changing transaction
    // that bypasses ProseMirror's input handling entirely (a programmatic tiptap
    // command — the shape a plugin's appendTransaction or a stray code path
    // takes) is rejected by the write guard's filterTransaction, so nothing is
    // written into the Y.Doc that could be pushed to the server on connect.
    act(() => {
      editor.commands.insertContent("<p>sneaky programmatic write</p>");
    });
    expect(updates).not.toHaveBeenCalled();
    expect(persistence.doc.getXmlFragment("default").length).toBe(1);
    expect(persistence.doc.getXmlFragment("default").toString()).not.toContain(
      "sneaky",
    );

    // The quiet "connecting" badge is shown (never an alarming offline banner)
    // and the page-wide offline state is NOT published.
    expect(
      container.querySelector('[data-testid="body-connecting-badge"]'),
    ).not.toBeNull();
    expect(store.get(bodyLocalOnlyAtom).isOffline).toBe(false);
  });

  it("becomes editable — and edits reach the ydoc — only once the remote syncs", async () => {
    const store = makeStore();
    const { container } = renderEditor(store, PAGE_A);

    const persistence = lastPersistence();
    seedYdoc(persistence.doc, "Local body text");
    act(() => persistence.emitSynced());
    await waitFor(() => {
      expect(container.querySelector(".editor-container")).not.toBeNull();
    });
    expect(getEditor(store).isEditable).toBe(false);

    const provider = lastProvider();
    const socket = lastSocket();
    act(() => {
      socket.emitStatus("connected");
      provider.emitSynced(true);
    });

    await waitFor(() => expect(getEditor(store).isEditable).toBe(true));

    // Non-vacuity of the read-only assertion above: the SAME simulated edit now
    // mutates the Y.Doc, so "no update while read-only" was a real gate, not an
    // inert edit path.
    const editor = getEditor(store);
    const updates = vi.fn();
    persistence.doc.on("update", updates);
    act(() => simulateUserEdit(editor));
    expect(updates).toHaveBeenCalled();
    expect(persistence.doc.getXmlFragment("default").length).toBe(2);

    // Nothing left to warn about.
    expect(
      container.querySelector('[data-testid="body-connecting-badge"]'),
    ).toBeNull();
    expect(store.get(bodyLocalOnlyAtom).isOffline).toBe(false);
  });

  it("a UniqueID-style provider.on('synced') dispatch lands (rejected before sync, passes in the emit)", async () => {
    // #564 F3. @tiptap/extension-unique-id assigns every node its `data-id` from
    // a `provider.on("synced")` callback that dispatches ONCE and unsubscribes
    // immediately. That callback runs INSIDE the same synchronous emit as the
    // page editor's own onSynced handler — so if the Yjs write guard only opened
    // on a React state update (which lands a re-render later), the id transaction
    // would be REJECTED and the extension would already be gone: every node would
    // stay without a `data-id` for the life of the editor, silently breaking
    // comment anchors, transclusions and the TOC. The guard must therefore open
    // SYNCHRONOUSLY inside onSynced.
    const store = makeStore();
    const { container } = renderEditor(store, PAGE_A);

    const persistence = lastPersistence();
    seedYdoc(persistence.doc, "Local body text");
    act(() => persistence.emitSynced());
    await waitFor(() => {
      expect(container.querySelector(".editor-container")).not.toBeNull();
    });

    const editor = getEditor(store);
    // The stamper has subscribed but not fired: nothing is stamped yet, and a
    // dispatch in this window is still rejected (the read-only guarantee holds).
    expect(hoisted.idStampAttempts).toBe(0);
    act(() => {
      editor.view.dispatch(editor.state.tr.insertText("[ids]", 1));
    });
    expect(editor.state.doc.textContent).not.toContain("[ids]");

    // The synced emit: page-editor's onSynced runs first, then the stamper's
    // callback — all synchronously, in this one emit.
    const provider = lastProvider();
    const socket = lastSocket();
    act(() => {
      socket.emitStatus("connected");
      provider.emitSynced(true);
    });

    // It fired exactly once (it unsubscribed) — and its transaction SURVIVED.
    expect(hoisted.idStampAttempts).toBe(1);
    await waitFor(() => {
      expect(getEditor(store).state.doc.textContent).toContain("[ids]");
    });
    // ...and it really reached the ydoc, not just the ProseMirror doc.
    expect(persistence.doc.getXmlFragment("default").toString()).toContain(
      "[ids]",
    );
  });

  it("keeps the static copy when the local ydoc is EMPTY (guard 1: no blank body)", async () => {
    const store = makeStore();
    const { container } = renderEditor(store, PAGE_A);

    const persistence = lastPersistence(); // nothing seeded: first visit
    act(() => persistence.emitSynced());

    // No swap: the server-seeded static copy stays until the remote answers.
    await waitFor(() => {
      expect(container.textContent).toContain("Server seeded copy");
    });
    expect(container.querySelector(".editor-container")).toBeNull();

    const provider = lastProvider();
    const socket = lastSocket();
    act(() => {
      socket.emitStatus("connected");
      provider.emitSynced(true);
    });
    await waitFor(() => {
      expect(container.querySelector(".editor-container")).not.toBeNull();
    });
  });

  it("a FAILED remote connection leaves a read-only body + the page-wide offline banner", async () => {
    const store = makeStore();
    const { container } = renderEditor(store, PAGE_A);

    const persistence = lastPersistence();
    seedYdoc(persistence.doc, "Local body text");
    act(() => persistence.emitSynced());
    await waitFor(() => {
      expect(container.querySelector(".editor-container")).not.toBeNull();
    });

    // The socket gives up (this is also what the 7500ms timeout does).
    const socket = lastSocket();
    act(() => socket.emitStatus("disconnected"));

    const editor = getEditor(store);
    await waitFor(() => expect(editor.isEditable).toBe(false));

    // No stale-doc editing: still zero Yjs writes.
    const updates = vi.fn();
    persistence.doc.on("update", updates);
    act(() => simulateUserEdit(editor));
    expect(updates).not.toHaveBeenCalled();

    // The user is told, page-wide (chrome included, via FullEditor).
    await waitFor(() =>
      expect(store.get(bodyLocalOnlyAtom).isOffline).toBe(true),
    );
    expect(
      container.querySelector('[data-testid="body-connecting-badge"]'),
    ).toBeNull();
  });

  it("a remote that syncs and then DROPS keeps the body editable (no regression)", async () => {
    const store = makeStore();
    const { container } = renderEditor(store, PAGE_A);

    const persistence = lastPersistence();
    seedYdoc(persistence.doc, "Local body text");
    act(() => persistence.emitSynced());
    const provider = lastProvider();
    const socket = lastSocket();
    act(() => {
      socket.emitStatus("connected");
      provider.emitSynced(true);
    });
    await waitFor(() => expect(getEditor(store).isEditable).toBe(true));

    act(() => {
      socket.emitStatus("disconnected");
      provider.emitSynced(false);
    });

    // Remote confirmation is sticky: the doc HAS reconciled with the server, so
    // offline editing stays allowed exactly as today.
    expect(getEditor(store).isEditable).toBe(true);
    expect(store.get(bodyLocalOnlyAtom).isOffline).toBe(false);
    expect(
      container.querySelector('[data-testid="body-connecting-badge"]'),
    ).toBeNull();
  });

  it("a page switch mid local-only never binds the previous page's ydoc", async () => {
    const store = makeStore();
    const { container, rerender } = renderEditor(store, PAGE_A);

    const persistenceA = lastPersistence();
    seedYdoc(persistenceA.doc, "PAGE A LOCAL BODY");
    act(() => persistenceA.emitSynced());
    await waitFor(() => {
      expect(container.textContent).toContain("PAGE A LOCAL BODY");
    });

    // Navigate to page B WITHOUT remounting (no `key`), mid local-only window.
    await act(async () => {
      rerender(wrap(store, PAGE_B));
    });

    // #709 — page A's session is parked (not destroyed); page B has its own
    // (empty) ydoc.
    expect(persistenceA.destroyed).toBe(false);
    const persistenceB = lastPersistence();
    expect(persistenceB).not.toBe(persistenceA);
    expect(persistenceB.name).toBe(`page.${SCOPE}.${PAGE_B}`);

    // The sync state did NOT carry over: page B is back on the static copy and
    // page A's body is nowhere on screen.
    expect(container.textContent).not.toContain("PAGE A LOCAL BODY");
    expect(container.querySelector(".editor-container")).toBeNull();
    expect(container.textContent).toContain("Server seeded copy");

    // A late "synced" from page A's parked persistence must not swap page B.
    act(() => persistenceA.emitSynced());
    expect(container.querySelector(".editor-container")).toBeNull();

    // Page B's own local sync (empty doc) still doesn't swap; its remote does,
    // and the editor is then bound to page B's ydoc.
    act(() => persistenceB.emitSynced());
    expect(container.querySelector(".editor-container")).toBeNull();
    const providerB = lastProvider();
    const socketB = lastSocket();
    expect(providerB.document).toBe(persistenceB.doc);
    act(() => {
      socketB.emitStatus("connected");
      providerB.emitSynced(true);
    });
    await waitFor(() => {
      expect(container.querySelector(".editor-container")).not.toBeNull();
    });
    expect(container.textContent).not.toContain("PAGE A LOCAL BODY");
  });
});

// #640 (Ф4), rule #8 — the fail-closed local-ydoc gate, tested through the REAL
// component on its OBSERVABLE property: was ANY `IndexeddbPersistence`
// constructed? The helpers (canOpenLocalYdoc / isSessionExpired / the anon
// scope check) are unit-tested elsewhere; this asserts the wiring in
// page-editor.tsx (`openLocal = scopeResolved && !isSessionExpired() &&
// canOpenLocalYdoc(dbName) && canOpenLocalYdoc(slug)`) actually gates the
// CONSTRUCTION — a tombstoned / expired / anon page must open a REMOTE-ONLY ydoc
// (zero local persistence = no IndexedDB database created), never a local one.
describe("#640 fail-closed: no local persistence for a revoked / expired / anon page", () => {
  // 30d, the default OFFLINE_GRACE (getOfflineGraceMs); the mocked config passes
  // it through from the real module, so a stamp older than this is expired.
  const OFFLINE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

  it("constructs ZERO IndexeddbPersistence for a TOMBSTONED page (remote-only)", () => {
    // A revoked page: its scoped ydoc DB name is on the denylist. y-indexeddb
    // creates the DB on construction, so the gate must refuse to construct it.
    addTombstones([pageYdocDbName(SCOPE, PAGE_A)]);

    const store = makeStore();
    renderEditor(store, PAGE_A);

    // The observable property: no local persistence was ever built...
    expect(hoisted.persistences.length).toBe(0);
    // ...yet the editor is NOT inert — it still opens the remote collab provider,
    // i.e. it degraded to remote-only rather than skipping the page entirely.
    expect(hoisted.providers.length).toBeGreaterThan(0);
  });

  it("constructs ZERO IndexeddbPersistence when the session is EXPIRED past OFFLINE_GRACE", () => {
    // A stamped-then-long-offline session (> 30d since the last `/me`): local
    // content must not be drawn, even though the scope resolves and the page is
    // not tombstoned.
    recordSessionVerified(Date.now() - OFFLINE_GRACE_MS - 60_000);

    const store = makeStore();
    renderEditor(store, PAGE_A);

    expect(hoisted.persistences.length).toBe(0);
    expect(hoisted.providers.length).toBeGreaterThan(0);
  });

  it("constructs ZERO IndexeddbPersistence under an ANON (unresolved) scope", () => {
    // Signed-out / not-yet-resolved: scopeKeyAtom is "anon:anon", so a local body
    // would be written under an anon namespace (invariant 2). The gate's
    // `scopeResolved` check must block construction. Use an UNWARMED store with no
    // persisted user so the scope stays anon for the one-shot provider effect.
    localStorage.removeItem("currentUser");
    const store = createStore();

    renderEditor(store, PAGE_A);

    expect(store.get(scopeKeyAtom).split(":")).toContain("anon");
    expect(hoisted.persistences.length).toBe(0);
    expect(hoisted.providers.length).toBeGreaterThan(0);
  });
});

// #641, part 6 — the offline-banner hysteresis FSM, tested on the MOUNTED editor
// through its OBSERVABLE property: `bodyLocalOnlyAtom.isOffline` (the flag
// FullEditor reads to paint the page-wide offline banner over both the body AND
// the chrome). `computeBodyIndicator` is unit-tested in editor-sync-state; this
// asserts the REAL `stickyOffline` / `browserOffline` wiring in page-editor.tsx
// drives that flag correctly across the transitions Hocuspocus's forever-retry
// Connecting/Disconnected flaps produce.
describe("#641 offline banner hysteresis (sticky latch + navigator.onLine)", () => {
  /** Reach the live-local body window (swapped off the static copy, remote NOT
   * confirmed) from a non-empty local ydoc. */
  async function mountLiveLocal(store: ReturnType<typeof createStore>) {
    const { container } = renderEditor(store, PAGE_A);
    const persistence = lastPersistence();
    seedYdoc(persistence.doc, "Local body text");
    act(() => persistence.emitSynced());
    await waitFor(() => {
      expect(container.querySelector(".editor-container")).not.toBeNull();
    });
    // Baseline: the live-local body is on screen, remote not yet confirmed, and we
    // are NOT offline (the quiet connecting badge, never the offline banner).
    expect(store.get(bodyLocalOnlyAtom).isOffline).toBe(false);
    return { container };
  }

  it("holds the offline banner across a Connecting retry blip; clears only on a real remote sync", async () => {
    const store = makeStore();
    await mountLiveLocal(store);
    const provider = lastProvider();
    const socket = lastSocket();

    // The socket drops (or the 7500ms fallback fires): the page-wide offline
    // banner is published.
    act(() => socket.emitStatus("disconnected"));
    await waitFor(() =>
      expect(store.get(bodyLocalOnlyAtom).isOffline).toBe(true),
    );

    // A single retry BLIP — Hocuspocus re-attempts forever and emits Connecting on
    // every attempt. The banner must STAY offline (the sticky latch), never flip
    // back to the quiet "connecting" badge and flicker the page-wide banner.
    act(() => socket.emitStatus("connecting"));
    expect(store.get(bodyLocalOnlyAtom).isOffline).toBe(true);
    expect(
      document.querySelector('[data-testid="body-connecting-badge"]'),
    ).toBeNull();

    // ONLY a real remote sync (isRemoteConfirmed) clears it.
    act(() => {
      socket.emitStatus("connected");
      provider.emitSynced(true);
    });
    await waitFor(() =>
      expect(store.get(bodyLocalOnlyAtom).isOffline).toBe(false),
    );
  });

  it("reflects offline from a window `offline` event without waiting for the socket timeout", async () => {
    const store = makeStore();
    await mountLiveLocal(store);

    // The collab socket is still merely "connecting" — its 7500ms Disconnected
    // fallback has NOT fired — so `reallyOffline` here can only come from the
    // browser's own offline signal.
    expect(store.get(bodyLocalOnlyAtom).isOffline).toBe(false);

    // A real network drop: navigator.onLine flips false and the browser fires the
    // `offline` event. The banner must reflect it immediately (no socket timeout).
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: false,
    });
    try {
      act(() => window.dispatchEvent(new Event("offline")));
      await waitFor(() =>
        expect(store.get(bodyLocalOnlyAtom).isOffline).toBe(true),
      );
    } finally {
      // Restore the prototype accessor (default: online) for the next test.
      delete (window.navigator as unknown as { onLine?: boolean }).onLine;
    }
  });
});

// Ф7 (#643) — the body-instant phase. The gate `page && space` is removed, so
// PageEditor now mounts on cached meta and owns three body states, plus a lazy
// collab-token callback and an `editable` that no longer recreates the editor.
// Tested through the REAL component on its OBSERVABLE properties.
describe("Ф7 body states: skeleton vs static vs live (parts 3 + 7)", () => {
  it("crit 2 — first visit (empty ydoc, cache miss, NOT reconciled) shows a body SKELETON, not an empty editor, not a foreign static copy", async () => {
    const store = makeStore();
    // Mounted on cached meta with the live REST body still pending, and no
    // authoritative content (`content: undefined`).
    const { container, rerender } = render(
      wrap(store, PAGE_A, { content: undefined, bodyContentPending: true }),
    );

    // Skeleton on the very first render (before any sync).
    expect(
      container.querySelector('[data-testid="body-skeleton"]'),
    ).not.toBeNull();

    // The local ydoc is EMPTY (first visit): it syncs but must NOT swap to a live
    // editor, and must NOT fall back to a static copy of some other content.
    const persistence = lastPersistence();
    act(() => persistence.emitSynced());
    expect(
      container.querySelector('[data-testid="body-skeleton"]'),
    ).not.toBeNull();
    expect(container.querySelector(".editor-container")).toBeNull();
    expect(container.textContent).not.toContain("Server seeded copy");

    // The live REST body resolves → skeleton gives way to the static copy (freshly
    // MOUNTED with the now-available content: EditorProvider deps=[] never re-reads
    // it, so mounting it only once content exists is what avoids the empty-forever
    // trap).
    await act(async () => {
      rerender(
        wrap(store, PAGE_A, {
          content: STATIC_CONTENT,
          bodyContentPending: false,
        }),
      );
    });
    expect(container.querySelector('[data-testid="body-skeleton"]')).toBeNull();
    await waitFor(() =>
      expect(container.textContent).toContain("Server seeded copy"),
    );
  });

  it("crit 2 non-vacuity — a genuinely LOADED-EMPTY page renders empty static, NOT a skeleton (state derives from bodyContentPending, not falsy content)", () => {
    const store = makeStore();
    // Loaded (not pending) but with empty content: this is an empty page, not an
    // unresolved one — it must render an empty editor, never a skeleton.
    const { container } = render(
      wrap(store, PAGE_A, { content: undefined, bodyContentPending: false }),
    );

    expect(container.querySelector('[data-testid="body-skeleton"]')).toBeNull();
    // The static editor is mounted (empty), not skeletal.
    expect(container.querySelector(".ProseMirror")).not.toBeNull();
  });

  it("part 7 — a reconciled-but-EMPTY page revisited offline renders empty static, NOT an eternal skeleton (keys on durable reconciledAt, not session isRemoteConfirmed)", async () => {
    // A prior online visit durably reconciled this page's (scoped) ydoc.
    markReconciled(pageYdocDbName(SCOPE, PAGE_A));

    const store = makeStore();
    // Offline revisit: the live REST body never resolves (bodyContentPending
    // stays true), and the local ydoc is empty (the page genuinely has no body).
    const { container } = render(
      wrap(store, PAGE_A, { content: undefined, bodyContentPending: true }),
    );
    const persistence = lastPersistence();
    act(() => persistence.emitSynced());

    // Despite bodyContentPending, the DURABLE reconciliation means the (empty)
    // local ydoc is authoritative → empty static, never a forever-skeleton.
    await waitFor(() =>
      expect(container.querySelector(".ProseMirror")).not.toBeNull(),
    );
    expect(container.querySelector('[data-testid="body-skeleton"]')).toBeNull();
  });

  it("crit 9 — the editor is NOT recreated when `editable` flips false→true (/pages/info lands): no editor destroy/recreate in the measured window", async () => {
    const store = makeStore();
    const { container, rerender } = render(
      wrap(store, PAGE_A, { editable: false }),
    );

    // Reach the live editor from a non-empty local ydoc + a real remote sync.
    const persistence = lastPersistence();
    seedYdoc(persistence.doc, "Body text");
    act(() => persistence.emitSynced());
    const provider = lastProvider();
    const socket = lastSocket();
    act(() => {
      socket.emitStatus("connected");
      provider.emitSynced(true);
    });
    await waitFor(() =>
      expect(container.querySelector(".editor-container")).not.toBeNull(),
    );

    const before = getEditor(store);
    // `/pages/info` lands and flips edit rights false→true. With `editable` OUT of
    // the useEditor deps, the SAME editor instance must survive (before this fix
    // it was in the deps → destroy+recreate at exactly this moment).
    await act(async () => {
      rerender(wrap(store, PAGE_A, { editable: true }));
    });
    const after = getEditor(store);
    expect(after).toBe(before);
    // And it became editable via the setEditable effect (the sole owner).
    await waitFor(() => expect(after.isEditable).toBe(true));
  });

  it("part 4 — the collab provider is built with a LAZY token CALLBACK (never an empty token at t0)", async () => {
    const store = makeStore();
    render(wrap(store, PAGE_A));
    const provider = lastProvider();

    // Not a by-value token (which at t0 could be empty → server rejects → 100ms
    // reconnect on the very path Ф7 speeds up): a function hocuspocus awaits.
    expect(typeof provider.configuration.token).toBe("function");
    await expect(
      (provider.configuration.token as () => Promise<string>)(),
    ).resolves.toBe("test-token");
  });
});

// #707 — the remote provider attaches to the socket only AFTER the local copy
// has loaded, so step1 carries the local state vector and the server answers
// with the diff instead of the whole document. Asserted on the observable
// property: when `attach()` is (and is not) called on the provider.
describe("#707 attach after the local copy loads", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("a — with local persistence, attach() waits for its synced and runs right after", async () => {
    const store = makeStore();
    renderEditor(store, PAGE_A);
    const provider = lastProvider();
    const persistence = lastPersistence();

    await act(async () => {});
    expect(provider.attach).not.toHaveBeenCalled();

    act(() => persistence.emitSynced());
    expect(provider.attach).toHaveBeenCalledTimes(1);
  });

  it("b — without persistence (local === null), attach() runs immediately and the body swaps to live after the provider syncs", async () => {
    // A tombstoned page opens a remote-only ydoc (no local persistence).
    addTombstones([pageYdocDbName(SCOPE, PAGE_A)]);
    const store = makeStore();
    const { container } = renderEditor(store, PAGE_A);
    expect(hoisted.persistences.length).toBe(0);

    const provider = lastProvider();
    expect(provider.attach).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".editor-container")).toBeNull();
    expect(container.textContent).toContain("Server seeded copy");

    act(() => {
      lastSocket().emitStatus("connected");
      provider.emitSynced(true);
    });
    await waitFor(() => {
      expect(container.querySelector(".editor-container")).not.toBeNull();
    });
  });

  it("c — persistence that never sends synced: attach() at exactly 1000 ms, console.error, body swaps to live after the provider syncs", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = makeStore();
    const { container } = renderEditor(store, PAGE_A);
    const provider = lastProvider();
    expect(hoisted.persistences.length).toBe(1);

    act(() => vi.advanceTimersByTime(999));
    expect(provider.attach).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(provider.attach).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("local ydoc did not sync"),
      expect.objectContaining({ pageId: PAGE_A, elapsedMs: expect.any(Number) }),
    );

    vi.useRealTimers();
    act(() => {
      lastSocket().emitStatus("connected");
      provider.emitSynced(true);
    });
    await waitFor(() => {
      expect(container.querySelector(".editor-container")).not.toBeNull();
    });
  });

  it("d (#709) — unmount before the deadline: the parked session still attaches at the deadline, in the background", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = makeStore();
    const { unmount } = renderEditor(store, PAGE_A);
    const provider = lastProvider();

    act(() => vi.advanceTimersByTime(500));
    unmount();
    expect(provider.attach).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(500));
    expect(provider.attach).toHaveBeenCalledTimes(1);
  });

  it("e — a socket status event emitted before attach() reaches yjsConnectionStatusAtom", () => {
    const store = makeStore();
    renderEditor(store, PAGE_A);
    expect(lastProvider().attach).not.toHaveBeenCalled();

    act(() => lastSocket().emitStatus("connected"));

    expect(lastProvider().attach).not.toHaveBeenCalled();
    expect(store.get(yjsConnectionStatusAtom)).toBe("connected");
  });
});

// #709 — warm collab sessions. The session cache (page-session-cache) is
// module-level and REAL here; only the I/O edges (y-indexeddb, the hocuspocus
// socket/provider) are the fakes above. Y.Doc and awareness are real.
describe("#709 warm collab sessions", () => {
  const COLLAB_URL = "ws://localhost/collab";

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function acquire(pageId: string, scopeKey = SCOPE): PageSession {
    return acquirePageSession({
      dbName: pageYdocDbName(scopeKey, pageId),
      pageId,
      slugId: pageId,
      scopeKey,
      collaborationURL: COLLAB_URL,
    });
  }

  /** Local copy loaded, socket connected, remote synced and authorized. */
  function syncSession(s: PageSession, scope?: "read-write" | "readonly") {
    (s.local as any)?.emitSynced();
    (s.socket as any).emitStatus("connected");
    if (scope) (s.remote as any).authenticate(scope);
    (s.remote as any).emitSynced(true);
  }

  /** A parked WARM session of PAGE_A whose body is `text`. */
  function parkWarm(text = "Warm body"): PageSession {
    const s = acquire(PAGE_A);
    seedYdoc(s.ydoc, text);
    syncSession(s, "read-write");
    releasePageSession(s);
    expect(peekWarmSession(s.dbName)).toBe(s);
    return s;
  }

  /** A JWT the client can decode (the signature is never checked). */
  function jwt(exp: number): string {
    const part = (o: object) =>
      btoa(JSON.stringify(o))
        .replace(/=+$/, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
    return `${part({ alg: "none" })}.${part({ exp })}.sig`;
  }

  it("a — 20 mount/unmount cycles of the editor on ONE session restore the awareness / synced / ydoc-destroy listener counts", () => {
    const session = parkWarm();
    const provider = session.remote as any;
    const counts = () => [
      provider.awareness._observers.get("update")?.size ?? 0,
      provider.callbacks.synced.length,
      (session.ydoc as any)._observers.get("destroy")?.size ?? 0,
    ];
    const baseline = counts();

    vi.useFakeTimers();
    let lastEditor: Editor | null = null;
    for (let i = 0; i < 20; i++) {
      const store = makeStore();
      const { unmount } = renderEditor(store, PAGE_A);
      // tiptap emits "create" (UniqueID's onCreate) on a 0 ms timer.
      act(() => vi.advanceTimersByTime(1));
      lastEditor = getEditor(store);
      unmount();
      // @tiptap/react destroys the editor on a timer after the unmount.
      act(() => vi.advanceTimersByTime(10));
    }

    // Every mount reused the one session, and every editor is gone.
    expect(hoisted.providers.length).toBe(1);
    expect(lastEditor!.isDestroyed).toBe(true);
    expect(counts()).toEqual(baseline);

    // A later "synced" emit does not reach the destroyed editor.
    const stateBefore = lastEditor!.state;
    expect(() => provider.emitSynced(true)).not.toThrow();
    expect(lastEditor!.state).toBe(stateBefore);
    // 20 full editor mounts: well past the default 5 s under a loaded full run.
  }, 30_000);

  it("b — mounting on a synced session gives nodes without an id an id, live from the first render", async () => {
    const session = parkWarm();
    const paragraph = () =>
      session.ydoc.getXmlFragment("default").get(0) as Y.XmlElement;
    expect(paragraph().getAttribute("id")).toBeUndefined();

    const store = makeStore();
    const { container } = renderEditor(store, PAGE_A);
    expect(container.querySelector(".editor-container")).not.toBeNull();
    expect(container.textContent).not.toContain("Server seeded copy");

    await waitFor(() =>
      expect(paragraph().getAttribute("id")).toEqual(expect.any(String)),
    );
    expect(hoisted.providers.length).toBe(1);
    await waitFor(() => expect(getEditor(store).isEditable).toBe(true));
  });

  describe("c — budget", () => {
    it("past MAX_PARKED_SESSIONS the longest-parked session is evicted, never the active one", async () => {
      const active = acquire("page-active");
      const parked = Array.from({ length: MAX_PARKED_SESSIONS + 1 }, (_, i) => {
        const s = acquire(`page-${i}`);
        releasePageSession(s);
        return s;
      });
      await Promise.resolve();

      expect(parked[0].alive).toBe(false);
      expect(parked.slice(1).every((s) => s.alive)).toBe(true);
      expect(active.alive).toBe(true);
    });

    it("past MAX_PARKED_ENCODED_BYTES the longest-parked session is evicted, never the active one", async () => {
      // Three such docs exceed the byte budget, two do not.
      const chunk = "x".repeat(Math.ceil(MAX_PARKED_ENCODED_BYTES / 2.5));
      const active = acquire("page-active");
      active.ydoc.getText("t").insert(0, chunk + chunk + chunk);
      const parked = ["page-1", "page-2", "page-3"].map((id) => {
        const s = acquire(id);
        s.ydoc.getText("t").insert(0, chunk);
        releasePageSession(s);
        return s;
      });
      await Promise.resolve();

      expect(parked.map((s) => s.alive)).toEqual([false, true, true]);
      expect(active.alive).toBe(true);
    });

    it("release never evicts synchronously: the session the next page takes in the same flush survives", async () => {
      const parked = Array.from({ length: MAX_PARKED_SESSIONS }, (_, i) => {
        const s = acquire(`page-${i}`);
        syncSession(s, "read-write");
        releasePageSession(s);
        return s;
      });
      await Promise.resolve();
      expect(parked.every((s) => s.alive)).toBe(true);

      // The leaving page parks a sixth session, and in the same flush the next
      // page takes the longest-parked one.
      releasePageSession(acquire("page-leaving"));
      expect(parked[0].alive).toBe(true);
      expect(acquire("page-0")).toBe(parked[0]);
      await Promise.resolve();

      expect(parked.every((s) => s.alive)).toBe(true);
      expect(parked[0].holder).toBe("active");
    });
  });

  it("d — a parked session is destroyed PARKED_TTL_MS after parking; acquire before that clears the timer", () => {
    vi.useFakeTimers();
    const expiring = acquire(PAGE_A);
    (expiring.local as any).emitSynced();
    releasePageSession(expiring);
    vi.advanceTimersByTime(PARKED_TTL_MS - 1);
    expect(expiring.alive).toBe(true);
    vi.advanceTimersByTime(1);
    expect(expiring.alive).toBe(false);
    expect(expiring.socket.destroy).toHaveBeenCalled();

    const kept = acquire(PAGE_B);
    syncSession(kept, "read-write");
    releasePageSession(kept);
    vi.advanceTimersByTime(PARKED_TTL_MS - 1000);
    expect(acquire(PAGE_B)).toBe(kept);
    vi.advanceTimersByTime(PARKED_TTL_MS);
    expect(kept.alive).toBe(true);
  });

  describe("e — a parked NON-warm session is destroyed on acquire and replaced", () => {
    const variants: [string, (provider: any) => void][] = [
      ["not synced", (p) => p.authenticate("read-write")],
      ["not authenticated", (p) => p.emitSynced(true)],
      [
        "read-only",
        (p) => {
          p.emitSynced(true);
          p.authenticate("readonly");
        },
      ],
    ];

    it.each(variants)("%s — a new session is returned", (_label, makeNonWarm) => {
      const s = acquire(PAGE_A);
      syncSession(s);
      (s.remote as any).isSynced = false;
      releasePageSession(s);
      makeNonWarm(s.remote);
      expect(peekWarmSession(s.dbName)).toBeNull();

      const next = acquire(PAGE_A);
      expect(next).not.toBe(s);
      expect(s.alive).toBe(false);
      expect(s.socket.destroy).toHaveBeenCalled();
      expect(next.alive).toBe(true);
    });

    it("the body takes the cold path: the static copy, a new provider", async () => {
      const s = acquire(PAGE_A);
      seedYdoc(s.ydoc, "Parked body");
      syncSession(s);
      releasePageSession(s);

      const store = makeStore();
      const { container } = renderEditor(store, PAGE_A);
      expect(s.alive).toBe(false);
      expect(lastProvider()).not.toBe(s.remote);
      expect(container.querySelector(".editor-container")).toBeNull();
      expect(container.textContent).toContain("Server seeded copy");
    });
  });

  it(
    "f — evicted between peek and acquire: the editor rebinds, and a write into the destroyed session is rejected",
    async () => {
      const warm = parkWarm();

      // Runs after PageEditor's render peeked (and bound) the warm session,
      // before its acquire effect.
      function EvictAfterRender() {
        useLayoutEffect(() => {
          destroyPageSession(warm.dbName);
          const dom = document.querySelector(
            ".editor-container .ProseMirror",
          ) as unknown as { editor: Editor };
          const editor = dom.editor;
          editor.view.dispatch(editor.state.tr.insertText("stale write", 1));
          expect(editor.state.doc.textContent).not.toContain("stale write");
        }, []);
        return null;
      }

      const store = makeStore();
      const { container } = render(
        <>
          {wrap(store, PAGE_A)}
          <EvictAfterRender />
        </>,
      );

      expect(warm.alive).toBe(false);
      expect(warm.ydoc.getXmlFragment("default").toString()).not.toContain(
        "stale write",
      );
      // Rebound to the new (cold) session: its own provider, the static copy.
      expect(hoisted.providers.length).toBe(2);
      expect(lastProvider()).not.toBe(warm.remote);
      await waitFor(() =>
        expect(container.querySelector(".editor-container")).toBeNull(),
      );
      expect(container.textContent).toContain("Server seeded copy");
    },
  );

  it("g — a 403/404 on a parked page destroys its socket and deletes its database; releasing the dead session is a no-op", async () => {
    // evictPageYdoc resolves the scope from the default store.
    getDefaultStore().set(currentUserAtom, {
      user: { id: "u-1", name: "Tester", settings: {} },
      workspace: { id: "w-1" },
    } as never);
    const s = acquire(PAGE_A);
    syncSession(s, "read-write");
    releasePageSession(s);
    const persistence = s.local as any;

    await evictPageYdoc(PAGE_A);

    expect(s.alive).toBe(false);
    expect(s.socket.destroy).toHaveBeenCalled();
    expect(persistence.clearData).toHaveBeenCalled();
    expect(peekWarmSession(s.dbName)).toBeNull();

    releasePageSession(s);
    expect(s.alive).toBe(false);
    expect(acquire(PAGE_A)).not.toBe(s);
  });

  describe("h — purge, scope, cross-tab broadcast", () => {
    it("a purge in this tab destroys every session", async () => {
      const active = acquire(PAGE_A);
      const parked = acquire(PAGE_B);
      releasePageSession(parked);

      await purgePageYdocDatabases();

      expect(active.alive).toBe(false);
      expect(parked.alive).toBe(false);
      expect(active.socket.destroy).toHaveBeenCalled();
      expect(parked.socket.destroy).toHaveBeenCalled();
    });

    it("a session of scope A is never handed out for scope B", () => {
      const s = parkWarm();
      const otherScope = "w-1:u-2";
      expect(peekWarmSession(pageYdocDbName(otherScope, PAGE_A))).toBeNull();
      const other = acquire(PAGE_A, otherScope);
      expect(other).not.toBe(s);
      expect(s.alive).toBe(true);
    });

    it("a purge broadcast from another tab closes the IndexedDB handles but does not destroy the active session", () => {
      const channels: { onmessage: ((e: any) => void) | null }[] = [];
      // Swapped by hand: vi.unstubAllGlobals() would also drop the
      // localStorage stub vitest.setup installs.
      const original = globalThis.BroadcastChannel;
      (globalThis as any).BroadcastChannel = class {
        onmessage: ((e: any) => void) | null = null;
        constructor() {
          channels.push(this);
        }
        postMessage() {}
        close() {}
      };
      try {
        const s = acquire(PAGE_A);
        installYdocPurgeBroadcastListener();
        channels[0].onmessage?.({ data: { type: "purge" } });

        expect((s.local as any).destroyed).toBe(true);
        expect(s.alive).toBe(true);
        expect(s.socket.destroy).not.toHaveBeenCalled();
      } finally {
        (globalThis as any).BroadcastChannel = original;
      }
    });
  });

  describe("j — connection status", () => {
    function setVisibility(state: "visible" | "hidden") {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => state,
      });
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
    }

    afterEach(() => {
      delete (document as unknown as { visibilityState?: string })
        .visibilityState;
    });

    it("a parked session's socket event does not change yjsConnectionStatusAtom", async () => {
      const store = makeStore();
      const { rerender } = renderEditor(store, PAGE_A);
      const socketA = lastSocket();
      await act(async () => {
        rerender(wrap(store, PAGE_B));
      });
      const socketB = lastSocket();
      expect(socketB).not.toBe(socketA);

      act(() => socketB.emitStatus("connected"));
      expect(store.get(yjsConnectionStatusAtom)).toBe("connected");
      act(() => socketA.emitStatus("disconnected"));
      expect(store.get(yjsConnectionStatusAtom)).toBe("connected");
    });

    it("the bound session's socket is disconnected while idle + hidden and reconnected when the tab is visible again", () => {
      vi.useFakeTimers();
      const store = makeStore();
      renderEditor(store, PAGE_A);
      const socket = lastSocket();
      act(() => {
        lastPersistence().emitSynced();
        socket.emitStatus("connected");
        lastProvider().emitSynced(true);
      });

      setVisibility("hidden");
      act(() => vi.advanceTimersByTime(FIVE_MINUTES));
      expect(socket.disconnect).toHaveBeenCalledTimes(1);

      act(() => socket.emitStatus("disconnected"));
      expect(socket.connect).not.toHaveBeenCalled();
      setVisibility("visible");
      expect(socket.connect).toHaveBeenCalledTimes(1);
    });
  });

  describe("k — permission re-check on a warm return", () => {
    it("a warm acquire calls remote.sendToken(); a cold one does not", () => {
      const s = acquire(PAGE_A);
      expect(s.remote.sendToken).not.toHaveBeenCalled();
      syncSession(s, "read-write");
      releasePageSession(s);

      expect(acquire(PAGE_A)).toBe(s);
      expect(s.remote.sendToken).toHaveBeenCalledTimes(1);
    });

    it("a server CLOSE 'Unauthorized' (code 1000) invalidates the page queries; destroys a parked session, not the active one", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const invalidate = vi.spyOn(queryClient, "invalidateQueries");
      const open = (pageId: string) =>
        acquirePageSession({
          dbName: pageYdocDbName(SCOPE, pageId),
          pageId,
          slugId: `slug-${pageId}`,
          scopeKey: SCOPE,
          collaborationURL: COLLAB_URL,
        });
      const parked = open(PAGE_A);
      syncSession(parked, "read-write");
      releasePageSession(parked);
      const active = open(PAGE_B);
      syncSession(active, "read-write");

      (parked.remote as any).emitClose({ code: 1000, reason: "Unauthorized" });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["pages", PAGE_A] });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["pages", `slug-${PAGE_A}`],
      });
      expect(parked.alive).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Unauthorized"),
        { pageId: PAGE_A },
      );

      (active.remote as any).emitClose({ code: 1000, reason: "Unauthorized" });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["pages", PAGE_B] });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["pages", `slug-${PAGE_B}`],
      });
      expect(active.alive).toBe(true);
    });

    it("a socket closed with { code: 4401, reason: 'Unauthorized' } does not take that path", () => {
      const invalidate = vi.spyOn(queryClient, "invalidateQueries");
      const s = acquire(PAGE_A);
      syncSession(s, "read-write");
      releasePageSession(s);

      (s.remote as any).emitClose({ code: 4401, reason: "Unauthorized" });
      expect(invalidate).not.toHaveBeenCalled();
      expect(s.alive).toBe(true);
    });

    it("the token callback fetches a new token when the cached one's exp has passed", async () => {
      const now = Math.floor(Date.now() / 1000);
      const fresh = jwt(now + 3600);
      vi.mocked(getCollabToken).mockClear();
      vi.mocked(getCollabToken).mockResolvedValueOnce({ token: fresh } as never);
      queryClient.setQueryData(["collab-token"], { token: jwt(now - 60) });
      const s = acquire(PAGE_A);
      const token = s.remote.configuration.token as () => Promise<string>;

      await expect(token()).resolves.toBe(fresh);
      expect(getCollabToken).toHaveBeenCalledTimes(1);
      // A still-valid cached token is used as is.
      await expect(token()).resolves.toBe(fresh);
      expect(getCollabToken).toHaveBeenCalledTimes(1);
    });
  });
});
