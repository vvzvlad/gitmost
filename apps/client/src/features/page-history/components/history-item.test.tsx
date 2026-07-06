import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

// Mantine Tooltip mounts its label lazily on hover via Floating UI, which is
// flaky under jsdom. Replace ONLY the Tooltip with a thin wrapper that renders
// the label inline (keeping Badge/Switch/etc. real), so the provenance label —
// the contract we care about — is deterministically queryable.
vi.mock("@mantine/core", async () => {
  const actual =
    await vi.importActual<typeof import("@mantine/core")>("@mantine/core");
  const Tooltip = ({
    label,
    children,
  }: {
    label?: React.ReactNode;
    children?: React.ReactNode;
  }) => (
    <>
      {children}
      <span data-testid="tooltip-label">{label}</span>
    </>
  );
  Tooltip.Group = ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  );
  return { ...actual, Tooltip };
});

// jsdom lacks matchMedia, which MantineProvider's color-scheme hook needs.
beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList;
  }
});

// --- Mocks for the heavy / networked module graph ---------------------------
// HistoryItem pulls in i18n, jotai atoms (ai-chat / history), a config-backed
// avatar and a time formatter. The provenance-badge contract is the unit under
// test, so we stub everything else down to inert, deterministic renders and
// keep the real Mantine Badge/Tooltip so role/label queries are meaningful.

// i18n: interpolate {{name}} so the git-sync tooltip carries the author name,
// letting us assert provenance attribution without a real i18n backend.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars && typeof vars.name !== "undefined"
        ? key.replace("{{name}}", String(vars.name))
        : key,
  }),
}));

// jotai setters: the badges call useSetAtom; return inert setters so a click on
// the (deep-linkable) AiAgentBadge would fire these — proving the git-sync badge
// does NOT wire any of them.
const setAiChatWindowOpen = vi.fn();
const setActiveChatId = vi.fn();
const setDraft = vi.fn();
const setHistoryModalOpen = vi.fn();
vi.mock("jotai", async () => {
  const actual = await vi.importActual<typeof import("jotai")>("jotai");
  return {
    ...actual,
    useSetAtom: (atom: unknown) => {
      switch (atom) {
        case aiChatWindowOpenAtom:
          return setAiChatWindowOpen;
        case activeAiChatIdAtom:
          return setActiveChatId;
        case aiChatDraftAtom:
          return setDraft;
        case historyAtoms:
          return setHistoryModalOpen;
        default:
          return vi.fn();
      }
    },
  };
});

// Atoms are imported only as identity tokens for the useSetAtom switch above.
vi.mock("@/features/ai-chat/atoms/ai-chat-atom.ts", () => ({
  activeAiChatIdAtom: { __tag: "activeAiChatIdAtom" },
  aiChatWindowOpenAtom: { __tag: "aiChatWindowOpenAtom" },
  aiChatDraftAtom: { __tag: "aiChatDraftAtom" },
}));
vi.mock("@/features/page-history/atoms/history-atoms.ts", () => ({
  historyAtoms: { __tag: "historyAtoms" },
}));

// Avatar reaches into config (getAvatarUrl) — stub to a plain element.
vi.mock("@/components/ui/custom-avatar.tsx", () => ({
  CustomAvatar: ({ name }: { name?: string }) => (
    <span data-testid="avatar">{name}</span>
  ),
}));

// Deterministic, locale-free date string.
vi.mock("@/lib/time", () => ({
  formattedDate: () => "2026-06-21",
}));

import HistoryItem from "./history-item";
import {
  activeAiChatIdAtom,
  aiChatWindowOpenAtom,
  aiChatDraftAtom,
} from "@/features/ai-chat/atoms/ai-chat-atom.ts";
import { historyAtoms } from "@/features/page-history/atoms/history-atoms.ts";
import type { IPageHistory } from "@/features/page-history/types/page.types";

