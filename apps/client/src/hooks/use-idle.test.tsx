import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useIdle } from "./use-idle";

/**
 * F5(a): `resetIdle` is a dependency of page-editor's socket connect/disconnect
 * effect. Declared inline it changed identity on every render, re-running that
 * effect on every render — which is how a level-triggered `socket.connect()`
 * turned into a reconnect storm.
 */
describe("useIdle", () => {
  it("keeps a stable resetIdle identity across re-renders", () => {
    const { result, rerender } = renderHook(() =>
      useIdle(1000, { initialState: false }),
    );

    const first = result.current.resetIdle;
    rerender();
    rerender();

    expect(result.current.resetIdle).toBe(first);
  });

  it("returns a new resetIdle when the timeout changes", () => {
    const { result, rerender } = renderHook(
      ({ timeout }) => useIdle(timeout, { initialState: false }),
      { initialProps: { timeout: 1000 } },
    );

    const first = result.current.resetIdle;
    rerender({ timeout: 2000 });

    expect(result.current.resetIdle).not.toBe(first);
  });
});
