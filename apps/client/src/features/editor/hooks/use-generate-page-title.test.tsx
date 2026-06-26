import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider, createStore } from "jotai";
import type { Editor } from "@tiptap/core";
import {
  pageEditorAtom,
  titleEditorAtom,
} from "@/features/editor/atoms/editor-atoms.ts";

// --- Mocks for the hook's collaborators ---------------------------------------

const generatePageTitleMock = vi.fn();
vi.mock("@/features/ai-chat/services/ai-chat-service.ts", () => ({
  generatePageTitle: (content: string) => generatePageTitleMock(content),
}));

const updateTitleMock = vi.fn();
const updatePageDataMock = vi.fn();
vi.mock("@/features/page/queries/page-query.ts", () => ({
  useUpdateTitlePageMutation: () => ({ mutateAsync: updateTitleMock }),
  updatePageData: (page: unknown) => updatePageDataMock(page),
}));

const emitMock = vi.fn();
vi.mock("@/features/websocket/use-query-emit.ts", () => ({
  useQueryEmit: () => emitMock,
}));

const localEmitMock = vi.fn();
vi.mock("@/lib/local-emitter.ts", () => ({
  default: { emit: (...args: unknown[]) => localEmitMock(...args) },
}));

// htmlToMarkdown just echoes the editor HTML so each test controls the markdown
// purely via the fake page editor's getHTML().
vi.mock("@docmost/editor-ext", () => ({
  htmlToMarkdown: (html: string) => html,
}));

