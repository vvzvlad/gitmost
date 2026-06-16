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
