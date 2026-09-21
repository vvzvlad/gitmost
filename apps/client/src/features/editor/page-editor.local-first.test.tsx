import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, waitFor, cleanup } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Provider, createStore } from "jotai";
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
 *  - `@hocuspocus/provider` — a fake provider whose status/sync callbacks we fire
 *    by hand, so "the remote never answers", "the remote drops" and "the remote
 *    syncs" are states we control. WebSocketStatus keeps the real string values.
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
  localFirst: true,
  idStampAttempts: 0,
}));

vi.mock("@/lib/config.ts", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    isLocalFirstEnabled: () => hoisted.localFirst,
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
    connect = vi.fn();
    disconnect = vi.fn();
    destroy = vi.fn();
    constructor(_opts: unknown) {}
  }

  class HocuspocusProvider {
    document: Y.Doc;
    awareness: any;
    configuration: { token?: string };
    attach = vi.fn();
    detach = vi.fn();
    destroy = vi.fn();
    sendStateless = vi.fn();
    listeners = new Map<string, ((...a: any[]) => void)[]>();
    private opts: any;
    constructor(opts: any) {
      this.opts = opts;
      this.document = opts.document;
      this.awareness = new Awareness(opts.document);
      this.configuration = { token: opts.token };
      hoisted.providers.push(this);
    }
    // Real hocuspocus is an EventEmitter and extensions subscribe through it —
    // @tiptap/extension-unique-id does `provider.on("synced", createIds)`.
    on(event: string, cb: (...a: any[]) => void) {
      const list = this.listeners.get(event) ?? [];
      list.push(cb);
      this.listeners.set(event, list);
    }
    off(event: string, cb: (...a: any[]) => void) {
      const list = (this.listeners.get(event) ?? []).filter((h) => h !== cb);
      this.listeners.set(event, list);
    }
    /** test driver: the socket status changed */
    emitStatus(status: string) {
      this.opts.onStatus?.({ status });
    }
    /**
     * test driver: the remote room synced (or un-synced).
     *
     * The ORDER here is the real one and is load-bearing for #564 F3: hocuspocus
     * registers the `onSynced` CONFIGURATION callback as the first "synced"
     * listener, so the page editor's handler runs BEFORE any listener an
     * extension attached later (UniqueID's `createIds`) — all inside this single
     * synchronous emit. If the write guard only opened on a React state update,
     * `createIds` would run while it was still closed.
     */
    emitSynced(state: boolean) {
      this.opts.onSynced?.({ state });
      if (state) {
        [...(this.listeners.get("synced") ?? [])].forEach((cb) => cb());
      }
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
// (#564 F3). The real UniqueID cannot be used here because it is not in the
// trimmed extension list; this reproduces its timing exactly.
vi.mock("@/features/editor/extensions/extensions", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { StarterKit } = await import("@tiptap/starter-kit");
  const { Extension } = await import("@tiptap/core");

  const SyncedIdStamper = (provider: any) =>
    Extension.create({
      name: "testSyncedIdStamper",
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
      },
    });

  return {
    ...actual,
    mainExtensions: [StarterKit.configure({ undoRedo: false } as never)],
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
import { pageEditorAtom } from "@/features/editor/atoms/editor-atoms";
import {
  resetPageYdocRegistryForTests,
  pageYdocDbName,
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
  hoisted.localFirst = true;
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
    act(() => {
      provider.emitStatus("connected");
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
    act(() => {
      provider.emitStatus("connected");
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
    act(() => {
      provider.emitStatus("connected");
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
    const provider = lastProvider();
    act(() => provider.emitStatus("disconnected"));

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
    act(() => {
      provider.emitStatus("connected");
      provider.emitSynced(true);
    });
    await waitFor(() => expect(getEditor(store).isEditable).toBe(true));

    act(() => {
      provider.emitStatus("disconnected");
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

    // Page A's providers are gone, page B has its own (empty) ydoc.
    expect(persistenceA.destroyed).toBe(true);
    const persistenceB = lastPersistence();
    expect(persistenceB).not.toBe(persistenceA);
    expect(persistenceB.name).toBe(`page.${SCOPE}.${PAGE_B}`);

    // The sync state did NOT carry over: page B is back on the static copy and
    // page A's body is nowhere on screen.
    expect(container.textContent).not.toContain("PAGE A LOCAL BODY");
    expect(container.querySelector(".editor-container")).toBeNull();
    expect(container.textContent).toContain("Server seeded copy");

    // A late "synced" from page A's destroyed persistence must not swap page B.
    act(() => persistenceA.emitSynced());
    expect(container.querySelector(".editor-container")).toBeNull();

    // Page B's own local sync (empty doc) still doesn't swap; its remote does,
    // and the editor is then bound to page B's ydoc.
    act(() => persistenceB.emitSynced());
    expect(container.querySelector(".editor-container")).toBeNull();
    const providerB = lastProvider();
    expect(providerB.document).toBe(persistenceB.doc);
    act(() => {
      providerB.emitStatus("connected");
      providerB.emitSynced(true);
    });
    await waitFor(() => {
      expect(container.querySelector(".editor-container")).not.toBeNull();
    });
    expect(container.textContent).not.toContain("PAGE A LOCAL BODY");
  });
});

describe("#564 flag OFF: behavior identical to today", () => {
  beforeEach(() => {
    hoisted.localFirst = false;
  });

  it("does NOT swap early even with a non-empty local ydoc; swaps + edits on remote sync", async () => {
    const store = makeStore();
    const { container } = renderEditor(store, PAGE_A);

    const persistence = lastPersistence();
    seedYdoc(persistence.doc, "Local body text");
    act(() => persistence.emitSynced());

    // Today's rule: the network still gates the body.
    await waitFor(() => {
      expect(container.textContent).toContain("Server seeded copy");
    });
    expect(container.querySelector(".editor-container")).toBeNull();
    expect(getEditor(store).isEditable).toBe(false);
    expect(
      container.querySelector('[data-testid="body-connecting-badge"]'),
    ).not.toBeNull();

    const provider = lastProvider();
    act(() => {
      provider.emitStatus("connected");
      provider.emitSynced(true);
    });

    await waitFor(() => {
      expect(container.querySelector(".editor-container")).not.toBeNull();
    });
    await waitFor(() => expect(getEditor(store).isEditable).toBe(true));

    const editor = getEditor(store);
    const updates = vi.fn();
    persistence.doc.on("update", updates);
    act(() => simulateUserEdit(editor));
    expect(updates).toHaveBeenCalled();
  });

  it("shows no offline banner while disconnected in the static window (today's badge only)", async () => {
    const store = makeStore();
    const { container } = renderEditor(store, PAGE_A);

    const persistence = lastPersistence();
    seedYdoc(persistence.doc, "Local body text");
    act(() => persistence.emitSynced());
    act(() => lastProvider().emitStatus("disconnected"));

    expect(store.get(bodyLocalOnlyAtom).isOffline).toBe(false);
    expect(
      container.querySelector('[data-testid="body-connecting-badge"]'),
    ).not.toBeNull();
    expect(container.querySelector(".editor-container")).toBeNull();
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

    // The socket drops (or the 7500ms fallback fires): the page-wide offline
    // banner is published.
    act(() => provider.emitStatus("disconnected"));
    await waitFor(() =>
      expect(store.get(bodyLocalOnlyAtom).isOffline).toBe(true),
    );

    // A single retry BLIP — Hocuspocus re-attempts forever and emits Connecting on
    // every attempt. The banner must STAY offline (the sticky latch), never flip
    // back to the quiet "connecting" badge and flicker the page-wide banner.
    act(() => provider.emitStatus("connecting"));
    expect(store.get(bodyLocalOnlyAtom).isOffline).toBe(true);
    expect(
      document.querySelector('[data-testid="body-connecting-badge"]'),
    ).toBeNull();

    // ONLY a real remote sync (isRemoteConfirmed) clears it.
    act(() => {
      provider.emitStatus("connected");
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
    act(() => {
      provider.emitStatus("connected");
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
