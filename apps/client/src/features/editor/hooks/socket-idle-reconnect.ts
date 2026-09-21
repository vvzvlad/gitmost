import { WebSocketStatus } from "@hocuspocus/provider";

export type SocketIdleAction = "disconnect" | "connect" | "none";

export interface SocketIdleInput {
  isIdle: boolean;
  documentState: DocumentVisibilityState | string;
  /** `yjsConnectionStatusAtom` is typed as a plain string, hence the union. */
  status: WebSocketStatus | string;
  /** True when the *previous* disconnect was ours (the idle+hidden one). */
  idleDisconnected: boolean;
}

/**
 * Decide what to do with the collaboration socket for the current
 * idle/visibility/connection combination.
 *
 * The connect branch is EDGE-triggered on purpose: it only fires when WE
 * disconnected the socket for being idle+hidden and the tab came back. It is
 * not a general "reconnect whenever disconnected" rule, because
 * `HocuspocusProviderWebsocket.connect()` cancels the in-flight retryer and
 * starts a fresh one with `initialDelay: 0` — calling it on a level condition
 * (every render while `visible && disconnected` holds) throws away the
 * library's 1s→30s exponential ladder and reconnects as fast as the browser
 * can fail a WebSocket. WebKit fails/closes a WS much faster than Blink and
 * does not throttle repeated failures per origin, which is how this became a
 * Safari CPU burn. Ordinary connection failures are Hocuspocus's own retryer's
 * job.
 */
export function decideSocketIdleAction({
  isIdle,
  documentState,
  status,
  idleDisconnected,
}: SocketIdleInput): SocketIdleAction {
  if (
    isIdle &&
    documentState === "hidden" &&
    status === WebSocketStatus.Connected
  ) {
    return "disconnect";
  }
  if (
    idleDisconnected &&
    documentState === "visible" &&
    status === WebSocketStatus.Disconnected
  ) {
    return "connect";
  }
  return "none";
}
