import { describe, it, expect } from "vitest";
import type { UIMessage } from "@ai-sdk/react";
import type { IAiChatMessageRow } from "@/features/ai-chat/types/ai-chat.types.ts";
import {
  isStreamingTail,
  isSettledAssistantTail,
  stepsPersistedOf,
  mergeDeltaRowsIntoPages,
  mergeById,
} from "./resume-helpers.ts";

function row(
  id: string,
  role: string,
  status?: string,
  stepsPersisted?: number,
): IAiChatMessageRow {
  return {
    id,
    role,
    content: "",
    status,
    createdAt: "2026-01-01T00:00:00Z",
    ...(stepsPersisted !== undefined
      ? { metadata: { stepsPersisted } }
      : {}),
  };
}

function makeMsg(id: string, text: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
  } as UIMessage;
}

describe("isStreamingTail", () => {
  it("is true when the last row is a streaming assistant row", () => {
    expect(
      isStreamingTail([row("u1", "user"), row("a1", "assistant", "streaming")]),
    ).toBe(true);
  });

  it("is false for a settled assistant tail", () => {
    expect(isStreamingTail([row("a1", "assistant", "succeeded")])).toBe(false);
    expect(isStreamingTail([row("a1", "assistant")])).toBe(false);
  });

  it("is false when the tail is a user row or the list is empty", () => {
    expect(isStreamingTail([row("u1", "user")])).toBe(false);
    expect(isStreamingTail([])).toBe(false);
  });
});

describe("isSettledAssistantTail", () => {
  it("is true for an assistant tail whose status is not streaming", () => {
    expect(isSettledAssistantTail([row("a1", "assistant", "succeeded")])).toBe(
      true,
    );
    expect(isSettledAssistantTail([row("a1", "assistant")])).toBe(true);
    expect(isSettledAssistantTail([row("a1", "assistant", "aborted")])).toBe(
      true,
    );
  });

  it("is false for a streaming assistant tail", () => {
    expect(isSettledAssistantTail([row("a1", "assistant", "streaming")])).toBe(
      false,
    );
  });

  it("is false when the tail is a user row or the list is empty", () => {
    expect(isSettledAssistantTail([row("u1", "user")])).toBe(false);
    expect(isSettledAssistantTail([])).toBe(false);
  });
});

describe("stepsPersistedOf", () => {
  it("reads metadata.stepsPersisted", () => {
    expect(stepsPersistedOf(row("a1", "assistant", "streaming", 3))).toBe(3);
    expect(stepsPersistedOf(row("a1", "assistant", "streaming", 0))).toBe(0);
  });

  it("defaults to 0 for a pre-#491 row (absent), null/undefined, or a bad value", () => {
    expect(stepsPersistedOf(row("a1", "assistant", "streaming"))).toBe(0);
    expect(stepsPersistedOf(null)).toBe(0);
    expect(stepsPersistedOf(undefined)).toBe(0);
    expect(
      stepsPersistedOf({
        id: "a1",
        role: "assistant",
        content: "",
        createdAt: "x",
        metadata: { stepsPersisted: -2 },
      }),
    ).toBe(0);
  });

  it("floors a non-integer count", () => {
    expect(
      stepsPersistedOf({
        id: "a1",
        role: "assistant",
        content: "",
        createdAt: "x",
        metadata: { stepsPersisted: 2.9 },
      }),
    ).toBe(2);
  });
});

