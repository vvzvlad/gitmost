import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import { useEditorScroll } from "./use-editor-scroll";

/**
 * `waitForState` inside this hook used to be an unbounded `setInterval`: if the
 * `canScroll` predicate never turned true, the interval polled for the life of
 * the tab, and a fresh one leaked on every editor construction (the hook is
 * driven from the editor's `onCreate`, and `handleScrollTo` recurses up to ten
 * times). It is now a two-timer FSM — a poll interval plus its own deadline —
 * and these tests pin the observable contract of that FSM: every exit path
 * clears BOTH timers, a give-up is announced once and does not recurse.
 *
 * Assertions are on observable effects only: how often the predicate is polled,
 * whether the DOM lookup happened, the warn spy, and the live timer count.
 */

const WAIT_INTERVAL_MS = 800;
const WAIT_TIMEOUT_MS = 5000;

type FakeEditor = {
  view: { dom: { querySelector: ReturnType<typeof vi.fn> } };
};

function makeEditor(found: boolean) {
  const scrollIntoView = vi.fn();
  const target = found ? ({ scrollIntoView } as unknown as Element) : null;
  const querySelector = vi.fn(() => target);
  const editor = { view: { dom: { querySelector } } } as FakeEditor;
  return { editor, querySelector, scrollIntoView };
}

describe("useEditorScroll — waitForState deadline", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const mount = (canScroll: () => boolean, initialScrollTo = "target-id") =>
    renderHook(() => useEditorScroll({ canScroll, initialScrollTo })).result
      .current.handleScrollTo;

  it("returns immediately without waiting when there is no scroll target", async () => {
    const canScroll = vi.fn(() => true);
    const { editor, querySelector } = makeEditor(true);
    // No hash and no initialScrollTo — the common case on every editor open.
    const handleScrollTo = mount(canScroll, "");

    await expect(handleScrollTo(editor as any)).resolves.toBe(false);

    // Not a single poll, not a single timer, nothing logged: the wait is skipped
    // entirely rather than burning an 800ms cycle per editor construction.
    expect(canScroll).not.toHaveBeenCalled();
    expect(querySelector).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(WAIT_TIMEOUT_MS * 2);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("resolves true when the predicate is satisfied and clears the deadline", async () => {
    const canScroll = vi.fn(() => true);
    const { editor, querySelector, scrollIntoView } = makeEditor(true);
    const handleScrollTo = mount(canScroll);

    const pending = handleScrollTo(editor as any);
    await vi.advanceTimersByTimeAsync(WAIT_INTERVAL_MS);

    await expect(pending).resolves.toBe(true);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(querySelector).toHaveBeenCalledTimes(1);

    // The deadline timer was cleared with the interval: nothing is left armed,
    // and pushing the clock well past the timeout produces no give-up warning.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(WAIT_TIMEOUT_MS * 4);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(canScroll).toHaveBeenCalledTimes(1);
  });

  it("gives up once at the deadline, stops polling, and does not recurse", async () => {
    const canScroll = vi.fn(() => false);
    const { editor, querySelector } = makeEditor(true);
    const handleScrollTo = mount(canScroll);

    const pending = handleScrollTo(editor as any);
    await vi.advanceTimersByTimeAsync(WAIT_TIMEOUT_MS);

    await expect(pending).resolves.toBe(false);

    // Exactly one greppable warning, naming the reason.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain("[editor-scroll]");

    // The interval was cleared: the predicate is not polled again, no timer is
    // left running, and the recursive retry path never started (the editor DOM
    // was never queried).
    const pollsAtDeadline = canScroll.mock.calls.length;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(WAIT_TIMEOUT_MS * 10);
    expect(canScroll).toHaveBeenCalledTimes(pollsAtDeadline);
    expect(querySelector).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not resolve twice when the predicate turns true on the deadline tick", async () => {
    // 5000ms is an exact multiple of the 800ms poll only in the sense that the
    // deadline fires between ticks; make the predicate flip right at the end so
    // both timers are live in the same slice of virtual time.
    let ready = false;
    const canScroll = vi.fn(() => ready);
    const { editor } = makeEditor(true);
    const handleScrollTo = mount(canScroll);

    const settled: unknown[] = [];
    const pending = handleScrollTo(editor as any).then((v) => {
      settled.push(v);
      return v;
    });

    await vi.advanceTimersByTimeAsync(WAIT_TIMEOUT_MS - 1);
    ready = true;
    await vi.advanceTimersByTimeAsync(WAIT_INTERVAL_MS * 3);

    await pending;
    expect(settled).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps retrying the DOM lookup while the editor stays scrollable", async () => {
    const canScroll = vi.fn(() => true);
    const { editor, querySelector } = makeEditor(false);
    const handleScrollTo = mount(canScroll);

    const pending = handleScrollTo(editor as any);
    // MAX_TRY_COUNT = 10 lookups, each 200ms apart, each preceded by an 800ms
    // wait tick. Run far past that so the recursion bottoms out.
    await vi.advanceTimersByTimeAsync((WAIT_INTERVAL_MS + 200) * 12);

    await expect(pending).resolves.toBe(false);
    expect(querySelector).toHaveBeenCalledTimes(10);
    // The retry path is a give-up on the lookup, not on the wait: no warning.
    expect(warnSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