function makeItem(overrides: Partial<IPageHistory> = {}): IPageHistory {
  return {
    id: "h1",
    pageId: "p1",
    title: "Title",
    slug: "slug",
    icon: "",
    coverPhoto: "",
    version: 1,
    lastUpdatedById: "u1",
    workspaceId: "w1",
    createdAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:00.000Z",
    lastUpdatedBy: { id: "u1", name: "Alice", avatarUrl: "" },
    ...overrides,
  };
}

function renderItem(item: IPageHistory) {
  return render(
    <MantineProvider>
      <HistoryItem
        historyItem={item}
        index={0}
        onSelect={vi.fn()}
        isActive={false}
      />
    </MantineProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("HistoryItem git-sync provenance badge", () => {
  // Test 1: the git-sync badge renders ONLY for lastUpdatedSource === 'git-sync'.
  it("renders the Git sync badge only when lastUpdatedSource is 'git-sync'", () => {
    renderItem(makeItem({ lastUpdatedSource: "git-sync" }));
    expect(screen.getByText("Git sync")).toBeTruthy();
  });

  it.each([
    ["agent", "agent"],
    ["user", "user"],
    ["undefined", undefined],
  ])(
    "does NOT render the Git sync badge when lastUpdatedSource is %s",
    (_label, source) => {
      renderItem(makeItem({ lastUpdatedSource: source }));
      expect(screen.queryByText("Git sync")).toBeNull();
    },
  );

  // Test 2: provenance attribution + the git-sync badge is NOT interactive.
  it("attributes the git-sync provenance to the correct author and is not clickable", () => {
    renderItem(
      makeItem({
        lastUpdatedSource: "git-sync",
        lastUpdatedBy: { id: "u2", name: "Bob", avatarUrl: "" },
      }),
    );

    const badge = screen.getByText("Git sync");

    // Provenance attribution: the tooltip label carries the author name (the
    // git-sync badge passes authorName -> "Synced from Git on behalf of {{name}}").
    expect(screen.getByText("Synced from Git on behalf of Bob")).toBeTruthy();

    // The git-sync badge must NOT behave like AiAgentBadge: the badge element
    // itself is not a button, carries no role=button and no tabIndex, and
    // clicking it must not trigger any ai-chat deep-link. (The surrounding
    // history-row IS an UnstyledButton — that is the row's own select affordance,
    // not the badge — so we scope these checks to the badge element.)
    const badgeRoot = (badge.closest("[class*='mantine-Badge-root']") ??
      badge) as HTMLElement;
    expect(badgeRoot.getAttribute("role")).not.toBe("button");
    expect(badgeRoot.getAttribute("tabindex")).toBeNull();
    expect(badgeRoot.tagName.toLowerCase()).not.toBe("button");
    // No interactive descendant button lives inside the badge itself.
    expect(within(badgeRoot).queryByRole("button")).toBeNull();

    badgeRoot.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(setActiveChatId).not.toHaveBeenCalled();
    expect(setAiChatWindowOpen).not.toHaveBeenCalled();
    expect(setDraft).not.toHaveBeenCalled();
    expect(setHistoryModalOpen).not.toHaveBeenCalled();
  });

  // Sanity contrast: the agent provenance IS interactive when it carries an
  // aiChatId — proving the not-clickable assertion above is real. The old text
  // `AiAgentBadge` was superseded by `AgentAvatarStack` (#300), which becomes a
  // role=button deep-link (and fires the ai-chat atoms) when an aiChatId is present.
  it("contrast: the agent stack is a deep-link button when it has an aiChatId", () => {
    renderItem(
      makeItem({
        lastUpdatedSource: "agent",
        agent: { name: "Zeta" },
        lastUpdatedAiChatId: "chat-1",
      }),
    );
    // The agent glyph lives inside the clickable stack; walk up to its role=button.
    const root = screen.getByTestId("agent-glyph").closest("[role='button']");
    expect(root).not.toBeNull();
    (root as HTMLElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    expect(setActiveChatId).toHaveBeenCalledWith("chat-1");
    expect(setAiChatWindowOpen).toHaveBeenCalled();
  });
});
