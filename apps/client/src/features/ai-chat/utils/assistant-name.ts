// Pure helper for resolving the assistant's display name. Kept free of React so
// it can be unit-tested in isolation (see assistant-name.test.ts) and shared by
// the components that render the assistant identity (TypingIndicator, MessageItem).

/**
 * Resolve the assistant's display name from the optional configured identity.
 *
 * Returns the trimmed name when it has visible (non-whitespace) characters, or
 * `null` when the name is absent or whitespace-only. Callers fall back to a
 * generic "AI agent" label on `null`. The `.trim()` is why a name of "   " must
 * resolve to `null` rather than rendering an empty label.
 */
export function resolveAssistantName(assistantName?: string): string | null {
  const name = assistantName?.trim();
  return name ? name : null;
}
