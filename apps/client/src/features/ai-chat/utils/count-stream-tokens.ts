/**
 * Rough client-side token estimation for AI-chat UI affordances.
 *
 * No provider streams exact per-token usage mid-stream, so any in-flight figure
 * is a CLIENT ESTIMATE (chars/≈4 heuristic). Pure + unit-testable: it never runs
 * a real BPE tokenizer (that would be O(n²) on the hot path, bloat the bundle,
 * and be wrong for Gemini/Ollama anyway). Used by the in-body reasoning counter
 * ("Thinking · N tokens").
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
