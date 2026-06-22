/**
 * A classified AI chat error: a short bold heading naming the cause category and
 * a one-line human-readable detail / next step. Both strings are already passed
 * through `t`, so callers render them directly.
 */
export interface ChatErrorView {
  title: string;
  detail: string;
}

/**
 * Turn an AI chat error message into a friendly heading + detail. Used for BOTH
 * the live `useChat().error` (its `.message`) and a persisted assistant error in
 * `metadata.error`. Our own gating responses arrive as a raw NestJS JSON error
 * body carrying a numeric "statusCode" (matched precisely, not by bare substring,
 * so a provider message that merely contains "403"/"503" is never misclassified).
 * Known provider/network failures (connection reset, timeout, rate limit, context
 * overflow, quota, auth) are mapped to a clear category; anything else falls back
 * to the raw provider detail (or a generic line) under the original heading.
 */
export function describeChatError(
  message: string,
  t: (key: string) => string,
): ChatErrorView {
  const msg = message ?? "";

  if (/"statusCode"\s*:\s*403\b/.test(msg)) {
    return {
      title: t("AI chat is disabled"),
      detail: t("AI chat is disabled for this workspace."),
    };
  }
  if (/"statusCode"\s*:\s*503\b/.test(msg)) {
    return {
      title: t("AI provider not configured"),
      detail: t(
        "The AI provider is not configured. Ask an administrator to set it up.",
      ),
    };
  }

  const category = classifyProviderError(msg);
  if (category) {
    return { title: t(category.title), detail: t(category.detail) };
  }

  // Unknown error: surface the raw provider detail when it is informative,
  // otherwise a generic line. The heading stays the original generic one.
  return {
    title: t("Something went wrong"),
    detail:
      providerDetail(msg) ??
      t("The AI agent could not respond. Please try again."),
  };
}

interface ErrorCategory {
  /** English key for the bold heading. */
  title: string;
  /** English key for the one-line explanation. */
  detail: string;
}

/**
 * Map a provider/network error string to a friendly category. Order matters: the
 * most specific signatures are tested first. Returns null when nothing matches,
 * so the caller can fall back to the raw provider text. The English keys returned
 * here are passed through `t` by the caller.
 *
 * The server formats provider errors as "<statusCode>: <message> | response body:
 * <snippet>" (see server-side describeProviderError), so the HTTP status is always
 * the LEADING token. We match a numeric code only when it leads the string, so a
 * number inside the response-body snippet never triggers a category; textual
 * signatures are matched only against the leading message (before the response
 * body), so a phrase inside the snippet never triggers a category either.
 */
function classifyProviderError(msg: string): ErrorCategory | null {
  const code = /^\s*(\d{3})\b/.exec(msg)?.[1] ?? "";
  // The server appends "| response body: <snippet>" to provider errors; match
  // textual signatures only against the leading provider message so a phrase
  // inside the response-body snippet never triggers a wrong category. The numeric
  // status code is read from the start of the full string above.
  const head = msg.split(/\|\s*response body:/i)[0];

  // Connection dropped / provider unreachable. ECONNRESET is the production case:
  // the LLM socket was reset mid-stream. "terminated" is scoped to a connection/
  // stream context so it does not match benign "... was terminated" messages.
  // The browser's own fetch-failure messages also land here because they mean the
  // SSE stream to /api/ai-chat/stream dropped mid-answer (e.g. a reverse proxy cut
  // it): WebKit/Safari says "Load failed", Chrome "Failed to fetch", Firefox
  // "NetworkError when attempting to fetch resource".
  if (
    /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|cannot connect|fetch failed|failed to fetch|load failed|networkerror|network error|connection (?:error|closed|reset|terminated)|stream terminated/i.test(
      head,
    )
  ) {
    return {
      title: "Lost connection to the AI provider",
      detail:
        "The connection to the AI provider dropped before the answer finished. Please try again.",
    };
  }
  // Timeout.
  if (
    code === "504" ||
    code === "408" ||
    /ETIMEDOUT|timed[\s-]?out|\btimeout\b/i.test(head)
  ) {
    return {
      title: "The AI provider timed out",
      detail: "The AI provider took too long to respond. Please try again.",
    };
  }
  // Rate limited.
  if (code === "429" || /rate[\s-]?limit|too many requests/i.test(head)) {
    return {
      title: "Rate limited by the AI provider",
      detail:
        "The AI provider is rate-limiting requests. Wait a moment and try again.",
    };
  }
  // Context window / token budget exceeded.
  if (
    code === "413" ||
    /context[\s_-]?(?:length|window)|maximum context|context_length_exceeded|too many tokens|maximum[^.]*tokens|reduce the length/i.test(
      head,
    )
  ) {
    return {
      title: "The conversation is too large",
      detail:
        "The document and search results exceeded the model's context window. Start a new chat or narrow the request.",
    };
  }
  // Out of credits / quota / payment required.
  if (
    code === "402" ||
    /payment required|insufficient (?:credits|quota|funds|balance)|out of credits|quota (?:exceeded|exhausted)/i.test(
      head,
    )
  ) {
    return {
      title: "AI provider quota exceeded",
      detail:
        "The AI provider rejected the request because of credits or quota. Check the provider account.",
    };
  }
  // Authentication / bad API key.
  if (
    code === "401" ||
    /\bunauthorized\b|invalid api key|user not found|\bauthentication\b/i.test(head)
  ) {
    return {
      title: "AI provider authentication failed",
      detail:
        "The AI provider rejected the credentials. Ask an administrator to check the API key.",
    };
  }
  return null;
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
