import { atomWithUiStorage } from "@/lib/jotai-helper.ts";
import { atom } from "jotai";

// Stable DOM id set on the app-shell navbar (<AppShell.Navbar>). Declared here —
// alongside the sidebar atoms — rather than in the chat window so the AI chat
// window can reference the navbar by id without importing the app shell (which
// would create a shell -> chat-window -> shell import cycle).
export const APP_NAVBAR_ID = "app-shell-navbar";

// Single source of truth for the navbar collapse breakpoint. The AppShell navbar
// `breakpoint` and BOTH burger toggles' `hiddenFrom`/`visibleFrom` MUST use this
// exact value: if they drift, the sidebar becomes unreachable on tablet widths
// (the round-1 regression of #292). Kept here so the shell and the header share
// one constant the compiler enforces, instead of three hand-synced string literals.
export const NAVBAR_COLLAPSE_BREAKPOINT = "md";

// Space-sidebar resize bounds. Single source of truth: BOTH resizers
// (global-app-shell.tsx, share-shell.tsx) AND the persisted-width validator must
// use these, or the validator becomes a third hand-synced copy of the numbers.
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 600;

export const mobileSidebarAtom = atom<boolean>(false);

const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";

// Persisted UI chrome: whether the desktop page-tree sidebar is shown.
export const desktopSidebarAtom = atomWithUiStorage<boolean>(
  "showSidebar",
  true,
  isBoolean,
);

export const desktopAsideAtom = atom<boolean>(false);

// Canonical right-panel tab identifiers. Single source of truth: the switch in
// aside.tsx, the aria-label ternary in global-app-shell.tsx, and the
// useToggleAside / useAsideTriggerProps call sites all key off these — and the
// persisted-state validator below reuses the same list, so it can never drift
// into a fifth hand-synced copy. "" is the closed/no-tab sentinel (a valid
// in-memory value but NOT a valid persisted `tab` — see isAsideState).
export const ASIDE_TABS = ["comments", "toc", "details"] as const;
export type AsideTab = (typeof ASIDE_TABS)[number] | "";
export type AsideStateType = {
  tab: AsideTab;
  isAsideOpen: boolean;
};

const ASIDE_TAB_SET: ReadonlySet<string> = new Set(ASIDE_TABS);

// Validator for the persisted aside state. `tab: ""` is deliberately REJECTED:
// `{tab:"", isAsideOpen:true}` would render a 420px panel with no header and no
// close button — a dead rectangle the user cannot dismiss. Anything invalid
// degrades to the closed default `{tab:"", isAsideOpen:false}`.
export function isAsideState(v: unknown): v is AsideStateType {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.isAsideOpen === "boolean" &&
    typeof o.tab === "string" &&
    ASIDE_TAB_SET.has(o.tab)
  );
}

// Persisted right-panel chrome (open-state + selected tab). Survives a full
// reload. The Open/Resolved inner tab, scroll position and comment draft are NOT
// part of this shape and keep resetting per session by design.
export const asideStateAtom = atomWithUiStorage<AsideStateType>(
  "asideState:v1",
  {
    tab: "",
    isAsideOpen: false,
  },
  isAsideState,
);

const isSidebarWidth = (v: unknown): v is number =>
  typeof v === "number" &&
  Number.isFinite(v) &&
  v >= SIDEBAR_MIN_WIDTH &&
  v <= SIDEBAR_MAX_WIDTH;

// Persisted UI chrome: the space-sidebar width. Note this now yields a `number`
// (the old helper returned the raw string) — both readers feed it into Mantine
// `rem()`, which is numerically inert to string-vs-number.
export const sidebarWidthAtom = atomWithUiStorage<number>(
  "sidebarWidth",
  300,
  isSidebarWidth,
);
