import type { UIMessage } from "@ai-sdk/react";

/** Cheap content signature for one message: changes iff something VISIBLE in the
 *  row changed. Streaming is APPEND-ONLY (text parts only grow, parts are only
 *  appended, a tool/text part flips state once), so a per-part [type, text
 *  length, state, error/output presence] tuple + the persisted metadata
 *  (error/finishReason) is a sufficient change signal without comparing full
 *  strings on every delta. */
export function messageSignature(message: UIMessage): string {
  const parts = message.parts
    .map((p) => {
      const any = p as {
        type: string;
        text?: string;
        state?: string;
        errorText?: string;
        output?: unknown;
      };
      return [
        any.type,
        any.text?.length ?? 0,
        any.state ?? "",
        any.errorText ? 1 : 0,
        any.output !== undefined ? 1 : 0,
      ].join(":");
    })
    .join("|");
  const meta = message.metadata as
    | { error?: string; finishReason?: string; usage?: { reasoningTokens?: number } }
    | undefined;
  // `usage.reasoningTokens` is neither append-only nor part-bound: the authoritative
  // turn total arrives on the final `finish-step` AFTER the reasoning text length and
  // state are already frozen. Without it in the signature the row's signature would be
  // unchanged at that point and the re-render skipped, so the "Thinking · N tokens"
  // header (reasoningTokensForPart) would keep the live estimate instead of snapping
  // to the exact figure.
  return `${message.id}#${message.role}#${parts}#${meta?.error ?? ""}#${
    meta?.finishReason ?? ""
  }#${meta?.usage?.reasoningTokens ?? ""}`;
}
