/**
 * Client-only Markdown builder for an AI agent chat. Serializes the already
 * persisted message rows (loaded via `useAiChatMessagesQuery`) into a single
 * Markdown string suitable for copying to the clipboard. NO network call is
 * made and NO server/DB code is touched — this reuses the rich "request
 * internals" (tool calls with input/output, per-message token usage,
 * finish/error info) that the chat already holds client-side.
 *
 * Only role labels and tool action labels are localized via the passed-in `t`
 * translator; the structural document words (Input/Output/Error/Tokens/...) are
 * plain English constants because the output is a technical artifact.
 */

import type { IAiChatMessageRow } from "@/features/ai-chat/types/ai-chat.types.ts";
import {
  ToolUiPart,
  getToolName,
  toolRunState,
  toolLabelKey,
} from "@/features/ai-chat/utils/tool-parts.tsx";

// Minimal translator signature compatible with react-i18next's `t`.
type Translate = (key: string, values?: Record<string, unknown>) => string;

interface BuildChatMarkdownArgs {
  title: string | null;
  chatId: string;
  /** The live, on-screen messages — the WYSIWYG source of the export. When
   *  present and non-empty these DRIVE the document (so it mirrors exactly what
   *  the user sees, including a partial reply from an interrupted turn). Each is
   *  matched to a persisted row by `id` to enrich it with token usage / error /
   *  timestamp. When absent or empty the builder falls back to `rows`. */
  live?: LiveMessage[];
  /** Persisted message rows. Enrichment source (matched to `live` by id) AND the
   *  fallback document source when `live` is empty. */
  rows: IAiChatMessageRow[];
  /** Whether the live thread is still streaming. Only then is the tail assistant
   *  message flagged "still generating"; an interrupted (non-streaming) partial
   *  reply is exported as-is and the `banner` explains the interruption. */
  isStreaming?: boolean;
  /** The on-screen banner text (error / dropped connection / manual stop),
   *  appended at the end of the export so the artifact records the interruption
   *  the user saw. */
  banner?: string | null;
  t: Translate;
}

/** A single AI SDK UIMessage part (text part or other). */
interface TextLikePart {
  type: string;
  text?: string;
}

/** Authoritative per-turn usage the server attaches to a message / row. */
interface UsageLike {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
}

/** A live, on-screen message (subset of the AI SDK UIMessage we consume). */
interface LiveMessage {
  id: string;
  role: "user" | "assistant" | string;
  parts: TextLikePart[];
  metadata?: { usage?: UsageLike; error?: string };
}

/** One message normalized for rendering, regardless of live/persisted origin. */
interface ExportItem {
  role: string;
  parts: TextLikePart[];
  usage?: UsageLike;
  error?: string;
  /** ISO timestamp from the persisted row, when one is known. */
  createdAt?: string;
  /** True only for the tail assistant message while the thread is streaming. */
  generating: boolean;
}

/**
 * Stringify an arbitrary tool input/output value for a fenced block. Strings
 * pass through as-is; everything else is pretty-printed JSON, falling back to
 * `String(value)` if serialization throws (e.g. a circular structure).
 */
function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Wrap `code` in a fenced code block whose backtick delimiter is LONGER than
 * the longest backtick run inside the content, so embedded backticks (or even
 * a literal ``` fence) never break out of the block. Minimum 3 backticks.
 */
function fence(code: string, lang = ""): string {
  const runs: string[] = code.match(/`+/g) ?? [];
  const longest = runs.reduce((m, s) => Math.max(m, s.length), 0);
  const delim = "`".repeat(Math.max(3, longest + 1));
  return `${delim}${lang}\n${code}\n${delim}`;
}

/** Per-row token count, mirroring the header sum in ai-chat-window.tsx. */
function rowTokens(usage: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
}): number {
  return (
    usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
  );
}

/** Render one message's UIMessage parts into an array of Markdown blocks
 *  (text blocks + tool blocks). Mirrors MessageItem's part handling. */
function renderMessageParts(parts: TextLikePart[], t: Translate): string[] {
  const out: string[] = [];

  for (const part of parts) {
    if (part.type === "text") {
      const text = (part.text ?? "").trim();
      // Skip empty/whitespace-only text parts (matches MessageItem).
      if (text.length > 0) out.push(text);
      continue;
    }

    const isToolPart =
      part.type.startsWith("tool-") || part.type === "dynamic-tool";
    if (!isToolPart) continue;

    const tp = part as unknown as ToolUiPart;
    const name = getToolName(tp);
    const { key, values } = toolLabelKey(name);
    const label = t(key, values);
    const state = toolRunState(tp.state);

    const toolLines: string[] = [
      `**Tool: ${label}** (\`${name}\`) — ${state}`,
    ];
    if (tp.input !== undefined) {
      toolLines.push("Input:");
      toolLines.push(fence(stringify(tp.input), "json"));
    }
    if (tp.output !== undefined) {
      toolLines.push("Output:");
      toolLines.push(fence(stringify(tp.output), "json"));
    }
    if (tp.errorText) {
      toolLines.push(`**Error:** ${tp.errorText}`);
    }
    out.push(toolLines.join("\n\n"));
  }

  return out;
}

/** Resolve a persisted row's parts: prefer the rich persisted parts, else a
 *  single text part built from the plain-text content (mirrors `rowToUiMessage`). */
function rowParts(row: IAiChatMessageRow): TextLikePart[] {
  return Array.isArray(row.metadata?.parts) && row.metadata.parts.length > 0
    ? (row.metadata.parts as TextLikePart[])
    : [{ type: "text", text: row.content ?? "" }];
}

