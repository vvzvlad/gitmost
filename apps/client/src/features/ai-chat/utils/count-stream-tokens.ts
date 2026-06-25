import type { UIMessage } from "@ai-sdk/react";

/**
 * Live token counting for a streaming AI-chat turn — split into REASONING
 * (thinking) and OUTPUT (answer) tokens, mirroring how Claude Code shows
 * `Thinking… · 60 tokens` next to its thinking indicator.
 *
 * No provider streams exact per-token usage mid-stream, so the live number is a
 * CLIENT ESTIMATE (chars/≈4 heuristic) that is reconciled to AUTHORITATIVE usage
 * once the server attaches it on a step/turn boundary (see the server's
 * `chatStreamMetadata` + the client's read of `message.metadata.usage`). When
 * authoritative usage is present we return it verbatim (the number "jumps to
 * exact"); otherwise we return the running estimate. Pure + unit-testable: it
 * never runs a real BPE tokenizer (that would be O(n²) on the hot path, bloat the
 * bundle, and be wrong for Gemini/Ollama anyway).
 */

/**
 * Rough token estimate for a piece of text using the standard chars/≈4 heuristic.
 * Returns 0 for empty/whitespace-free-of-content input, and ceils so any
 * non-empty text counts as at least one token.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Authoritative per-step/turn usage the server attaches to message metadata. */
export interface AuthoritativeUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
}

/** Live token split for a turn's tail (streaming) assistant message. */
export interface LiveTurnTokens {
  /** Thinking/reasoning tokens (estimate, or authoritative when available). */
  reasoning: number;
  /** Answer/output tokens (estimate, or authoritative when available). */
  output: number;
  /** True when the numbers come from authoritative server usage, not estimate. */
  authoritative: boolean;
}

/** Read the authoritative usage off a UIMessage's metadata, if the server set it. */
function metadataUsage(message: UIMessage): AuthoritativeUsage | undefined {
  const meta = message?.metadata as
    | { usage?: AuthoritativeUsage }
    | undefined;
  const usage = meta?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  return usage;
}

/**
 * Token split for the given (streaming) assistant message.
 *
 * COMBINES the authoritative server usage with the running text estimate so the
 * counter ticks in real time AND lands exact. The server only attaches
 * `metadata.usage` at a step/turn boundary (`finish-step`/`finish`) and it is
 * CUMULATIVE over COMPLETED steps — it does NOT yet include the in-flight step.
 * So a multi-step turn that returned the authoritative figure verbatim would
 * FREEZE between boundaries and jump in steps (issue #163).
 *
 * Instead we always compute the running ESTIMATE (chars/≈4 over the message's
 * `reasoning`/`text` parts, which grows on every streamed delta) and take the
 * per-component MAX of the authoritative base and the estimate:
 *   - between boundaries the estimate of the in-flight step ticks the number up;
 *   - at a boundary the authoritative figure snaps it to exact;
 *   - because the server's usage is cumulative and we only ever take the max, the
 *     number is MONOTONIC — it never drops.
 *
 * Providers that don't stream reasoning text still surface a reasoning count once
 * the authoritative usage arrives (`max(reasoningTokens, 0)`); on the pure
 * estimate path (no usage yet) such a turn shows `reasoning: 0` until then.
 */
export function liveTurnTokens(message: UIMessage | undefined): LiveTurnTokens {
  if (!message) return { reasoning: 0, output: 0, authoritative: false };

  // Running ESTIMATE over every reasoning/text part — grows on each delta. This
  // includes the IN-FLIGHT step, which the authoritative usage does not cover yet.
  let estReasoning = 0;
  let estOutput = 0;
  for (const part of message.parts ?? []) {
    if (part.type === "reasoning") {
      estReasoning += estimateTokens((part as { text?: string }).text ?? "");
    } else if (part.type === "text") {
      estOutput += estimateTokens((part as { text?: string }).text ?? "");
    }
  }

  const usage = metadataUsage(message);
  if (!usage) {
    // No authoritative usage streamed yet: the estimate IS the live figure.
    return { reasoning: estReasoning, output: estOutput, authoritative: false };
  }

  // Authoritative sum over COMPLETED steps. `outputTokens` already INCLUDES
  // reasoning in the AI SDK usage shape, so subtract it out for the "answer"
  // figure (never go negative if a provider reports them inconsistently).
  const authReasoning = usage.reasoningTokens ?? 0;
  const authOutput = Math.max(0, (usage.outputTokens ?? 0) - authReasoning);

  // Per-component max: the in-flight step's estimate ticks above the completed-
  // steps base between boundaries, and the authoritative figure wins once it
  // exceeds the (rough) estimate at the next boundary. Monotonic by construction.
  return {
    reasoning: Math.max(authReasoning, estReasoning),
    output: Math.max(authOutput, estOutput),
    authoritative: true,
  };
}
