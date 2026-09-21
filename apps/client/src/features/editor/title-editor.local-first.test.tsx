import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, renderHook, act, waitFor, cleanup } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter } from "react-router-dom";
import { Provider, createStore } from "jotai";

/**
 * Ф7 (#643), part 2 — TitleEditor's two title-destroying operations (the
 * canonicalizing navigate and the force-save-on-unmount) are gated on the LIVE
 * page resolving, and `saveTitle` treats `undefined` like `null`. Mounted on the
 * #563 meta cache before `/pages/info`, an ungated version erases the title for
 * everyone (crit 3) or rewrites the URL to `untitled-undefined` (crit 4).
 *
 * Tested through the REAL TitleEditor + real tiptap. Only the write edges are
 * faked so they are observable: the title mutation, the router navigate, and the
 * websocket emit.
 */

const hoisted = vi.hoisted(() => ({
  updateTitle: vi.fn(async (arg: { pageId: string; title: string }) => ({
    id: "p-1",
    spaceId: "s-1",
    slugId: "slug-x",
    title: arg.title,
    parentPageId: null,
    icon: null,
  })),
  navigate: vi.fn(),
}));

vi.mock("@/features/page/queries/page-query", () => ({
  useUpdateTitlePageMutation: () => ({ mutateAsync: hoisted.updateTitle }),
  updatePageData: vi.fn(),
}));

vi.mock("@/features/websocket/use-query-emit.ts", () => ({
  useQueryEmit: () => vi.fn(),
}));

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useNavigate: () => hoisted.navigate };
});

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

import { TitleEditor } from "./title-editor";
import { useTitleAutofocus } from "./hooks/use-title-autofocus";
import { titleEditorAtom } from "@/features/editor/atoms/editor-atoms";
import { currentPageEditModeAtom } from "@/features/editor/atoms/editor-atoms";
import { PageEditMode } from "@/features/user/types/user.types";
import type { Editor } from "@tiptap/react";

const PAGE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

interface TitleProps {
  title: string | null | undefined;
  pageResolved?: boolean;
  editable?: boolean;
  spaceSlug?: string;
  slugId?: string;
}

function tree(store: ReturnType<typeof createStore>, props: TitleProps) {
  return (
    <MantineProvider>
      <Provider store={store}>
        <MemoryRouter>
          <TitleEditor
            pageId={PAGE}
            slugId={props.slugId ?? "slugB"}
            title={props.title as string}
            spaceSlug={props.spaceSlug ?? "engineering"}
            editable={props.editable ?? false}
            pageResolved={props.pageResolved}
          />
        </MemoryRouter>
      </Provider>
    </MantineProvider>
  );
}

async function waitForEditor(
  store: ReturnType<typeof createStore>,
): Promise<Editor> {
  await waitFor(() => {
    if (!store.get(titleEditorAtom)) throw new Error("title editor not published");
  });
  return store.get(titleEditorAtom) as Editor;
}

function erasingCalls() {
  return hoisted.updateTitle.mock.calls.filter((c) => c[0].title === "");
}

