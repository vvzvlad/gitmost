/**
 * Pure transitions for the AI-chat thread's identity: the single source of
 * truth tying ChatThread's mount key to the chat id that mounted thread holds.
 *
 * The window keeps exactly ONE of these in state. Consolidating the mount key
 * and the live thread's chat id into one atomic value makes the "stale chat id
 * vs key" state unrepresentable: every change goes through one of the explicit
 * transitions below, so the key and chatId can never silently diverge.
 *
 * - `newThread`/`switchThread` produce a key that forces a remount (+ reseed):
 *   `newThread` for a brand-new (id-less) chat, `switchThread` for an existing
 *   one. The caller picks which based on whether there is a chat id.
 * - `adoptThread` keeps the SAME key so a brand-new chat learns its real id
 *   WITHOUT remounting (the live useChat store, holding the just-finished turn,
 *   is preserved and the next turn sends the real chatId).
 *
 * `newThread` takes the session key from the impure `generateId()` at the call
 * site so these stay pure and unit-testable.
 */
export type ThreadIdentity = { key: string; chatId: string | null };

/**
 * A brand-new chat: a fresh session key and no chat id yet. `newKey` is
 * supplied by the caller (generateId() is impure) so this stays pure/testable.
 */
export function newThread(newKey: string): ThreadIdentity {
  return { key: newKey, chatId: null };
}

/**
 * Switch to an EXISTING chat: the mount key becomes the chat id, forcing a
 * remount + reseed from the persisted history. (A switch to a brand-new chat
 * goes through `newThread` instead — there is no id to key on.)
 */
export function switchThread(chatId: string): ThreadIdentity {
  return { key: chatId, chatId };
}

/**
 * In-place adoption: a brand-new chat (`prev.chatId === null`) learns its real
 * id WITHOUT remounting — keep the SAME key, set the chat id. If `prev` already
 * has a chatId (not a new chat), this is a no-op (returns `prev`): adoption only
 * applies to an as-yet-unadopted new thread.
 */
export function adoptThread(prev: ThreadIdentity, chatId: string): ThreadIdentity {
  return prev.chatId === null ? { key: prev.key, chatId } : prev;
}

/**
 * Thread-identity transitions as a reducer action. See `threadSessionReducer`.
 */
export type ThreadSessionAction =
  | { type: "reconcile"; chatId: string | null; newKey: string }
  | { type: "adopt"; chatId: string };

/**
 * Single source of truth for thread-identity transitions. `reconcile` handles a
 * genuine switch (user OR external atom write) -> remount; `adopt` moves a brand-
 * new chat to its real id in place (no remount).
 */
export function threadSessionReducer(
  state: ThreadIdentity,
  action: ThreadSessionAction,
): ThreadIdentity {
  switch (action.type) {
    case "reconcile":
      return action.chatId === null
        ? newThread(action.newKey)
        : switchThread(action.chatId);
    case "adopt":
      return adoptThread(state, action.chatId);
  }
}
