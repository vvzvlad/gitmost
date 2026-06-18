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
  rows: IAiChatMessageRow[];
  t: Translate;
}

/** A single AI SDK UIMessage part (text part or other). */
interface TextLikePart {
  type: string;
  text?: string;
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
}): number {
  return (
    usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
  );
}

/**
 * Serialize a chat to a Markdown string. Pure (apart from `new Date()` for the
 * export timestamp), so it is straightforward to unit-test.
 */
export function buildChatMarkdown(args: BuildChatMarkdownArgs): string {
  const { title, chatId, rows, t } = args;
  const blocks: string[] = [];

  const heading = (title ?? "").trim() || t("Untitled chat");
  blocks.push(`# ${heading}`);

  // Metadata bullet list. Total tokens is only shown when there is a sum.
  const totalTokens = rows.reduce((sum, row) => {
    const usage = row.metadata?.usage;
    return usage ? sum + rowTokens(usage) : sum;
  }, 0);
  const meta = [
    `- Chat ID: \`${chatId}\``,
    `- Exported: ${new Date().toISOString()}`,
    `- Messages: ${rows.length}`,
  ];
  if (totalTokens > 0) meta.push(`- Total tokens: ${totalTokens}`);
  blocks.push(meta.join("\n"));

  rows.forEach((row, index) => {
    blocks.push("---");

    const roleLabel = row.role === "assistant" ? t("AI agent") : t("You");
    blocks.push(`## ${index + 1}. ${roleLabel}`);

    // Created-at kept in source as an HTML comment (out of the rendered prose).
    blocks.push(`<!-- ${row.createdAt} -->`);

    // Resolve parts: prefer the rich persisted parts, else a single text part
    // built from the plain-text content (mirrors `rowToUiMessage`).
    const parts: TextLikePart[] =
      Array.isArray(row.metadata?.parts) && row.metadata.parts.length > 0
        ? (row.metadata.parts as TextLikePart[])
        : [{ type: "text", text: row.content ?? "" }];

    for (const part of parts) {
      if (part.type === "text") {
        const text = (part.text ?? "").trim();
        // Skip empty/whitespace-only text parts (matches MessageItem).
        if (text.length > 0) blocks.push(text);
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
      blocks.push(toolLines.join("\n\n"));
    }

    if (row.metadata?.error) {
      blocks.push(`**⚠️ Error:** ${row.metadata.error}`);
    }

    const usage = row.metadata?.usage;
    if (usage) {
      const total = usage.totalTokens ?? rowTokens(usage);
      blocks.push(
        `_Tokens — in: ${usage.inputTokens ?? "?"}, out: ${usage.outputTokens ?? "?"}, total: ${total}_`,
      );
    }
  });

  // Blank line between blocks so the Markdown renders cleanly.
  return blocks.join("\n\n");
}
