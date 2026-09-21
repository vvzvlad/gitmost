import { describe, it, expect } from "vitest";
import { readUIMessageStream, type UIMessage } from "ai";
import pkg from "../../../../package.json";

/**
 * PIN-SPEC TRIP-WIRE (#491). The tail-only attach continuation relies on THREE
 * behaviors of `ai@6.0.207`, verified line-by-line in the issue. Without this
 * test, an `ai` bump could silently break attach (the client would append the
 * live tail to the wrong message, or duplicate a step):
 *
 *   1. `readUIMessageStream({ message })` CONTINUES the passed message — it does
 *      not start a fresh one — so the tail streamed after a re-seed is appended to
 *      the seeded assistant row (the same DB id).
 *   2. A `start` frame does NOT reset the existing message's parts (so the seeded
 *      steps 0..N-1 survive; the synthetic `start` the registry prepends only
 *      carries the run-fact metadata).
 *   3. Text parts do NOT cross a `finish-step` boundary — a new `text-start` after
 *      `finish-step` is a NEW part — so the reconstructed steps stay separated and
 *      the step frontier stays meaningful.
 *
 * If an `ai` upgrade changes any of these, this test fails LOUD instead of the
 * resume path silently corrupting.
 */
describe("ai SDK continuation trip-wire (#491, tail-only attach)", () => {
  it("is pinned to the exact ai version the continuation was verified against", () => {
    // A caret/range bump is exactly what would silently break attach — require an
    // exact pin. Bumping ai MUST re-verify the behavior asserted below, then this.
    expect((pkg as { dependencies: Record<string, string> }).dependencies.ai).toBe(
      "6.0.207",
    );
  });

  it("continues the seeded message: start does not reset parts, the tail appends as new parts", async () => {
    // A seeded assistant row with ONE finished step already reconstructed.
    const seeded: UIMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "text", text: "STEP0", state: "done" },
      ],
    } as UIMessage;

    // The tail the registry delivers on re-attach: a synthetic start (run-fact),
    // then step 1's frames, then finish. As UI-message chunks (what the SSE frames
    // decode to).
    const chunks = [
      { type: "start", messageMetadata: { runId: "r1", chatId: "c1" } },
      { type: "start-step" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "STEP1" },
      { type: "text-end", id: "t1" },
      { type: "finish-step" },
      { type: "finish" },
    ];
    const stream = new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(ch);
        c.close();
      },
    });

    let last: UIMessage | undefined;
    for await (const msg of readUIMessageStream({ message: seeded, stream })) {
      last = msg;
    }

    expect(last).toBeDefined();
    // Same message id (continuation, not a fresh message).
    expect(last!.id).toBe("assistant-1");
    // The seeded step-0 parts SURVIVED the `start` frame, and step 1 was appended
    // as SEPARATE parts (text did not cross the finish-step boundary).
    const shape = last!.parts.map((p) => `${p.type}:${(p as { text?: string }).text ?? ""}`);
    expect(shape).toEqual([
      "step-start:",
      "text:STEP0",
      "step-start:",
      "text:STEP1",
    ]);
    // The run-fact metadata from the synthetic start frame is applied.
    expect(last!.metadata).toMatchObject({ runId: "r1", chatId: "c1" });
  });
});