describe("mergeDeltaRowsIntoPages", () => {
  const pages = () => [
    { items: [row("u1", "user"), row("a1", "assistant", "streaming", 1)], meta: {} },
  ];

  it("returns the pages unchanged for an empty delta", () => {
    const p = pages();
    expect(mergeDeltaRowsIntoPages(p, [])).toBe(p);
  });

  it("appends a genuinely new row to the last page in chronological order", () => {
    const merged = mergeDeltaRowsIntoPages(pages(), [row("a2", "assistant", "streaming", 0)]);
    expect(merged[0].items.map((i) => i.id)).toEqual(["u1", "a1", "a2"]);
  });

  it("replaces a grown row in place (per-step growth), never appends a duplicate", () => {
    const merged = mergeDeltaRowsIntoPages(pages(), [
      row("a1", "assistant", "streaming", 2),
    ]);
    expect(merged[0].items.map((i) => i.id)).toEqual(["u1", "a1"]);
    // the in-place replacement carries the grown step frontier.
    expect(stepsPersistedOf(merged[0].items[1])).toBe(2);
  });

  it("does not mutate the input pages", () => {
    const input = pages();
    const before = input[0].items.slice();
    mergeDeltaRowsIntoPages(input, [row("a2", "assistant", "streaming", 0)]);
    expect(input[0].items).toEqual(before); // untouched
  });

  // #491 CONTRACT: the delta overlap window re-delivers the same rows, so merging
  // MUST be idempotent — applying a delta twice equals applying it once (no growth,
  // no reorder). A regression re-introduces duplicate assistant bubbles per poll.
  it("is idempotent: applying the same delta twice equals once", () => {
    const delta = [
      row("a1", "assistant", "streaming", 2), // grown existing row
      row("a2", "assistant", "streaming", 0), // new row
    ];
    const once = mergeDeltaRowsIntoPages(pages(), delta);
    const twice = mergeDeltaRowsIntoPages(once, delta);
    const thrice = mergeDeltaRowsIntoPages(twice, delta);
    expect(once[0].items.map((i) => i.id)).toEqual(["u1", "a1", "a2"]);
    expect(twice[0].items.map((i) => i.id)).toEqual(["u1", "a1", "a2"]);
    expect(twice).toEqual(once);
    expect(thrice).toEqual(once);
  });

  it("seeds a first page when the cache is empty", () => {
    const merged = mergeDeltaRowsIntoPages([], [row("u1", "user")]);
    expect(merged).toHaveLength(1);
    expect(merged[0].items.map((i) => i.id)).toEqual(["u1"]);
  });
});

describe("mergeById", () => {
  it("replaces the message with the same id in place (per-step growth)", () => {
    const prev = [makeMsg("u1", "hi"), makeMsg("a1", "step 1")];
    const incoming = makeMsg("a1", "step 1\nstep 2");
    const next = mergeById(prev, incoming);
    expect(next).toHaveLength(2);
    expect(next[1]).toBe(incoming);
    expect(next[0]).toBe(prev[0]); // untouched
    expect(next).not.toBe(prev); // new array (never mutates input)
  });

  it("appends when the incoming message is not yet present", () => {
    const prev = [makeMsg("u1", "hi")];
    const incoming = makeMsg("a1", "first token");
    const next = mergeById(prev, incoming);
    expect(next).toHaveLength(2);
    expect(next[1]).toBe(incoming);
  });

  it("returns the original list unchanged when there is nothing to merge", () => {
    const prev = [makeMsg("u1", "hi")];
    expect(mergeById(prev, null)).toBe(prev);
    expect(mergeById(prev, undefined)).toBe(prev);
  });

  // #491 CONTRACT: the delta poll's overlap window GUARANTEES the same row is
  // re-delivered across close polls, so merging must be IDEMPOTENT by id — merging
  // the same row (or an equal-length list of rows) twice must not duplicate or
  // reorder. This is the property the whole delta-poll design leans on; a
  // regression here would re-introduce duplicate assistant bubbles on every poll.
  it("is idempotent by id: re-merging the same row does not duplicate or reorder", () => {
    const seed = [makeMsg("u1", "hi"), makeMsg("a1", "step 1")];
    const repeat = makeMsg("a1", "step 1"); // the SAME row the overlap re-delivers
    const once = mergeById(seed, repeat);
    const twice = mergeById(once, repeat);
    const thrice = mergeById(twice, repeat);
    // Length is stable (no growth), order is stable (user then assistant).
    expect(once.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(twice.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(thrice.map((m) => m.id)).toEqual(["u1", "a1"]);
    // The repeated merge converges: the row is replaced in place, never appended.
    expect(twice[1]).toBe(repeat);
  });

  it("is idempotent across a batch of repeated + grown rows (delta re-delivery)", () => {
    // A delta poll re-delivers a1 (unchanged) and a2 (grown one step). Applying the
    // batch twice must equal applying it once — the poll can re-send either.
    const start = [makeMsg("u1", "hi"), makeMsg("a1", "done")];
    const batch = [makeMsg("a1", "done"), makeMsg("a2", "grown step 2")];
    const apply = (list: typeof start) =>
      batch.reduce((acc, row) => mergeById(acc, row), list);
    const once = apply(start);
    const twice = apply(once);
    expect(once.map((m) => m.id)).toEqual(["u1", "a1", "a2"]);
    expect(twice.map((m) => m.id)).toEqual(["u1", "a1", "a2"]);
    expect(twice).toEqual(once);
  });
});
