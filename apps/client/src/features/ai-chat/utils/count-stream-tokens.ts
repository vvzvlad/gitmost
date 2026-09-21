/**
 * Rough client-side token estimation for AI-chat UI affordances.
 *
 * No provider streams exact per-token usage mid-stream, so any in-flight figure
 * is a CLIENT ESTIMATE. This re-exports the SHARED estimator from
 * `@docmost/token-estimate` (chars/2.5) so the in-body counter and the server's
 * replay budgeter use the SAME heuristic — two divergent estimators would mean
 * "the badge shows 60%" while "the budgeter already trimmed" (#490). Used by the
 * in-body reasoning counter ("Thinking · N tokens").
 */
export { estimateTokens } from "@docmost/token-estimate";
