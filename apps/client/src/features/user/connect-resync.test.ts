import { describe, it, expect, vi } from "vitest";
import {
  makeConnectHandler,
  shouldResyncOnConnect,
  ROOT_SIDEBAR_PAGES_KEY,
  SIDEBAR_PAGES_KEY,
} from "./connect-resync";

describe("shouldResyncOnConnect", () => {
  it("does not resync on the first connect", () => {
    expect(shouldResyncOnConnect(true)).toBe(false);
  });

  it("resyncs on a reconnect (not the first connect)", () => {
    expect(shouldResyncOnConnect(false)).toBe(true);
  });
});

describe("makeConnectHandler", () => {
  it("does NOT invalidate on the first connect", () => {
    const invalidateQueries = vi.fn();
    const handler = makeConnectHandler({ invalidateQueries });

    handler();

    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it("invalidates BOTH sidebar keys on the reconnect (second connect)", () => {
    const invalidateQueries = vi.fn();
    const handler = makeConnectHandler({ invalidateQueries });

    // First connect: the initial connection, no resync.
    handler();
    expect(invalidateQueries).not.toHaveBeenCalled();

    // Second connect: a reconnect after a gap, resync both tree levels.
    handler();

    expect(invalidateQueries).toHaveBeenCalledTimes(2);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: [...ROOT_SIDEBAR_PAGES_KEY],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: [...SIDEBAR_PAGES_KEY],
    });
  });

  it("keeps invalidating on every subsequent reconnect", () => {
    const invalidateQueries = vi.fn();
    const handler = makeConnectHandler({ invalidateQueries });

    handler(); // first connect -> nothing
    handler(); // reconnect #1 -> 2 calls
    handler(); // reconnect #2 -> 2 more calls

    expect(invalidateQueries).toHaveBeenCalledTimes(4);
  });

  it("isolates state per handler instance (each factory call gets its own flag)", () => {
    const invalidateA = vi.fn();
    const invalidateB = vi.fn();
    const handlerA = makeConnectHandler({ invalidateQueries: invalidateA });
    const handlerB = makeConnectHandler({ invalidateQueries: invalidateB });

    // Exhausting handlerA's first connect must not affect handlerB.
    handlerA();
    handlerA(); // reconnect on A
    handlerB(); // still A's-independent first connect on B

    expect(invalidateA).toHaveBeenCalledTimes(2);
    expect(invalidateB).not.toHaveBeenCalled();
  });
});