/**
 * Normalize the export to one ordered list of {@link ExportItem}, WYSIWYG-first:
 *
 * - When `live` messages are present, THEY are the document (what the user sees,
 *   incl. an interrupted turn's partial reply). Each is matched to a persisted
 *   row by `id` to pull token usage / error / timestamp — a live message of the
 *   CURRENT turn has no matching row yet, so it simply renders without a footer.
 *   Authoritative `usage`/`error` already on the live message metadata win over
 *   the row (the server attaches usage to the streamed message at a step
 *   boundary before the row is refetched). Only the tail assistant message is
 *   flagged `generating`, and only while `isStreaming`.
 * - When `live` is empty (e.g. the export runs before the live mirror is
 *   populated), fall back to the persisted `rows` so the format never regresses.
 */
function resolveItems(
  live: LiveMessage[] | undefined,
  rows: IAiChatMessageRow[],
  isStreaming: boolean,
): ExportItem[] {
  if (live && live.length > 0) {
    const rowsById = new Map(rows.map((r) => [r.id, r]));
    // The "still generating" note may apply ONLY to an assistant message that is
    // the actual TAIL of the list — that is where the on-screen typing indicator
    // sits. While `status === "submitted"` (isStreaming true) right after the
    // user hit send, the tail is the USER message and the new assistant turn has
    // no message yet; the previous assistant answer is shown complete on screen,
    // so it must NOT be flagged (the indicator renders as a separate bottom
    // block, not on that answer).
    const lastIndex = live.length - 1;
    const tailIsStreamingAssistant =
      isStreaming && live[lastIndex]?.role === "assistant";
    return live.map((m, i) => {
      const row = rowsById.get(m.id);
      return {
        role: m.role,
        parts: m.parts ?? [],
        // Authoritative usage/error already on the live message (the server
        // attaches usage to the streamed message at a step boundary) wins over
        // the persisted row; a current-turn live message has no matching row yet
        // and simply renders without a token footer (the accepted WYSIWYG
        // tradeoff — an interrupted turn loses only its token footer, not text).
        usage: m.metadata?.usage ?? row?.metadata?.usage,
        error: m.metadata?.error ?? row?.metadata?.error ?? undefined,
        createdAt: row?.createdAt,
        generating: tailIsStreamingAssistant && i === lastIndex,
      };
    });
  }

  return rows.map((row) => ({
    role: row.role,
    parts: rowParts(row),
    usage: row.metadata?.usage,
    error: row.metadata?.error ?? undefined,
    createdAt: row.createdAt,
    generating: false,
  }));
}

/**
 * Serialize a chat to a Markdown string. Pure (apart from `new Date()` for the
 * export timestamp), so it is straightforward to unit-test.
 */
export function buildChatMarkdown(args: BuildChatMarkdownArgs): string {
  const { title, chatId, live, rows, isStreaming, banner, t } = args;
  const blocks: string[] = [];

  const items = resolveItems(live, rows, isStreaming === true);

  const heading = (title ?? "").trim() || t("Untitled chat");
  blocks.push(`# ${heading}`);

  // Metadata bullet list. Total tokens is only shown when there is a sum.
  const totalTokens = items.reduce(
    (sum, item) => (item.usage ? sum + rowTokens(item.usage) : sum),
    0,
  );
  const meta = [
    `- Chat ID: \`${chatId}\``,
    `- Exported: ${new Date().toISOString()}`,
    `- Messages: ${items.length}`,
  ];
  if (totalTokens > 0) meta.push(`- Total tokens: ${totalTokens}`);
  blocks.push(meta.join("\n"));

  items.forEach((item, index) => {
    blocks.push("---");

    const roleLabel = item.role === "assistant" ? t("AI agent") : t("You");
    blocks.push(`## ${index + 1}. ${roleLabel}`);

    // Created-at kept in source as an HTML comment (out of the rendered prose).
    // A live message of the current turn has no persisted row yet — omit it.
    if (item.createdAt) blocks.push(`<!-- ${item.createdAt} -->`);

    blocks.push(...renderMessageParts(item.parts, t));

    // A generating assistant may have empty/no parts yet — the heading (above)
    // and this note still record the in-progress turn.
    if (item.generating) {
      blocks.push(
        "_⏳ This message is still being generated — the export captured a partial, in-progress response._",
      );
    }

    // A persisted per-message error (the raw provider text) may coexist with the
    // trailing `banner` (the classified on-screen alert) when the failed turn's
    // row has already been refetched by export time. They describe the same
    // failure at different fidelity; showing both is an accepted, minor redundancy.
    if (item.error) {
      blocks.push(`**⚠️ Error:** ${item.error}`);
    }

    const usage = item.usage;
    if (usage) {
      const total = usage.totalTokens ?? rowTokens(usage);
      // Reasoning (thinking) tokens are shown only when the provider reported a
      // positive count; old rows / non-reasoning providers omit it.
      const reasoning =
        usage.reasoningTokens && usage.reasoningTokens > 0
          ? `, reasoning: ${usage.reasoningTokens}`
          : "";
      blocks.push(
        `_Tokens — in: ${usage.inputTokens ?? "?"}, out: ${usage.outputTokens ?? "?"}${reasoning}, total: ${total}_`,
      );
    }
  });

  // Record the on-screen banner (error / dropped connection / manual stop) so
  // the export reflects exactly what the user saw, including an interruption.
  if (banner && banner.trim().length > 0) {
    blocks.push("---");
    blocks.push(`_⚠️ ${banner.trim()}_`);
  }

  // Blank line between blocks so the Markdown renders cleanly.
  return blocks.join("\n\n");
}
