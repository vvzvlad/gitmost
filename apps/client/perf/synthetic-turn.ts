/**
 * DEV-ONLY synthetic agent-turn generator for the AI chat perf harness.
 *
 * Produces one scripted agent turn (reasoning + tool calls + markdown answer)
 * from a size config, and materializes it two ways:
 *  - as an AI SDK v6 UI-message SSE stream (scenario B "live agent stream"),
 *    served by a `window.fetch` patch that intercepts `/api/ai-chat/stream`;
 *  - as persisted `IAiChatMessageRow[]` history (scenario A "open existing chat").
 *
 * Wire format verified against the installed ai@6.0.207 `uiMessageChunkSchema`
 * (strict objects — only the exact field names below are accepted).
 */

import type { UIMessage } from "@ai-sdk/react";
import type { IAiChatMessageRow } from "../src/features/ai-chat/types/ai-chat.types.ts";

// ---------------------------------------------------------------------------
// Config / presets
// ---------------------------------------------------------------------------

/** 1 token ~= 4 chars — the approximation used throughout this module. */
const CHARS_PER_TOKEN = 4;

export interface TurnConfig {
  /** Number of agent steps; each step = one reasoning block + one tool call. */
  steps: number;
  /** Approximate reasoning tokens generated per step. */
  reasoningTokensPerStep: number;
  /** Size of each tool call's output `content` filler, in bytes (ASCII). */
  toolOutputBytes: number;
  /** Approximate size of the final markdown answer, in tokens. */
  answerTokens: number;
}

export type PresetKey = "5k" | "20k" | "50k";

export const PRESETS: Record<PresetKey, TurnConfig> = {
  "5k": {
    steps: 3,
    reasoningTokensPerStep: 500,
    toolOutputBytes: 10_000,
    answerTokens: 600,
  },
  "20k": {
    steps: 6,
    reasoningTokensPerStep: 2500,
    toolOutputBytes: 20_000,
    answerTokens: 1500,
  },
  "50k": {
    steps: 10,
    reasoningTokensPerStep: 4000,
    toolOutputBytes: 40_000,
    answerTokens: 3000,
  },
};

// ---------------------------------------------------------------------------
// Text generators
// ---------------------------------------------------------------------------

/** Mixed Russian/English prose sentences cycled to build reasoning text. */
const REASONING_SENTENCES = [
  "Пользователь просит проанализировать документ и выделить ключевые тезисы по каждому разделу.",
  "First I need to inspect the current page content to understand its overall structure.",
  "Судя по оглавлению, раздел с техническими требованиями находится ближе к концу документа.",
  "The table in section three contains the migration matrix that I should cross-check against the summary.",
  "Проверю, нет ли противоречий между описанием API и приведёнными в тексте примерами вызовов.",
  "Let me compare the numbers from the executive summary with the raw data in the appendix.",
  "Похоже, автор использует термины «воркспейс» и workspace взаимозаменяемо — это стоит нормализовать.",
  "I should keep the page ids from the tool output so the final answer can cite the source pages.",
  "Осталось свести найденные несоответствия в одну таблицу и предложить порядок исправлений.",
  "The remaining sections look consistent, so I can move on to drafting the structured answer.",
];

/**
 * Build realistic prose of ~`targetChars` characters, inserting a newline
 * roughly every 200 characters (mirrors how reasoning text tends to wrap).
 */
function makeProse(targetChars: number): string {
  const pieces: string[] = [];
  let length = 0;
  let sinceNewline = 0;
  let i = 0;
  while (length < targetChars) {
    const sentence = REASONING_SENTENCES[i % REASONING_SENTENCES.length];
    i += 1;
    pieces.push(sentence);
    length += sentence.length + 1;
    sinceNewline += sentence.length + 1;
    if (sinceNewline >= 200) {
      pieces.push("\n");
      sinceNewline = 0;
    } else {
      pieces.push(" ");
    }
  }
  return pieces.join("").trimEnd();
}