beforeEach(() => {
  hoisted.updateTitle.mockClear();
  hoisted.navigate.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("Ф7 use-title-autofocus — the autofocus is gated on the LIVE page", () => {
  // A minimal stub editor: the hook only reads `isInitialized` and calls
  // `commands.focus(...)`. Spying that call is the observable — jsdom does NOT
  // propagate a tiptap `focus()` command to `editor.isFocused` (it stays false
  // even when focus fires), so asserting on `isFocused` here would be vacuous.
  function stubEditor() {
    return { isInitialized: true, commands: { focus: vi.fn() } } as any;
  }

  // This is the load-bearing guard in the WORST title-erasure trap: mounted on
  // cached meta (`resolved=false`), an autofocus firing at TITLE_AUTOFOCUS_DELAY_MS
  // would focus the field BEFORE the live title lands; the setContent effect skips
  // a focused field, so the cached/empty title stays and a navigate-away persists
  // it over everyone's real title. The gate must suppress that focus.
  //
  // Uses FAKE timers and advances PAST the 300ms delay — the previous test used
  // real timers and never advanced them, so `isFocused` stayed false regardless of
  // the guard (it passed even with the guard removed). These assert the focus CALL.
  it("unresolved → advancing past the 300ms delay does NOT focus (the gate holds)", () => {
    vi.useFakeTimers();
    try {
      const editor = stubEditor();
      renderHook(() => useTitleAutofocus(editor, "page-unresolved", false));
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(editor.commands.focus).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("non-vacuity — resolved → advancing past the 300ms delay DOES focus (so the test above is a real gate, not an always-unfocused path)", () => {
    vi.useFakeTimers();
    try {
      const editor = stubEditor();
      renderHook(() => useTitleAutofocus(editor, "page-resolved", true));
      // Before the delay elapses, nothing has fired yet.
      expect(editor.commands.focus).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(editor.commands.focus).toHaveBeenCalledTimes(1);
      // ...and with the caret-at-end, no-scroll options the hook contracts on.
      expect(editor.commands.focus).toHaveBeenCalledWith("end", {
        scrollIntoView: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Ф7 title-editor crit 4 — routing gated on the live page", () => {
  it("does NOT rewrite the URL while unresolved; then canonicalizes with the ROUTE spaceSlug (never /p/untitled-undefined)", () => {
    const store = createStore();
    const { rerender } = render(
      tree(store, { title: null, pageResolved: false }),
    );

    // Mounted on cached meta: the canonicalizing navigate must NOT fire (this is
    // the call that, ungated + spaceSlug-from-cache, produced untitled-undefined).
    expect(hoisted.navigate).not.toHaveBeenCalled();

    // The live page resolves with the real title.
    act(() => {
      rerender(tree(store, { title: "Real Title", pageResolved: true }));
    });

    // Now it canonicalizes — with the ROUTE's spaceSlug, and never the broken slug.
    expect(hoisted.navigate).toHaveBeenCalled();
    const url = hoisted.navigate.mock.calls.at(-1)![0] as string;
    expect(url).toContain("/s/engineering/p/");
    expect(url).toContain("slugB");
    expect(url).not.toContain("untitled-undefined");
    expect(url).not.toMatch(/^\/p\//); // never the space-less form
  });
});

describe("Ф7 title-editor crit 3 — the title is not erased", () => {
  it("force-save on unmount is a NO-OP while the live page is unresolved (mounted on cached meta, navigated away before /pages/info)", () => {
    const store = createStore();
    const { unmount } = render(
      tree(store, { title: null, pageResolved: false }),
    );

    // Navigate away before the live page ever resolved.
    unmount();

    // The force-save was gated off → nothing persisted, so no `title:""` erasure.
    expect(hoisted.updateTitle).not.toHaveBeenCalled();
  });

  it("non-vacuity — once resolved, a real rename DOES force-save on unmount (the gate above is a real gate, not an inert path)", async () => {
    const store = createStore();
    store.set(currentPageEditModeAtom, PageEditMode.Edit);
    const { unmount } = render(
      tree(store, { title: "Original", pageResolved: true, editable: true }),
    );

    // The user renames the page (the field is editable once the page resolved).
    const editor = await waitForEditor(store);
    act(() => {
      editor.commands.setContent("Renamed by user");
    });

    unmount();

    // The force-save fired with the REAL title — the unmount-save path is live.
    expect(hoisted.updateTitle).toHaveBeenCalled();
    expect(hoisted.updateTitle.mock.calls.at(-1)![0].title).toBe(
      "Renamed by user",
    );
    // ...and it was never an empty-title erasure.
    expect(erasingCalls()).toHaveLength(0);
  });

  it("force-save reads resolution AT UNMOUNT (ref, not mount-time closure): mount unresolved → live page resolves with a real title → unmount force-saves the REAL title", async () => {
    // The test above mounts already-resolved, so the mount-time and unmount-time
    // resolution agree — it cannot tell the ref-read from a stale mount-time read.
    // Here the page mounts UNRESOLVED and only resolves afterward, so the cleanup
    // MUST observe the CURRENT resolution (`pageResolvedRef.current`, true) to save;
    // a stale mount-time `pageResolved` (false) would suppress the save and drop
    // the user's real title. This is the case that makes the ref load-bearing.
    const store = createStore();
    const { rerender, unmount } = render(
      tree(store, { title: null, pageResolved: false }),
    );
    const editor = await waitForEditor(store);

    // The live page resolves with the real title; the unfocused field applies it.
    act(() => {
      rerender(tree(store, { title: "Real Title", pageResolved: true }));
    });
    await waitFor(() => expect(editor.getText()).toBe("Real Title"));

    // Navigate away AFTER resolution: the ref reads `true`, so the force-save runs
    // and persists the REAL title (never "").
    unmount();

    expect(hoisted.updateTitle).toHaveBeenCalledTimes(1);
    expect(hoisted.updateTitle.mock.calls.at(-1)![0].title).toBe("Real Title");
    expect(erasingCalls()).toHaveLength(0);
  });

  it("mount-on-meta → autofocus is gated off → the live title is applied → navigate away never persists an empty title", async () => {
    const store = createStore();
    const { rerender, unmount } = render(
      tree(store, { title: null, pageResolved: false }),
    );

    // Autofocus is gated (pageResolved false): the field is NOT focused, so an
    // incoming live title can be applied by the setContent effect (a focused
    // field is skipped — the exact link in the erasure chain).
    const editor = await waitForEditor(store);
    expect(editor.isFocused).toBe(false);

    // The live title resolves; unfocused field → it is applied to the editor.
    act(() => {
      rerender(tree(store, { title: "Server Title", pageResolved: true }));
    });
    expect(editor.getText()).toBe("Server Title");

    // Navigate away: the force-save (now resolved) sees the REAL title, so it
    // never persists "".
    unmount();
    expect(erasingCalls()).toHaveLength(0);
  });

  it("guard — `saveTitle` treats an UNDEFINED title like null: a focused empty field never persists `title:\"\"` (defense-in-depth)", async () => {
    const store = createStore();
    store.set(currentPageEditModeAtom, PageEditMode.Edit);
    // The exact trap input: title === undefined (not null), resolved so the
    // force-save runs, and the field focused+empty (setContent skips a focused
    // field, so getText stays "").
    const { unmount } = render(
      tree(store, { title: undefined, pageResolved: true, editable: true }),
    );
    const editor = await waitForEditor(store);
    act(() => {
      editor.commands.focus();
    });
    expect(editor.getText()).toBe("");

    unmount();

    // The `title ?? null` normalization makes the empty-field guard bail exactly
    // as it does for null — the old `=== null`-only guard would have persisted "".
    expect(erasingCalls()).toHaveLength(0);
  });
});
