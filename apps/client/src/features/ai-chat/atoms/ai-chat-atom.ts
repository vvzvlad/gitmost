import { atom } from "jotai";
import { atomWithUiStorage } from "@/lib/jotai-helper.ts";

/**
 * Persisted floating AI chat window geometry (position + size). Held in
 * localStorage so a drag/resize survives a full page reload. `null` means
 * "never placed yet" — the window then computes an initial top-right placement.
 * On restore the value is clamped (position AND size) to the current viewport
 * (see AiChatWindow). `getOnInit` means the value is already in the atom on the
 * window's first open after reload, so it is no longer clobbered by the default.
 */
export type AiChatWindowGeom = {
  left: number;
  top: number;
  width: number;
  height: number;
};

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

// `null` is a LEGAL value ("never placed yet"): it must pass, not throw. Order
// matters — the null check comes before the object property reads.
export function isGeom(v: unknown): v is AiChatWindowGeom | null {
  if (v === null) return true;
  if (typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    isFiniteNumber(o.left) &&
    isFiniteNumber(o.top) &&
    isFiniteNumber(o.width) &&
    isFiniteNumber(o.height)
  );
}

export const aiChatWindowGeomAtom = atomWithUiStorage<AiChatWindowGeom | null>(
  "ai-chat-window-geom",
  null,
  isGeom,
);

const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";

/**
 * Whether the AI chat window is docked into the sidebar (page-tree navbar).
 * Persisted to localStorage so the docked/floating mode survives a full page
 * reload and close/reopen. `false` = the default floating window. When docked,
 * the SAME window instance pins itself to the live bounding rect of the app
 * navbar (see AiChatWindow), overlaying the page tree.
 */
export const aiChatWindowDockedAtom = atomWithUiStorage<boolean>(
  "ai-chat-window-docked",
  false,
  isBoolean,
);

/**
 * The currently selected chat id. `null` means a fresh (not-yet-created) chat:
 * the server creates the chat row on the first streamed message and echoes its
 * id, which the panel then adopts.
 */
// Note: declare via a cast default rather than `atom<string | null>(null)`,
// which mis-resolves the jotai useAtom overload to the read-only signature
// under this TS/jotai version (the setter would type as `never`).
// Deliberately NOT persisted: after a reload the window opens on a fresh, empty
// chat; the conversation is server-side and reachable via History.
export const activeAiChatIdAtom = atom(null as string | null);

/**
 * Persisted AI chat window chrome: open-state AND minimized-state in ONE key.
 * They MUST travel together — with cross-tab sync off, two keys let two tabs
 * split them into the impossible `{open:false, minimized:true}` (a bare
 * collapsed strip on next open). One object makes that structurally
 * unrepresentable. `getOnInit` so the open-state is honoured on first render.
 */
type AiChatWindowChrome = { open: boolean; minimized: boolean };

function isChrome(v: unknown): v is AiChatWindowChrome {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.open === "boolean" && typeof o.minimized === "boolean";
}

const aiChatWindowChromeAtom = atomWithUiStorage<AiChatWindowChrome>(
  "ai-chat-window-chrome:v1",
  { open: false, minimized: false },
  isChrome,
);

// Facade atoms: call sites keep their current boolean API — value OR functional
// updater. Same facade pattern as openTreeNodesAtom in open-tree-nodes-atom.ts.
// The functional form is NOT optional: toggleMinimize does `setMinimized(m => !m)`.
// A value-only setter would write the FUNCTION into the object; JSON.stringify
// drops it, the key degrades to `{"open":…}`, the validator then rejects the
// whole key and the window silently resets to defaults.
type Update<T> = T | ((prev: T) => T);
const applyUpdate = <T,>(u: Update<T>, prev: T): T =>
  typeof u === "function" ? (u as (p: T) => T)(prev) : u;

// Whether the floating AI chat window is open. Persisted (survives reload) via
// the shared chrome key above.
export const aiChatWindowOpenAtom = atom(
  (get) => get(aiChatWindowChromeAtom).open,
  (get, set, update: Update<boolean>) => {
    const prev = get(aiChatWindowChromeAtom);
    set(aiChatWindowChromeAtom, {
      ...prev,
      open: applyUpdate(update, prev.open),
    });
  },
);

// Whether the open window is collapsed into its header bar. Persisted via the
// shared chrome key so a restored-collapsed window stays collapsed.
export const aiChatWindowMinimizedAtom = atom(
  (get) => get(aiChatWindowChromeAtom).minimized,
  (get, set, update: Update<boolean>) => {
    const prev = get(aiChatWindowChromeAtom);
    set(aiChatWindowChromeAtom, {
      ...prev,
      minimized: applyUpdate(update, prev.minimized),
    });
  },
);

/**
 * The agent role selected for the NEXT new chat. `null` = "Universal assistant"
 * (no role). Consulted ONLY when creating a chat (its first message): the server
 * persists it to ai_chats.role_id and the role is immutable afterwards. Reset to
 * null when starting a new chat. It does NOT affect already-created chats.
 */
// Cast default for the same jotai overload reason as activeAiChatIdAtom above.
export const selectedAiRoleIdAtom = atom(null as string | null);

// The AI chat composer draft (text typed but not yet sent). Held here — OUTSIDE
// ChatThread — so it survives the thread remount that happens when a brand-new
// chat adopts its freshly created id after the first turn finishes. If it lived
// in ChatInput's local state, that remount would wipe text the user typed while
// the agent was still streaming. Reset on deliberate chat switches. Deliberately
// NOT persisted (an in-session value only).
export const aiChatDraftAtom = atom<string>("");
