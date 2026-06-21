// TTL for the cached spaceHasRestrictions verdict (see WsService). This cache is
// a read-side fast path: while it is `false`, emitTreeEvent/emitCommentEvent
// broadcast page-bearing payloads to the WHOLE space room. If a space gains its
// first restriction (or loses its last one), the verdict goes stale for up to
// this TTL, during which a title/icon-bearing payload could fan out to
// now-unauthorized sockets. The proper fix is to call
// WsService.invalidateSpaceRestrictionCache(spaceId) from the restriction
// mutation path — but on this branch no such mutation path exists yet (the
// page-permission repo mutators have zero callers), so there is nothing to wire
// the invalidation to. As the documented fallback, the TTL is kept short (3s)
// to bound the worst-case leak window until that endpoint lands and the
// invalidation can be wired directly.
export const WS_CACHE_TTL_MS = 3_000;
export const WS_SPACE_RESTRICTION_CACHE_PREFIX = 'ws:space-restrictions:';

export function getSpaceRoomName(spaceId: string): string {
  return `space-${spaceId}`;
}

export function getUserRoomName(userId: string): string {
  return `user-${userId}`;
}
