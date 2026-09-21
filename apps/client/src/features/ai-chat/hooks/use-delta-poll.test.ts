import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import React from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { IAiChatMessageRow } from "@/features/ai-chat/types/ai-chat.types.ts";

// Hoisted delta mock so the service module mock (above the imports) can expose the
// spy + its scripted responses back to the test body.
const h = vi.hoisted(() => ({
  delta: vi.fn(),
}));

vi.mock("@/features/ai-chat/services/ai-chat-service.ts", () => ({
  getAiChatMessagesDelta: (chatId: string, cursor?: string) =>
    h.delta(chatId, cursor),
}));

// Use the REAL query key so setQueryData targets the same cache key the window's
// messages query reads.
import {
  useAiChatDeltaPoll,
  applyDeltaRowsToMessagesCache,
  sameRunFact,
  DELTA_POLL_INTERVAL_MS,
  type MessagesInfiniteData,
} from "./use-delta-poll";
import { AI_CHAT_MESSAGES_RQ_KEY } from "@/features/ai-chat/queries/ai-chat-query.ts";

function row(id: string, status = "streaming"): IAiChatMessageRow {
  return {
    id,
    role: "assistant",
    content: "x",
    status,
    createdAt: "2026-01-01T00:00:00Z",
  };
}
function deltaRes(
  rows: IAiChatMessageRow[],
  cursor: string,
  run: { id: string; status: string } | null = null,
) {
  return { rows, cursor, run };
}

// -----------------------------------------------------------------------------
// Pure helpers (the setQueryData shape + the fact dedupe key).
// -----------------------------------------------------------------------------
describe("use-delta-poll — applyDeltaRowsToMessagesCache (setQueryData shape)", () => {
  it("returns `old` untouched when the cache is unseeded (undefined)", () => {
    expect(
      applyDeltaRowsToMessagesCache(undefined, [row("a1")]),
    ).toBeUndefined();
  });

  it("merges rows into `{ ...old, pages }` idempotently by id (shape preserved)", () => {
    const old: MessagesInfiniteData = {
      pages: [{ items: [row("u1")], meta: { m: 1 } }],
      pageParams: [null],
    };
    const merged = applyDeltaRowsToMessagesCache(old, [row("a1")])!;
    // Same wrapper shape: pageParams carried through, a fresh `pages`.
    expect(merged.pageParams).toEqual([null]);
    expect(merged.pages[0].meta).toEqual({ m: 1 });
    expect(merged.pages[0].items.map((r) => r.id)).toEqual(["u1", "a1"]);
    // Idempotent: applying the same delta twice equals once (no dup).
    const twice = applyDeltaRowsToMessagesCache(merged, [row("a1")])!;
    expect(twice.pages[0].items.map((r) => r.id)).toEqual(["u1", "a1"]);
    // Input not mutated.
    expect(old.pages[0].items.map((r) => r.id)).toEqual(["u1"]);
  });
});

