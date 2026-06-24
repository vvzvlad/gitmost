import type { UIMessage } from "@ai-sdk/react";

/**
 * Decide the authoritative reasoning token count to attribute to a single
 * `reasoning` part of an assistant message — or `undefined` when the part should
 * fall back to its own per-part estimate.
 *
 * `usage.reasoningTokens` is the TURN TOTAL, so it may only be attributed to a
 * block when the turn has exactly ONE reasoning part (the common one-step turn):
 * then that block can show the exact figure. With MULTIPLE reasoning parts (a
 * multi-step agent turn) every block must fall back to its own estimate —
 * attributing the turn total to one of them would double-count against the
 * others' estimates (#151 review anti-double-count rule). When there is no
 * authoritative usage at all, every part estimates.
 *
 * Returns the authoritative `reasoningTokens` only for the single-reasoning-part
 * case; `undefined` otherwise (the caller estimates from the part text).
 */
export function reasoningTokensForPart(
  message: UIMessage,
): number | undefined {
  const reasoningTokens = (
    message.metadata as { usage?: { reasoningTokens?: number } } | undefined
  )?.usage?.reasoningTokens;

  const reasoningPartCount = (message.parts ?? []).reduce(
    (acc, p) => (p.type === "reasoning" ? acc + 1 : acc),
    0,
  );

  // Exactly one reasoning part -> attribute the authoritative turn total to it.
  // Otherwise (zero or multiple) each part estimates on its own.
  return reasoningPartCount === 1 ? reasoningTokens : undefined;
}