/** One markdown section (~700 chars): heading, prose, bullets, GFM table, code. */
function markdownSection(n: number): string {
  return [
    `## Section ${n}: migration analysis`,
    ``,
    `The workspace contains **${n * 12} pages** that still reference the legacy API. ` +
      `Most of them live under [Perf test page](/p/page-1) and need the new transport. ` +
      `Ниже приведена сводка по разделу с оценкой трудозатрат и основных рисков.`,
    ``,
    `- Update the fetch layer to the v6 transport`,
    `- Перенести таблицы соответствия идентификаторов`,
    `- Verify citation links after the move`,
    `- Проверить отображение длинных ответов в узкой панели`,
    ``,
    `| Область | Страниц | Статус | Риск |`,
    `| --- | --- | --- | --- |`,
    `| API reference | ${n + 4} | migrated | low |`,
    `| Onboarding | ${n + 2} | in progress | medium |`,
    `| Release notes | ${n * 3} | pending | high |`,
    ``,
    "```ts",
    `export function migrateSection${n}(rows: Row[]): Row[] {`,
    `  return rows`,
    `    .filter((row) => row.section === ${n})`,
    `    .map((row) => ({ ...row, migrated: true }));`,
    `}`,
    "```",
  ].join("\n");
}

/** Realistic markdown answer of ~`targetChars` chars (sections repeated to size). */
function makeMarkdownAnswer(targetChars: number): string {
  const sections: string[] = [];
  let length = 0;
  let n = 1;
  while (length < targetChars) {
    const section = markdownSection(n);
    sections.push(section);
    length += section.length + 2;
    n += 1;
  }
  return sections.join("\n\n");
}

/** Plain ASCII filler of exactly `bytes` characters for tool outputs. */
function makeFiller(bytes: number): string {
  const unit = "Perf filler content for the synthetic getPage tool output. ";
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
}

// ---------------------------------------------------------------------------
// Turn script
// ---------------------------------------------------------------------------

export interface TurnToolCall {
  toolCallId: string;
  toolName: "getPage";
  input: { pageId: string };
  output: { id: string; title: string; content: string };
}

export interface TurnStep {
  reasoningText: string;
  tool: TurnToolCall;
}

export interface TurnScript {
  steps: TurnStep[];
  answerText: string;
  /** Approximate reasoning tokens for the whole turn (chars / 4). */
  reasoningTokens: number;
  /** Approximate context size after this turn, in tokens. */
  contextTokens: number;
  maxContextTokens: number;
  /** Actual generated visible chars: reasoning + tool outputs + answer. */
  totalChars: number;
  /** totalChars / 4, rounded. */
  approxTokens: number;
}

/**
 * Build the scripted agent turn for a config. `idPrefix` keeps tool call ids
 * unique when several scripts coexist (e.g. 3 persisted turns in one chat).
 */
export function buildTurnScript(config: TurnConfig, idPrefix = "live"): TurnScript {
  const steps: TurnStep[] = [];
  let reasoningChars = 0;
  let toolChars = 0;
  for (let i = 0; i < config.steps; i++) {
    const reasoningText = makeProse(config.reasoningTokensPerStep * CHARS_PER_TOKEN);
    const content = makeFiller(config.toolOutputBytes);
    reasoningChars += reasoningText.length;
    toolChars += content.length;
    steps.push({
      reasoningText,
      tool: {
        toolCallId: `${idPrefix}-call-${i + 1}`,
        toolName: "getPage",
        input: { pageId: "page-1" },
        output: { id: "page-1", title: "Perf test page", content },
      },
    });
  }
  const answerText = makeMarkdownAnswer(config.answerTokens * CHARS_PER_TOKEN);
  const totalChars = reasoningChars + toolChars + answerText.length;
  return {
    steps,
    answerText,
    reasoningTokens: Math.round(reasoningChars / CHARS_PER_TOKEN),
    contextTokens: Math.round(totalChars / CHARS_PER_TOKEN),
    maxContextTokens: 200_000,
    totalChars,
    approxTokens: Math.round(totalChars / CHARS_PER_TOKEN),
  };
}

// ---------------------------------------------------------------------------
// Scenario A: persisted rows
// ---------------------------------------------------------------------------

/** Number of user+assistant pairs the preset is split across for history. */
const HISTORY_TURNS = 3;

const USER_PROMPTS = [
  "Проанализируй документ и выдели ключевые тезисы по каждому разделу.",
  "Now cross-check the migration matrix against the summary and list every mismatch.",
  "Собери финальный план миграции с оценкой рисков по каждой области.",
];

