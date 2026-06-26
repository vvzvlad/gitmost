import type { UIMessage } from "@ai-sdk/react";
import { isToolPart } from "@/features/ai-chat/utils/tool-parts.tsx";

/**
 * Whether an assistant `UIMessage` has anything visible to render in its bubble.
 *
 * This mirrors MessageItem's render decisions EXACTLY and is the single source of
 * truth shared by both MessageItem (to decide whether to render the bubble at all)
 * and typingIndicatorShowsName (to decide whether the standalone "Thinking…"
 * indicator owns the dimmed agent-name label). Keeping one helper guarantees the
 * two stay in lockstep, so exactly one element owns the name during the pre-content
 * "thinking" gap and the layout never reflows mid-stream.
 *
 * An assistant message has visible content iff ANY of:
 *  - a `text` part whose trimmed length > 0 (non-empty markdown), OR
 *  - ANY tool part (`isToolPart(part.type)`), OR
 *  - `metadata.error` is truthy (a persisted error banner renders), OR
 *  - `metadata.finishReason === "aborted"` (a persisted "response stopped" notice).
 * Empty/whitespace-only text parts and unsupported part kinds (reasoning, sources,
 * files, step-start) are NOT visible.
 */
export function assistantMessageHasVisibleContent(message: UIMessage): boolean {
  const meta = message.metadata as
    | { error?: string; finishReason?: string }
    | undefined;
  // Persisted errored/aborted turns always render their banner/notice.
  if (meta?.error) return true;
  if (meta?.finishReason === "aborted") return true;

  // `parts` may be empty (a nascent streaming message has no parts yet).
  // `?? []` also guards a sparse/partial message object (metadata-only, no
  // `parts`) so iterating cannot throw — it does not change behavior for any
  // current input.
  for (const part of message.parts ?? []) {
    if (part.type === "text" && part.text.trim().length > 0) return true;
    if (isToolPart(part.type)) return true;
  }
  return false;
}
