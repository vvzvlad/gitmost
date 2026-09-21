import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { readUIMessageStream, type UIMessage } from "ai";
import {
  isStreamingTail,
  isSettledAssistantTail,
} from "./resume-helpers.ts";
import type { IAiChatMessageRow } from "@/features/ai-chat/types/ai-chat.types.ts";

/**
 * PROPERTY test for message reconstruction over NORMALIZED transcripts (#555),
 * layered on the PIN-SPEC trip-wire (`sdk-continuation-tripwire.test.ts`). The
 * trip-wire pins ONE hand-written transcript against the three `ai@6.0.207`
 * behaviors; this test GENERATES a family of normalized transcripts — varying
 * seeded/tail step counts, tail presence/absence, message ids and run metadata —
 * and asserts the same tail-only-attach invariants hold for ALL of them. It reuses
 * the trip-wire's exact chunk shape, so it stays coupled to the same pinned SDK
 * behavior (a bump that breaks the trip-wire breaks this too).
 *
 * A "normalized" transcript is the canonical seed+tail shape the resume path emits:
 *   - the SEED is an assistant row carrying steps 0..N-1, each a `step-start` part
 *     followed by ONE finished `text` part (the persisted step frontier);
 *   - the TAIL is the run-stream registry's re-attach frames: a synthetic `start`
 *     (run-fact metadata only), then M well-formed steps
 *     (`start-step`/`text-start`/`text-delta`/`text-end`/`finish-step`), then
 *     `finish`. M === 0 models an ABSENT tail (start + finish only).
 */

// ── Fixtures: the trip-wire's exact chunk shape, parameterized ──────────────────

/** A seeded assistant row: `step-start` + finished `text` per persisted step. */
function seededMessage(id: string, texts: string[]): UIMessage {
  return {
    id,
    role: "assistant",
    parts: texts.flatMap((t) => [
      { type: "step-start" },
      { type: "text", text: t, state: "done" },
    ]),
  } as UIMessage;
}

/**
 * The tail the registry delivers on re-attach — same frame shape as the trip-wire:
 * a synthetic `start` carrying only the run-fact metadata, then one well-formed
 * step per tail text, then `finish`. Text-part ids are unique per step so deltas
 * never merge across the `finish-step` boundary.
 */
function tailChunks(
  metadata: { runId: string; chatId: string },
  texts: string[],
): unknown[] {
  const chunks: unknown[] = [{ type: "start", messageMetadata: metadata }];
  texts.forEach((t, i) => {
    const id = `tail-${i}`;
    chunks.push(
      { type: "start-step" },
      { type: "text-start", id },
      { type: "text-delta", id, delta: t },
      { type: "text-end", id },
      { type: "finish-step" },
    );
  });
  chunks.push({ type: "finish" });
  return chunks;
}

/** Run the seed + tail through the SDK continuation and return the final message. */
async function reconstruct(
  seed: UIMessage,
  chunks: unknown[],
): Promise<UIMessage> {
  const stream = new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
  let last: UIMessage | undefined;
  for await (const msg of readUIMessageStream({ message: seed, stream })) {
    last = msg;
  }
  if (!last) throw new Error("reconstruction produced no message");
  return last;
}

/** The canonical rendered shape: `step-start:` / `text:<text>` per part, in order. */
function shapeOf(msg: UIMessage): string[] {
  return msg.parts.map(
    (p) => `${p.type}:${(p as { text?: string }).text ?? ""}`,
  );
}

// ── Arbitraries ────────────────────────────────────────────────────────────────

// A normalized step text — non-empty, small, from a stable alphabet.
const stepText = fc.string({ minLength: 1, maxLength: 6 });
// A non-empty message / run / chat id.
const id = fc.string({ minLength: 1, maxLength: 10 });