/** Persisted UIMessage parts for one finished assistant turn. */
function scriptToPersistedParts(script: TurnScript): UIMessage["parts"] {
  const parts: unknown[] = [];
  for (const step of script.steps) {
    parts.push({ type: "reasoning", text: step.reasoningText, state: "done" });
    parts.push({
      type: `tool-${step.tool.toolName}`,
      toolCallId: step.tool.toolCallId,
      state: "output-available",
      input: step.tool.input,
      output: step.tool.output,
    });
  }
  parts.push({ type: "text", text: script.answerText, state: "done" });
  return parts as UIMessage["parts"];
}

export interface PersistedFixture {
  rows: IAiChatMessageRow[];
  totalChars: number;
  approxTokens: number;
}

/**
 * Materialize the preset as a finished 3-turn transcript: user row + assistant
 * row per turn, with the preset's steps/answer split across the assistant turns.
 * Approximate accounting — the actual totals are reported back for display.
 */
export function buildPersistedRows(config: TurnConfig): PersistedFixture {
  const rows: IAiChatMessageRow[] = [];
  const baseTime = Date.now() - HISTORY_TURNS * 60_000;
  let totalChars = 0;

  for (let t = 0; t < HISTORY_TURNS; t++) {
    // Distribute steps as evenly as possible (earlier turns get the remainder).
    const stepsForTurn =
      Math.floor(config.steps / HISTORY_TURNS) +
      (t < config.steps % HISTORY_TURNS ? 1 : 0);
    const turnConfig: TurnConfig = {
      steps: Math.max(1, stepsForTurn),
      reasoningTokensPerStep: config.reasoningTokensPerStep,
      toolOutputBytes: config.toolOutputBytes,
      answerTokens: Math.max(50, Math.round(config.answerTokens / HISTORY_TURNS)),
    };
    const script = buildTurnScript(turnConfig, `hist-${t + 1}`);
    totalChars += script.totalChars;

    const userText = USER_PROMPTS[t % USER_PROMPTS.length];
    rows.push({
      id: `perf-row-u${t + 1}`,
      role: "user",
      content: userText,
      metadata: null,
      createdAt: new Date(baseTime + t * 60_000).toISOString(),
    });
    rows.push({
      id: `perf-row-a${t + 1}`,
      role: "assistant",
      content: script.answerText,
      metadata: {
        parts: scriptToPersistedParts(script),
        usage: { reasoningTokens: script.reasoningTokens },
        contextTokens: script.contextTokens,
        maxContextTokens: script.maxContextTokens,
        finishReason: "stop",
      },
      createdAt: new Date(baseTime + t * 60_000 + 30_000).toISOString(),
    });
  }

  return {
    rows,
    totalChars,
    approxTokens: Math.round(totalChars / CHARS_PER_TOKEN),
  };
}

// ---------------------------------------------------------------------------
// Scenario B: SSE stream
// ---------------------------------------------------------------------------

/** Streaming delta size in chars (reasoning/answer text is split into these). */
const DELTA_CHARS = 200;

function splitDeltas(text: string, size = DELTA_CHARS): string[] {
  const deltas: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    deltas.push(text.slice(i, i + size));
  }
  return deltas;
}

/** One pre-serialized SSE frame plus its visible-char contribution for stats. */
interface SseFrame {
  data: string;
  chars: number;
}

function frame(chunk: Record<string, unknown>, chars = 0): SseFrame {
  return { data: `data: ${JSON.stringify(chunk)}\n\n`, chars };
}

/**
 * Serialize the whole scripted turn into AI SDK v6 UI-message SSE frames
 * (excluding the final `data: [DONE]` terminator, appended by the pump).
 */
