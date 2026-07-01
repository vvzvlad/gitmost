import { atomWithWebStorage } from "@/lib/jotai-helper.ts";
import { atom } from "jotai";

// Stable DOM id set on the app-shell navbar (<AppShell.Navbar>). Declared here —
// alongside the sidebar atoms — rather than in the chat window so the AI chat
// window can reference the navbar by id without importing the app shell (which
// would create a shell -> chat-window -> shell import cycle).
export const APP_NAVBAR_ID = "app-shell-navbar";

export const mobileSidebarAtom = atom<boolean>(false);

export const desktopSidebarAtom = atomWithWebStorage<boolean>(
  "showSidebar",
  true,
);

export const desktopAsideAtom = atom<boolean>(false);

// Valid `tab` values: "" | "comments" | "toc" | "details"
type AsideStateType = {
  tab: string;
  isAsideOpen: boolean;
};

export const asideStateAtom = atom<AsideStateType>({
  tab: "",
  isAsideOpen: false,
});

export const sidebarWidthAtom = atomWithWebStorage<number>('sidebarWidth', 300);