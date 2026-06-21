import { atom } from "jotai";

/**
 * The currently selected chat id. `null` means a fresh (not-yet-created) chat:
 * the server creates the chat row on the first streamed message and echoes its
 * id, which the panel then adopts.
 */
// Note: declare via a cast default rather than `atom<string | null>(null)`,
// which mis-resolves the jotai useAtom overload to the read-only signature
// under this TS/jotai version (the setter would type as `never`).
export const activeAiChatIdAtom = atom(null as string | null);

// Whether the floating AI chat window is open. Non-persistent (resets per session).
export const aiChatWindowOpenAtom = atom<boolean>(false);

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
// the agent was still streaming. Reset on deliberate chat switches.
export const aiChatDraftAtom = atom<string>("");
