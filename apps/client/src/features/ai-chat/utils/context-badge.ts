import type { IAiChatMessageRow } from "@/features/ai-chat/types/ai-chat.types.ts";

/**
 * Derive the header context badge figures from the persisted message rows.
 *
 * - `contextTokens` (numerator): how much the conversation now occupies in the
 *   model's context window. Read from the most recent row carrying a context
 *   figure — `contextTokens` (final-step input+output) on rows recorded after
 *   this shipped, else that turn's legacy `usage` total for older rows.
 * - `maxContextTokens` (denominator): the model's configured max window, stamped
 *   alongside `contextTokens` on a completed turn.
 *
 * Each value is taken from the most recent row carrying THAT value
 * independently — they may land on different rows (e.g. a fresh error row can
 * carry `contextTokens` but not `maxContextTokens`), so the scan continues for
 * whichever is still unset. `0` means "no row has it" (older rows, or no
 * admin-configured limit); the badge then omits the value.
 */
export function selectContextBadge(
  messageRows: readonly IAiChatMessageRow[] | undefined | null,
): { contextTokens: number; maxContextTokens: number } {
  let contextTokens = 0;
  let maxContextTokens = 0;
  if (!messageRows) return { contextTokens, maxContextTokens };
  for (let i = messageRows.length - 1; i >= 0; i--) {
    const meta = messageRows[i].metadata;
    if (!meta) continue;
    if (contextTokens === 0) {
      if (typeof meta.contextTokens === "number" && meta.contextTokens > 0) {
        contextTokens = meta.contextTokens;
      } else if (meta.usage) {
        const usage = meta.usage;
        const fallback =
          usage.totalTokens ??
          (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
        if (fallback > 0) contextTokens = fallback;
      }
    }
    if (
      maxContextTokens === 0 &&
      typeof meta.maxContextTokens === "number" &&
      meta.maxContextTokens > 0
    ) {
      maxContextTokens = meta.maxContextTokens;
    }
    if (contextTokens !== 0 && maxContextTokens !== 0) break;
  }
  return { contextTokens, maxContextTokens };
}
