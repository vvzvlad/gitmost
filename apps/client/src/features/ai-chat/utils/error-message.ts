/**
 * Turn an AI chat error message into a friendly inline string. Used for BOTH the
 * live `useChat().error` (its `.message`) and a persisted assistant error stored
 * in `metadata.error`. Our own gating responses arrive as a raw NestJS JSON error
 * body carrying a numeric "statusCode" field (matched precisely, not by bare
 * substring, so a provider message that merely contains "403"/"503"/"disabled" is
 * never misclassified). Everything else — provider stream failures forwarded as
 * "<status>: <message>" (402 credits, 429 rate limit, ...) — is surfaced verbatim.
 */
export function describeChatError(
  message: string,
  t: (key: string) => string,
): string {
  const msg = message ?? "";
  if (/"statusCode"\s*:\s*403\b/.test(msg)) {
    return t("AI chat is disabled for this workspace.");
  }
  if (/"statusCode"\s*:\s*503\b/.test(msg)) {
    return t("The AI provider is not configured. Ask an administrator to set it up.");
  }
  return providerDetail(msg) ?? t("The AI agent could not respond. Please try again.");
}

/**
 * Extract a human-readable provider detail, or null when there is nothing useful
 * to show: empty text, the AI SDK's opaque "An error occurred." placeholder, or
 * our own post-hijack "Internal server error" fallback.
 */
function providerDetail(msg: string): string | null {
  const trimmed = msg.trim();
  if (!trimmed) return null;
  if (/^an error occurred\.?$/i.test(trimmed)) return null;
  if (/internal server error/i.test(trimmed)) return null;
  return trimmed;
}
