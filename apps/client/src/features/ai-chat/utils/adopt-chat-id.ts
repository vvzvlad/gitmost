/**
 * Pure helpers for adopting a brand-new chat's authoritative server id.
 *
 * PRIMARY path: the server streams the real chat id on the assistant message
 * metadata (see `chatStreamStartMetadata` server-side); `resolveAdoptedChatId`
 * turns that into the id to adopt for a new chat.
 *
 * FALLBACK path (only when a new chat's first turn errors BEFORE the `start`
 * chunk, so no metadata id ever reached the client): adopt the single chat that
 * NEWLY appeared in the per-user list relative to a pre-refetch snapshot —
 * `pickNewlyCreatedChatId`. This is unambiguous and does not race a second tab
 * the way the old "newest chat in the list" guess did (#137).
 */

/**
 * Resolve the id to adopt from the server-streamed metadata. Returns
 * `serverChatId` only for a brand-new chat (`activeChatId === null`) that
 * received a truthy id; otherwise null (existing chat, or no id streamed).
 */
export function resolveAdoptedChatId(
  activeChatId: string | null,
  serverChatId: string | null | undefined,
): string | null {
  return activeChatId === null && serverChatId ? serverChatId : null;
}

/**
 * Return the single id present in `afterIds` but not in `beforeIds`. Returns
 * null when zero or more-than-one such id exists (ambiguous — do not adopt).
 */
export function pickNewlyCreatedChatId(
  beforeIds: readonly string[],
  afterIds: readonly string[],
): string | null {
  const before = new Set(beforeIds);
  // Dedupe the new ids: a paginated/flatMapped list can repeat the same id, and
  // one genuinely-new chat must not read as "ambiguous" (>1) from a duplicate.
  const added = new Set(afterIds.filter((id) => !before.has(id)));
  return added.size === 1 ? [...added][0] : null;
}
