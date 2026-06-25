/**
 * Server-side Markdown export for an AI agent chat (#183). The DB is the single
 * source of truth: this renders a chat purely from its persisted message rows
 * (`AiChatMessage[]` — role / content / metadata.parts / toolCalls / usage).
 * Because the assistant row is now persisted UPFRONT and updated per step, an
 * interrupted turn is included up to its last finished step.
 *
 * Ported from the client `utils/chat-markdown.ts`. It is a PURE function (apart
 * from `new Date()` for the export timestamp), so it is straightforward to
 * unit-test and a future background worker can reuse it.
 *
 * Only a few fixed role/tool labels are localized via the `lang` param; the
 * structural document words (Input/Output/Error/Tokens/...) stay English because
 * the output is a technical artifact.
 */

import type { AiChatMessage } from '@docmost/db/types/entity.types';

/** Supported export label languages. Defaults to English. */
export type ExportLang = 'en' | 'ru';

/**
 * Normalize an arbitrary client locale code to a supported export language. The
 * client sends `i18n.language`, which is a FULL locale tag (e.g. `en-US`,
 * `ru-RU`), not a bare `en`/`ru` — so match on the language subtag and fall back
 * to English for anything non-Russian.
 */
export function normalizeLang(lang?: string): ExportLang {
  return lang?.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

/** A single AI SDK UIMessage part (text part or a tool part). */
interface ExportPart {
  type: string;
  text?: string;
  state?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

/** Authoritative per-turn usage the server attaches to a message row. */
interface UsageLike {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
}

/** Localized label table. Keep the keys identical to the client's i18n keys so
 *  the two exports read the same. Only role + tool-action labels are localized;
 *  everything structural is an English constant in the renderer. */
const LABELS: Record<
  ExportLang,
  {
    untitled: string;
    aiAgent: string;
    you: string;
    tools: Record<string, string>;
    ranTool: (name: string) => string;
    stillGenerating: string;
  }
> = {
  en: {
    untitled: 'Untitled chat',
    aiAgent: 'AI agent',
    you: 'You',
    tools: {
      searchPages: 'Searched pages',
      getPage: 'Read page',
      createPage: 'Created page',
      updatePageContent: 'Updated page',
      renamePage: 'Renamed page',
      movePage: 'Moved page',
      deletePage: 'Deleted page (to trash)',
      createComment: 'Commented',
      resolveComment: 'Resolved comment',
    },
    ranTool: (name) => `Ran tool ${name}`,
    stillGenerating:
      'This message is still being generated — the export captured a partial, in-progress response.',
  },
  ru: {
    untitled: 'Без названия',
    aiAgent: 'ИИ-агент',
    you: 'Вы',
    tools: {
      searchPages: 'Искал по страницам',
      getPage: 'Прочитал страницу',
      createPage: 'Создал страницу',
      updatePageContent: 'Обновил страницу',
      renamePage: 'Переименовал страницу',
      movePage: 'Переместил страницу',
      deletePage: 'Удалил страницу (в корзину)',
      createComment: 'Прокомментировал',
      resolveComment: 'Закрыл комментарий',
    },
    ranTool: (name) => `Выполнил инструмент ${name}`,
    stillGenerating:
      'Это сообщение всё ещё генерируется — экспорт захватил частичный, незавершённый ответ.',
  },
};

/** True for AI SDK tool parts (static `tool-*` or `dynamic-tool`). */
function isToolPart(type: string): boolean {
  return type.startsWith('tool-') || type === 'dynamic-tool';
}

/** Extract the tool name from a part `type` of `tool-${name}` (or dynamic). */
function getToolName(part: ExportPart): string {
  if (part.type === 'dynamic-tool') return part.toolName ?? '';
  return part.type.startsWith('tool-')
    ? part.type.slice('tool-'.length)
    : part.type;
}

/** Map an AI SDK tool-part state to the 3 states the action-log renders. */
function toolRunState(state: string | undefined): 'running' | 'done' | 'error' {
  if (state === 'output-error' || state === 'output-denied') return 'error';
  if (state === 'output-available') return 'done';
  return 'running';
}

/** Resolve a tool's friendly action-log label (localized) from its name. */
function toolLabel(name: string, lang: ExportLang): string {
  return LABELS[lang].tools[name] ?? LABELS[lang].ranTool(name);
}

/**
 * Stringify an arbitrary tool input/output value for a fenced block. Strings
 * pass through as-is; everything else is pretty-printed JSON, falling back to
 * `String(value)` if serialization throws (e.g. a circular structure).
 */
function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Wrap `code` in a fenced code block whose backtick delimiter is LONGER than the
 * longest backtick run inside the content, so embedded backticks (or a literal
 * ``` fence) never break out of the block. Minimum 3 backticks.
 */
function fence(code: string, lang = ''): string {
  const runs: string[] = code.match(/`+/g) ?? [];
  const longest = runs.reduce((m, s) => Math.max(m, s.length), 0);
  const delim = '`'.repeat(Math.max(3, longest + 1));
  return `${delim}${lang}\n${code}\n${delim}`;
}

/** Per-row token count, mirroring the header sum in the client window. */
function rowTokens(usage: UsageLike): number {
  return (
    usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
  );
}

/** Render one message's UIMessage parts into an array of Markdown blocks
 *  (text blocks + tool blocks). Mirrors the client renderer / MessageItem. */
function renderMessageParts(parts: ExportPart[], lang: ExportLang): string[] {
  const out: string[] = [];

  for (const part of parts) {
    if (part.type === 'text') {
      const text = (part.text ?? '').trim();
      if (text.length > 0) out.push(text);
      continue;
    }

    if (!isToolPart(part.type)) continue;

    const name = getToolName(part);
    const label = toolLabel(name, lang);
    const state = toolRunState(part.state);

    const toolLines: string[] = [`**Tool: ${label}** (\`${name}\`) — ${state}`];
    if (part.input !== undefined) {
      toolLines.push('Input:');
      toolLines.push(fence(stringify(part.input), 'json'));
    }
    if (part.output !== undefined) {
      toolLines.push('Output:');
      toolLines.push(fence(stringify(part.output), 'json'));
    }
    if (part.errorText) {
      toolLines.push(`**Error:** ${part.errorText}`);
    }
    out.push(toolLines.join('\n\n'));
  }

  return out;
}

/** Resolve a persisted row's parts: prefer the rich persisted parts, else a
 *  single text part built from the plain-text content (mirrors rowToUiMessage). */
function rowParts(row: AiChatMessage): ExportPart[] {
  const meta = (row.metadata ?? {}) as { parts?: ExportPart[] };
  return Array.isArray(meta.parts) && meta.parts.length > 0
    ? meta.parts
    : [{ type: 'text', text: row.content ?? '' }];
}

/**
 * Serialize a chat to a Markdown string from its persisted rows. Source = DB
 * ONLY (no live client state). A row whose `status` is still 'streaming' is an
 * interrupted turn that the export captured mid-flight; it is rendered up to its
 * last finished step and flagged "still generating".
 */
export function buildChatMarkdown(args: {
  title: string | null;
  chatId: string;
  rows: AiChatMessage[];
  // Accepts a full client locale tag (e.g. 'en-US'/'ru-RU'); normalized below.
  lang?: string;
}): string {
  const { title, chatId, rows } = args;
  const lang: ExportLang = normalizeLang(args.lang);
  const L = LABELS[lang];
  const blocks: string[] = [];

  const heading = (title ?? '').trim() || L.untitled;
  blocks.push(`# ${heading}`);

  const usageOf = (row: AiChatMessage): UsageLike | undefined => {
    const meta = (row.metadata ?? {}) as { usage?: UsageLike };
    return meta.usage;
  };
  const errorOf = (row: AiChatMessage): string | undefined => {
    const meta = (row.metadata ?? {}) as { error?: string };
    return meta.error ?? undefined;
  };

  // Metadata bullet list. Total tokens is only shown when there is a sum.
  const totalTokens = rows.reduce((sum, row) => {
    const usage = usageOf(row);
    return usage ? sum + rowTokens(usage) : sum;
  }, 0);
  const meta = [
    `- Chat ID: \`${chatId}\``,
    `- Exported: ${new Date().toISOString()}`,
    `- Messages: ${rows.length}`,
  ];
  if (totalTokens > 0) meta.push(`- Total tokens: ${totalTokens}`);
  blocks.push(meta.join('\n'));

  rows.forEach((row, index) => {
    blocks.push('---');

    const roleLabel = row.role === 'assistant' ? L.aiAgent : L.you;
    blocks.push(`## ${index + 1}. ${roleLabel}`);

    // Created-at kept in source as an HTML comment (out of the rendered prose).
    if (row.createdAt) {
      const iso =
        row.createdAt instanceof Date
          ? row.createdAt.toISOString()
          : String(row.createdAt);
      blocks.push(`<!-- ${iso} -->`);
    }

    blocks.push(...renderMessageParts(rowParts(row), lang));

    // A still-'streaming' row is an interrupted/in-progress turn captured by the
    // export; record that so the partial answer is not mistaken for complete.
    if (row.status === 'streaming') {
      blocks.push(`_⏳ ${L.stillGenerating}_`);
    }

    const error = errorOf(row);
    if (error) {
      blocks.push(`**⚠️ Error:** ${error}`);
    }

    const usage = usageOf(row);
    if (usage) {
      const total = usage.totalTokens ?? rowTokens(usage);
      const reasoning =
        usage.reasoningTokens && usage.reasoningTokens > 0
          ? `, reasoning: ${usage.reasoningTokens}`
          : '';
      blocks.push(
        `_Tokens — in: ${usage.inputTokens ?? '?'}, out: ${
          usage.outputTokens ?? '?'
        }${reasoning}, total: ${total}_`,
      );
    }
  });

  // Blank line between blocks so the Markdown renders cleanly.
  return blocks.join('\n\n');
}
