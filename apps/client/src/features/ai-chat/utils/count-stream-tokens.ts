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
 * Prefers AUTHORITATIVE `metadata.usage` when the server has attached it (at a
 * step/turn boundary, incl. `reasoningTokens`) — so the live counter snaps to the
 * provider's exact figures. Until then it returns a running ESTIMATE summed over
 * the message parts: `reasoning` parts feed the reasoning estimate, `text` parts
 * feed the output estimate. Multi-part / multi-step turns accumulate naturally
 * because every part of the turn is summed.
 *
 * Providers that don't stream reasoning text still surface a reasoning count once
 * the authoritative usage arrives (`usage.reasoningTokens`); on the pure estimate
 * path such a turn simply shows `reasoning: 0` until then.
 */
export function liveTurnTokens(message: UIMessage | undefined): LiveTurnTokens {
  if (!message) return { reasoning: 0, output: 0, authoritative: false };

  const usage = metadataUsage(message);
  if (usage) {
    // Authoritative branch: outputTokens already INCLUDES reasoning tokens in the
    // AI SDK usage shape, so subtract reasoning out for the "answer" figure (never
    // go negative if a provider reports them inconsistently).
    const reasoning = usage.reasoningTokens ?? 0;
    const totalOutput = usage.outputTokens ?? 0;
    const output = Math.max(0, totalOutput - reasoning);
    return { reasoning, output, authoritative: true };
  }

  let reasoning = 0;
  let output = 0;
  for (const part of message.parts ?? []) {
    if (part.type === "reasoning") {
      reasoning += estimateTokens((part as { text?: string }).text ?? "");
    } else if (part.type === "text") {
      output += estimateTokens((part as { text?: string }).text ?? "");
    }
  }
  return { reasoning, output, authoritative: false };
}