function buildSseFrames(script: TurnScript, messageId: string, chatId: string): SseFrame[] {
  const frames: SseFrame[] = [];
  frames.push(frame({ type: "start", messageId, messageMetadata: { chatId } }));

  script.steps.forEach((step, i) => {
    frames.push(frame({ type: "start-step" }));
    const reasoningId = `${messageId}-r${i + 1}`;
    frames.push(frame({ type: "reasoning-start", id: reasoningId }));
    for (const delta of splitDeltas(step.reasoningText)) {
      frames.push(frame({ type: "reasoning-delta", id: reasoningId, delta }, delta.length));
    }
    frames.push(frame({ type: "reasoning-end", id: reasoningId }));

    const { toolCallId, toolName, input, output } = step.tool;
    frames.push(frame({ type: "tool-input-start", toolCallId, toolName }));
    frames.push(frame({ type: "tool-input-available", toolCallId, toolName, input }));
    // The tool result arrives as ONE chunk, like the real server sends it.
    frames.push(frame({ type: "tool-output-available", toolCallId, output }, output.content.length));
    frames.push(frame({ type: "finish-step" }));
  });

  // Final step: the markdown answer.
  frames.push(frame({ type: "start-step" }));
  const textId = `${messageId}-answer`;
  frames.push(frame({ type: "text-start", id: textId }));
  for (const delta of splitDeltas(script.answerText)) {
    frames.push(frame({ type: "text-delta", id: textId, delta }, delta.length));
  }
  frames.push(frame({ type: "text-end", id: textId }));
  frames.push(frame({ type: "finish-step" }));

  frames.push(
    frame({
      type: "finish",
      messageMetadata: {
        usage: { reasoningTokens: script.reasoningTokens },
        contextTokens: script.contextTokens,
        maxContextTokens: script.maxContextTokens,
        finishReason: "stop",
      },
    }),
  );
  return frames;
}

export interface LiveStreamSettings {
  script: TurnScript;
  /** Delay between SSE chunks (one chunk per tick). */
  chunkIntervalMs: number;
  /** Progress callback: cumulative emitted chunk count and visible chars. */
  onProgress?: (chunks: number, chars: number) => void;
  /** Fired once after the `[DONE]` terminator is enqueued. */
  onDone?: () => void;
  /** Fired if the client aborted the stream (Stop button). */
  onAbort?: () => void;
}

/**
 * Build a synthetic SSE Response streaming the scripted turn, one chunk every
 * `chunkIntervalMs`. Honors the fetch `AbortSignal` so the real Stop button works.
 */
export function buildSseResponse(
  settings: LiveStreamSettings,
  signal?: AbortSignal | null,
): Response {
  const messageId = `m-live-${Date.now()}`;
  const frames = buildSseFrames(settings.script, messageId, "perf-chat");
  const encoder = new TextEncoder();
  let index = 0;
  let emittedChars = 0;
  let timer: number | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const stopPump = () => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
      };
      const pump = () => {
        timer = undefined;
        if (signal?.aborted) {
          stopPump();
          try {
            controller.close();
          } catch {
            // Already closed/cancelled — nothing to do.
          }
          return;
        }
        if (index >= frames.length) {
          try {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch {
            // Cancelled mid-flight.
          }
          settings.onDone?.();
          return;
        }
        const next = frames[index];
        index += 1;
        try {
          controller.enqueue(encoder.encode(next.data));
        } catch {
          stopPump();
          return;
        }
        emittedChars += next.chars;
        settings.onProgress?.(index, emittedChars);
        timer = window.setTimeout(pump, settings.chunkIntervalMs);
      };
      signal?.addEventListener(
        "abort",
        () => {
          stopPump();
          try {
            controller.close();
          } catch {
            // Reader already cancelled.
          }
          settings.onAbort?.();
        },
        { once: true },
      );
      timer = window.setTimeout(pump, settings.chunkIntervalMs);
    },
    cancel() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-vercel-ai-ui-message-stream": "v1",
    },
  });
}

// ---------------------------------------------------------------------------
// window.fetch patch
// ---------------------------------------------------------------------------

let currentLiveSettings: LiveStreamSettings | null = null;

/** Arm the next `/api/ai-chat/stream` request with a scripted turn. */
export function setLiveStreamSettings(settings: LiveStreamSettings): void {
  currentLiveSettings = settings;
}

/**
 * Patch `window.fetch` BEFORE React mounts: requests to `/api/ai-chat/stream`
 * get the synthetic SSE Response; everything else passes through untouched.
 */
export function installAiChatStreamFetchPatch(): void {
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.includes("/api/ai-chat/stream")) {
      const settings = currentLiveSettings;
      if (!settings) {
        return Promise.resolve(
          new Response("perf harness: no live stream configured", { status: 500 }),
        );
      }
      return Promise.resolve(buildSseResponse(settings, init?.signal ?? null));
    }
    return originalFetch(input, init);
  };
}