const notificationsShowMock = vi.fn();
vi.mock("@mantine/notifications", () => ({
  notifications: { show: (opts: unknown) => notificationsShowMock(opts) },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// Import after mocks are registered.
import { useGeneratePageTitle } from "./use-generate-page-title.ts";

// --- Test helpers -------------------------------------------------------------

function makePageEditor(pageId: string, html = "<p>content</p>"): Editor {
  return {
    isDestroyed: false,
    getHTML: () => html,
    storage: { pageId },
  } as unknown as Editor;
}

function makeTitleEditor(): Editor & {
  commands: { setContent: ReturnType<typeof vi.fn> };
} {
  return {
    isDestroyed: false,
    isFocused: false,
    commands: { setContent: vi.fn() },
  } as unknown as Editor & {
    commands: { setContent: ReturnType<typeof vi.fn> };
  };
}

function setup(pageId: string, store = createStore()) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <Provider store={store}>{children}</Provider>
    </QueryClientProvider>
  );
  const { result } = renderHook(() => useGeneratePageTitle(pageId), {
    wrapper,
  });
  return { result, store };
}

const PAGE_A = {
  id: "pageA",
  title: "Generated Title",
  spaceId: "space1",
  slugId: "slugA",
  parentPageId: null,
  icon: null,
} as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useGeneratePageTitle", () => {
  it("shows a notice and bails when the editor content is empty", async () => {
    const store = createStore();
    store.set(pageEditorAtom as never, makePageEditor("pageA", "   "));
    store.set(titleEditorAtom as never, makeTitleEditor());
    const { result } = setup("pageA", store);

    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(notificationsShowMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: "The note is empty", color: "yellow" }),
    );
    expect(generatePageTitleMock).not.toHaveBeenCalled();
    expect(updateTitleMock).not.toHaveBeenCalled();
  });

  it("leaves the title untouched when the model returns nothing usable", async () => {
    const store = createStore();
    store.set(pageEditorAtom as never, makePageEditor("pageA"));
    store.set(titleEditorAtom as never, makeTitleEditor());
    generatePageTitleMock.mockResolvedValue("   ");
    const { result } = setup("pageA", store);

    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(updateTitleMock).not.toHaveBeenCalled();
    expect(notificationsShowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Could not generate a title",
        color: "yellow",
      }),
    );
  });

  it("happy path: applies the title, refreshes cache, writes the field, broadcasts", async () => {
    const store = createStore();
    const titleEditor = makeTitleEditor();
    store.set(pageEditorAtom as never, makePageEditor("pageA"));
    store.set(titleEditorAtom as never, titleEditor);
    generatePageTitleMock.mockResolvedValue("Generated Title");
    updateTitleMock.mockResolvedValue(PAGE_A);
    const { result } = setup("pageA", store);

    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(updateTitleMock).toHaveBeenCalledWith({
      pageId: "pageA",
      title: "Generated Title",
    });
    expect(updatePageDataMock).toHaveBeenCalledWith(PAGE_A);
    expect(titleEditor.commands.setContent).toHaveBeenCalledWith(
      "Generated Title",
    );
    expect(localEmitMock).toHaveBeenCalled();
    expect(emitMock).toHaveBeenCalled();
    expect(notificationsShowMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Title generated" }),
    );
  });

  it("does NOT write the visible title field when the user navigated away during generation", async () => {
    const store = createStore();
    const titleEditor = makeTitleEditor(); // persistent across navigation
    store.set(pageEditorAtom as never, makePageEditor("pageA"));
    store.set(titleEditorAtom as never, titleEditor);

    // Control when generation resolves so we can navigate mid-flight.
    let resolveTitle!: (t: string) => void;
    generatePageTitleMock.mockReturnValue(
      new Promise<string>((res) => {
        resolveTitle = res;
      }),
    );
    updateTitleMock.mockResolvedValue(PAGE_A);
    const { result } = setup("pageA", store);

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.mutateAsync();
    });

    // User navigates to page B: the live page editor now belongs to pageB.
    act(() => {
      store.set(pageEditorAtom as never, makePageEditor("pageB"));
    });

    await act(async () => {
      resolveTitle("Generated Title");
      await pending;
    });

    // DB write is still correct (keyed by the captured pageId)...
    expect(updateTitleMock).toHaveBeenCalledWith({
      pageId: "pageA",
      title: "Generated Title",
    });
    // ...but we must NOT stamp page A's title into page B's visible field.
    expect(titleEditor.commands.setContent).not.toHaveBeenCalled();
    // The change is still broadcast to other clients.
    expect(emitMock).toHaveBeenCalled();
  });

  it("does NOT write the visible title field when the title editor is focused", async () => {
    const store = createStore();
    const titleEditor = makeTitleEditor();
    store.set(pageEditorAtom as never, makePageEditor("pageA"));
    store.set(titleEditorAtom as never, titleEditor);

    // Resolve generation under our control so we can mark the live title editor
    // as focused before the post-generation write runs.
    let resolveTitle!: (t: string) => void;
    generatePageTitleMock.mockReturnValue(
      new Promise<string>((res) => {
        resolveTitle = res;
      }),
    );
    updateTitleMock.mockResolvedValue(PAGE_A);
    const { result } = setup("pageA", store);

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.mutateAsync();
    });

    // The user clicked into the title field while the model ran — overwriting it
    // now would clobber what they are actively typing.
    act(() => {
      (titleEditor as { isFocused: boolean }).isFocused = true;
    });

    await act(async () => {
      resolveTitle("Generated Title");
      await pending;
    });

    // The DB write still persists the value...
    expect(updateTitleMock).toHaveBeenCalledWith({
      pageId: "pageA",
      title: "Generated Title",
    });
    expect(updatePageDataMock).toHaveBeenCalledWith(PAGE_A);
    // ...but the visible field is left alone while it is focused.
    expect(titleEditor.commands.setContent).not.toHaveBeenCalled();
    // The change is still broadcast to other clients.
    expect(localEmitMock).toHaveBeenCalled();
    expect(emitMock).toHaveBeenCalled();
  });

  it("bails before calling the model when the page editor is destroyed", async () => {
    const store = createStore();
    const pageEditor = makePageEditor("pageA");
    (pageEditor as { isDestroyed: boolean }).isDestroyed = true;
    store.set(pageEditorAtom as never, pageEditor);
    store.set(titleEditorAtom as never, makeTitleEditor());
    const { result } = setup("pageA", store);

    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(generatePageTitleMock).not.toHaveBeenCalled();
    expect(updateTitleMock).not.toHaveBeenCalled();
  });

  it.each([
    [403, "AI title generation is disabled"],
    [503, "AI is not configured"],
    [429, "Too many requests, please try again later"],
    [500, "Failed to generate title"],
  ])("maps HTTP %s onError to a friendly message", async (status, message) => {
    const store = createStore();
    store.set(pageEditorAtom as never, makePageEditor("pageA"));
    store.set(titleEditorAtom as never, makeTitleEditor());
    generatePageTitleMock.mockRejectedValue({ response: { status } });
    const { result } = setup("pageA", store);

    await act(async () => {
      await expect(result.current.mutateAsync()).rejects.toBeTruthy();
    });

    expect(notificationsShowMock).toHaveBeenCalledWith(
      expect.objectContaining({ message, color: "red" }),
    );
  });
});