describe("ai SDK continuation — reconstruction property (#555, normalized transcripts)", () => {
  it("reconstruction invariants hold for ALL generated seed+tail transcripts", async () => {
    await fc.assert(
      fc.asyncProperty(
        id, // assistant message id
        fc.array(stepText, { minLength: 1, maxLength: 5 }), // seeded steps (>=1)
        fc.array(stepText, { minLength: 0, maxLength: 5 }), // tail steps (0 = absent)
        id, // runId
        id, // chatId
        async (msgId, seededTexts, tailTexts, runId, chatId) => {
          const seed = seededMessage(msgId, seededTexts);
          const out = await reconstruct(
            seed,
            tailChunks({ runId, chatId }, tailTexts),
          );

          // I1 — id stability: the continuation CONTINUES the seeded message; the
          // reconstructed row keeps the same DB id (never a fresh message).
          expect(out.id).toBe(msgId);

          // I2 — no wipe: the synthetic `start` did NOT reset the seeded parts —
          // the persisted steps 0..N-1 survive verbatim, in order, at the front.
          const seededShape = seededTexts.flatMap((t) => [
            "step-start:",
            `text:${t}`,
          ]);
          expect(shapeOf(out).slice(0, seededShape.length)).toEqual(
            seededShape,
          );

          // I3 — append: the tail's M steps are appended AFTER the seed as separate
          // parts; the full shape is exactly seed ++ tail (nothing dropped/merged).
          const fullShape = [...seededTexts, ...tailTexts].flatMap((t) => [
            "step-start:",
            `text:${t}`,
          ]);
          expect(shapeOf(out)).toEqual(fullShape);

          // I4 — step separation: text never crosses a `finish-step` boundary, so
          // the reconstructed step count is exactly seeded + tail (the step
          // frontier stays meaningful).
          const stepStarts = out.parts.filter(
            (p) => p.type === "step-start",
          ).length;
          expect(stepStarts).toBe(seededTexts.length + tailTexts.length);

          // I5 — run-fact metadata from the synthetic start frame is applied, even
          // when the tail carries ZERO steps (an absent tail still updates metadata).
          expect(out.metadata).toMatchObject({ runId, chatId });
        },
      ),
      { numRuns: 80, seed: 0x555 },
    );
  });
});

// ── Tail-presence decision: "only the presence of THIS tail decides WHETHER to
//    attach" (resume-helpers). Property-checked over generated rows arrays. ───────

// A generated persisted row with an arbitrary role + status.
const genRow = fc
  .record({
    id,
    role: fc.constantFrom("assistant" as const, "user" as const),
    status: fc.constantFrom(
      "streaming",
      "completed",
      "error",
      "cancelled",
      "pending",
    ),
  })
  .map(
    (r): IAiChatMessageRow => ({
      id: r.id,
      role: r.role,
      content: "x",
      status: r.status,
      createdAt: "2026-01-01T00:00:00Z",
    }),
  );

describe("resume tail-presence decision — property (#555, only the tail decides)", () => {
  it("the attach decision is a pure function of ONLY the last row, and streaming/settled are mutually exclusive", () => {
    fc.assert(
      fc.property(
        fc.array(genRow, { minLength: 0, maxLength: 6 }), // arbitrary prefix
        genRow, // the tail row
        (prefix, tail) => {
          const rows = [...prefix, tail];

          // P1 — only the tail matters: prepending arbitrary earlier rows does NOT
          // change either predicate (the seed history is irrelevant to attach).
          expect(isStreamingTail(rows)).toBe(isStreamingTail([tail]));
          expect(isSettledAssistantTail(rows)).toBe(
            isSettledAssistantTail([tail]),
          );

          // P2 — mutual exclusivity: a tail is never BOTH a resumable streaming
          // tail AND a settled assistant tail.
          expect(isStreamingTail(rows) && isSettledAssistantTail(rows)).toBe(
            false,
          );

          // P3 — assistant tails partition exactly: an assistant tail is streaming
          // XOR settled; a non-assistant (user) tail is NEITHER (never attaches).
          if (tail.role === "assistant") {
            expect(
              isStreamingTail(rows) !== isSettledAssistantTail(rows),
            ).toBe(true);
          } else {
            expect(isStreamingTail(rows)).toBe(false);
            expect(isSettledAssistantTail(rows)).toBe(false);
          }
        },
      ),
      { numRuns: 100, seed: 0x555 },
    );
  });

  it("an empty transcript attaches to NOTHING (both predicates false)", () => {
    expect(isStreamingTail([])).toBe(false);
    expect(isSettledAssistantTail([])).toBe(false);
  });
});
