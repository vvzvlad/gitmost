/**
 * Shared, provider-agnostic token estimator (#490).
 *
 * No provider exposes an exact tokenizer we can afford to run on the hot path (a
 * real BPE pass is O(n²)-ish, bloats the client bundle, and is wrong for
 * Gemini/Ollama anyway), so both the client's in-body counter AND the server's
 * history-replay budgeter use this ONE cheap chars-based heuristic. Keeping it in
 * a single shared module is deliberate: two independent estimators drift, and then
 * "the badge shows 60%" while "the budgeter already trimmed" — the exact confusion
 * this package prevents.
 *
 * Ratio: **chars / 2.5**. Most content here is Cyrillic, where a token is ~2.5
 * characters; the common English `chars/4` rule of thumb UNDER-counts Cyrillic by
 * ~2×, which for a budget check is the dangerous direction (it lets the context
 * overflow). 2.5 slightly over-estimates pure English/code, which is the SAFE
 * direction for a budget. This is an estimate, never an exact count — the
 * authoritative figure is always the provider's reported usage; the estimate is
 * for UI affordances, the delta of not-yet-sent messages, and deciding what to
 * trim.
 */

/** Characters per token for the shared estimate. See the module comment. */
export const CHARS_PER_TOKEN = 2.5;

/**
 * Rough token estimate for a piece of text (chars / {@link CHARS_PER_TOKEN}).
 * Returns 0 for empty/nullish input, and ceils so any non-empty text counts as at
 * least one token. Pure and deterministic (byte-stable), so the same text always
 * yields the same estimate — which the server budgeter relies on to keep replay
 * trimming stable turn to turn (provider prompt-cache friendliness).
 */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
