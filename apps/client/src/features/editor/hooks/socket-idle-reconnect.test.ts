import { describe, it, expect } from "vitest";
import { WebSocketStatus } from "@hocuspocus/provider";
import { decideSocketIdleAction } from "./socket-idle-reconnect";

/**
 * F5(b): the connect branch must be EDGE-triggered. A level-triggered
 * `socket.connect()` (fire whenever `visible && disconnected`) cancels
 * Hocuspocus's in-flight retryer and restarts it with `initialDelay: 0`,
 * discarding the 1s→30s backoff ladder — a reconnect storm against a failing
 * endpoint, worst in WebKit which fails a WebSocket fast and does not throttle.
 */
describe("decideSocketIdleAction", () => {
  it("disconnects when idle and hidden while connected", () => {
    expect(
      decideSocketIdleAction({
        isIdle: true,
        documentState: "hidden",
        status: WebSocketStatus.Connected,
        idleDisconnected: false,
      }),
    ).toBe("disconnect");
  });

  it("reconnects once after our own idle disconnect, then stops", () => {
    // The tab comes back after we disconnected it for being idle+hidden.
    expect(
      decideSocketIdleAction({
        isIdle: false,
        documentState: "visible",
        status: WebSocketStatus.Disconnected,
        idleDisconnected: true,
      }),
    ).toBe("connect");

    // The caller clears the flag when it acts, so every further render with
    // the exact same (still-disconnected) condition is a no-op.
    expect(
      decideSocketIdleAction({
        isIdle: false,
        documentState: "visible",
        status: WebSocketStatus.Disconnected,
        idleDisconnected: false,
      }),
    ).toBe("none");
  });

  it("leaves an ordinary connection failure to Hocuspocus's retryer", () => {
    expect(
      decideSocketIdleAction({
        isIdle: false,
        documentState: "visible",
        status: WebSocketStatus.Disconnected,
        idleDisconnected: false,
      }),
    ).toBe("none");
    expect(
      decideSocketIdleAction({
        isIdle: false,
        documentState: "visible",
        status: WebSocketStatus.Connecting,
        idleDisconnected: true,
      }),
    ).toBe("none");
  });

  it("does not disconnect a hidden tab that is not idle yet", () => {
    expect(
      decideSocketIdleAction({
        isIdle: false,
        documentState: "hidden",
        status: WebSocketStatus.Connected,
        idleDisconnected: false,
      }),
    ).toBe("none");
  });
});
