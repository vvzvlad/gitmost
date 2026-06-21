import type { QueryClient } from "@tanstack/react-query";

// Sidebar tree query keys that must be refetched (through the authorized API)
// after a socket reconnect so the view re-converges after a gap where ws events
// were missed (wifi blip, laptop sleep). Both the root level and the
// nested-page levels of every space tree are invalidated.
export const ROOT_SIDEBAR_PAGES_KEY = ["root-sidebar-pages"] as const;
export const SIDEBAR_PAGES_KEY = ["sidebar-pages"] as const;

/**
 * Pure decision for the reconnect-resync branch.
 *
 * The first `connect` event is the initial connection and must NOT trigger a
 * resync (the data was just fetched). Every subsequent `connect` event is a
 * RECONNECT after a gap and should trigger a resync.
 */
export function shouldResyncOnConnect(isFirstConnect: boolean): boolean {
  return !isFirstConnect;
}

/**
 * Build the socket `connect` handler that owns the first-connect-vs-reconnect
 * logic via a private closure flag. The returned handler is what the component
 * registers with `socket.on("connect", ...)`.
 *
 * - 1st invocation  -> first connect, no invalidation.
 * - 2nd+ invocation -> reconnect, invalidate both sidebar tree key levels.
 */
export function makeConnectHandler(
  queryClient: Pick<QueryClient, "invalidateQueries">,
): () => void {
  let firstConnect = true;

  return () => {
    if (shouldResyncOnConnect(firstConnect)) {
      queryClient.invalidateQueries({ queryKey: [...ROOT_SIDEBAR_PAGES_KEY] });
      queryClient.invalidateQueries({ queryKey: [...SIDEBAR_PAGES_KEY] });
    }
    firstConnect = false;
  };
}