describe("use-delta-poll — sameRunFact", () => {
  it("treats both-null as equal and null-vs-object as different", () => {
    expect(sameRunFact(null, null)).toBe(true);
    expect(sameRunFact({ id: "r", status: "running" }, null)).toBe(false);
    expect(sameRunFact(null, { id: "r", status: "running" })).toBe(false);
  });
  it("compares id AND status", () => {
    expect(
      sameRunFact(
        { id: "r", status: "running" },
        { id: "r", status: "running" },
      ),
    ).toBe(true);
    expect(
      sameRunFact(
        { id: "r", status: "running" },
        { id: "r", status: "completed" },
      ),
    ).toBe(false);
    expect(
      sameRunFact(
        { id: "r", status: "running" },
        { id: "q", status: "running" },
      ),
    ).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// The hook: cursor lifecycle, reset on chat change, cache write, fact surfacing.
// -----------------------------------------------------------------------------
describe("useAiChatDeltaPoll", () => {
  let qc: QueryClient;
  function wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  }

  // Advance timers AND flush the async tick's React state update (setRunFact) under
  // act, so `result.current` reflects the surfaced fact.
  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  beforeEach(() => {
    vi.useFakeTimers();
    h.delta.mockReset();
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does NOT poll until armed AND enabled AND a chatId is present", async () => {
    h.delta.mockResolvedValue(deltaRes([], "c1-cur"));
    // armed but disabled
    renderHook(
      () => useAiChatDeltaPoll({ chatId: "c1", armed: true, enabled: false }),
      { wrapper },
    );
    await vi.advanceTimersByTimeAsync(DELTA_POLL_INTERVAL_MS * 2);
    expect(h.delta).not.toHaveBeenCalled();
  });

  it("cursor lifecycle: the leading tick sends undefined, then the interval ECHOES the returned cursor", async () => {
    h.delta
      .mockResolvedValueOnce(deltaRes([], "cur-1"))
      .mockResolvedValueOnce(deltaRes([], "cur-2"))
      .mockResolvedValue(deltaRes([], "cur-3"));
    renderHook(
      () => useAiChatDeltaPoll({ chatId: "c1", armed: true, enabled: true }),
      { wrapper },
    );
    // The leading tick fires on arm — it IS the first tick, so it sends `undefined`.
    expect(h.delta).toHaveBeenNthCalledWith(1, "c1", undefined);
    await vi.advanceTimersByTimeAsync(DELTA_POLL_INTERVAL_MS);
    expect(h.delta).toHaveBeenNthCalledWith(2, "c1", "cur-1"); // echoed
    await vi.advanceTimersByTimeAsync(DELTA_POLL_INTERVAL_MS);
    expect(h.delta).toHaveBeenNthCalledWith(3, "c1", "cur-2");
  });

  it("leading tick: fires IMMEDIATELY on arm (before a full interval) with cursor undefined, then the interval takes over", async () => {
    h.delta
      .mockResolvedValueOnce(deltaRes([], "cur-1"))
      .mockResolvedValue(deltaRes([], "cur-2"));
    renderHook(
      () => useAiChatDeltaPoll({ chatId: "c1", armed: true, enabled: true }),
      { wrapper },
    );
    // Immediate: the leading tick has already fired ONCE, with the fresh
    // `undefined` cursor — no timer advance — so the first delta lands promptly
    // (this is the assertion that goes red if the leading tick is removed, while
    // the interval-based echoes below stay green).
    expect(h.delta).toHaveBeenCalledTimes(1);
    expect(h.delta).toHaveBeenNthCalledWith(1, "c1", undefined);
    // Still short of a full interval: nothing more fires.
    await vi.advanceTimersByTimeAsync(DELTA_POLL_INTERVAL_MS - 1);
    expect(h.delta).toHaveBeenCalledTimes(1);
    // The interval then continues the chain, echoing the leading tick's cursor.
    await vi.advanceTimersByTimeAsync(1);
    expect(h.delta).toHaveBeenNthCalledWith(2, "c1", "cur-1");
  });

  it("reset on chat change: the new chat starts a FRESH cursor chain (undefined)", async () => {
    h.delta.mockResolvedValue(deltaRes([], "cur-1"));
    const { rerender } = renderHook(
      (props: { chatId: string }) =>
        useAiChatDeltaPoll({
          chatId: props.chatId,
          armed: true,
          enabled: true,
        }),
      { wrapper, initialProps: { chatId: "c1" } },
    );
    // The leading tick fired on arm with the fresh undefined cursor.
    expect(h.delta).toHaveBeenLastCalledWith("c1", undefined);
    await vi.advanceTimersByTimeAsync(DELTA_POLL_INTERVAL_MS);
    expect(h.delta).toHaveBeenLastCalledWith("c1", "cur-1"); // cursor advanced
    // Switch chats -> the cursor MUST reset (a c1 cursor is meaningless for c2);
    // the re-arm's leading tick fires immediately with a fresh undefined.
    rerender({ chatId: "c2" });
    expect(h.delta).toHaveBeenLastCalledWith("c2", undefined);
  });

  it("merges changed rows into the messages infinite-query cache (setQueryData shape)", async () => {
    qc.setQueryData(AI_CHAT_MESSAGES_RQ_KEY("c1"), {
      pages: [{ items: [row("u1")], meta: null }],
      pageParams: [null],
    });
    h.delta.mockResolvedValue(deltaRes([row("a1", "completed")], "cur-1"));
    renderHook(
      () => useAiChatDeltaPoll({ chatId: "c1", armed: true, enabled: true }),
      { wrapper },
    );
    await vi.advanceTimersByTimeAsync(DELTA_POLL_INTERVAL_MS);
    const cached = qc.getQueryData(
      AI_CHAT_MESSAGES_RQ_KEY("c1"),
    ) as MessagesInfiniteData;
    expect(cached!.pages[0].items.map((r) => r.id)).toEqual(["u1", "a1"]);
    expect(cached!.pageParams).toEqual([null]);
  });

  it("surfaces the run fact and DEDUPES an unchanged fact (fresh negative is not swallowed)", async () => {
    h.delta
      .mockResolvedValueOnce(
        deltaRes([], "c1", { id: "run-1", status: "running" }),
      )
      .mockResolvedValueOnce(
        deltaRes([], "c2", { id: "run-1", status: "running" }),
      )
      .mockResolvedValue(deltaRes([], "c3", null)); // run ended
    const { result } = renderHook(
      () => useAiChatDeltaPoll({ chatId: "c1", armed: true, enabled: true }),
      { wrapper },
    );
    expect(result.current).toBeUndefined(); // leading tick in flight, no result yet
    // The leading tick surfaces run-1; the first interval re-polls the SAME fact
    // (deduped — no re-render churn).
    await advance(DELTA_POLL_INTERVAL_MS);
    expect(result.current).toEqual({ id: "run-1", status: "running" });
    await advance(DELTA_POLL_INTERVAL_MS); // run gone -> fresh negative surfaced
    expect(result.current).toBeNull();
  });

  it("swallows a transient poll error and keeps polling on the next tick", async () => {
    h.delta
      .mockRejectedValueOnce(new Error("server bounce"))
      .mockResolvedValue(
        deltaRes([], "cur-2", { id: "run-1", status: "running" }),
      );
    const { result } = renderHook(
      () => useAiChatDeltaPoll({ chatId: "c1", armed: true, enabled: true }),
      { wrapper },
    );
    // Flush the LEADING tick's rejection without advancing a full interval.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toBeUndefined(); // rejected — swallowed
    await advance(DELTA_POLL_INTERVAL_MS); // next tick recovers
    expect(result.current).toEqual({ id: "run-1", status: "running" });
  });
});
