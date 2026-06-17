import { Injectable, Logger } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import {
  streamText,
  generateText,
  convertToModelMessages,
  stepCountIs,
  type UIMessage,
  type LanguageModel,
} from 'ai';
import { AiService } from '../../integrations/ai/ai.service';
import { AiSettingsService } from '../../integrations/ai/ai-settings.service';
import { AiChatRepo } from '@docmost/db/repos/ai-chat/ai-chat.repo';
import { AiChatMessageRepo } from '@docmost/db/repos/ai-chat/ai-chat-message.repo';
import { User, Workspace, AiChatMessage } from '@docmost/db/types/entity.types';
import { AiChatToolsService } from './tools/ai-chat-tools.service';
import { McpClientsService } from './external-mcp/mcp-clients.service';
import { buildSystemPrompt } from './ai-chat.prompt';

/**
 * Payload accepted from the client `useChat` POST body. We do NOT bind a strict
 * DTO (the global ValidationPipe whitelist would strip the useChat-specific
 * fields), so this is a loose shape parsed straight off `req.body`.
 */
export interface AiChatStreamBody {
  chatId?: string;
  // useChat sends the full UIMessage list; the last one is the new user turn.
  messages?: UIMessage[];
}

export interface AiChatStreamArgs {
  user: User;
  workspace: Workspace;
  sessionId: string;
  body: AiChatStreamBody;
  res: FastifyReply;
  signal: AbortSignal;
  // Resolved by the controller BEFORE res.hijack(), so an unconfigured provider
  // (AiNotConfiguredException -> 503) surfaces as clean JSON before streaming.
  model: LanguageModel;
}

/**
 * Per-user AI chat orchestration (§6.1/§6.5/§6.7 stage 1).
 *
 * Message persistence shape (ai_chat_messages):
 *  - `role`        : 'user' | 'assistant'
 *  - `content`     : the message's plain text (assistant final text; user text).
 *                    The migration column is `text`, so plain text is stored.
 *  - `tool_calls`  : jsonb — the assistant's tool steps/calls/results for this
 *                    turn (trace; also surfaced in the UI as an action log).
 *  - `metadata`    : jsonb — the assistant message's reconstructable UIMessage
 *                    `parts` plus finishReason/usage, so multi-turn tool history
 *                    can be rebuilt for `convertToModelMessages`.
 */
@Injectable()
export class AiChatService {
  private readonly logger = new Logger(AiChatService.name);

  constructor(
    private readonly ai: AiService,
    private readonly aiChatRepo: AiChatRepo,
    private readonly aiChatMessageRepo: AiChatMessageRepo,
    private readonly aiSettings: AiSettingsService,
    private readonly tools: AiChatToolsService,
    private readonly mcpClients: McpClientsService,
  ) {}

  /**
   * Resolve the chat language model for the workspace. Exposed so the
   * controller can resolve it BEFORE res.hijack(): an unconfigured provider
   * throws AiNotConfiguredException there and returns a clean 503.
   */
  getChatModel(workspaceId: string): Promise<LanguageModel> {
    return this.ai.getChatModel(workspaceId);
  }

  async stream({
    user,
    workspace,
    sessionId,
    body,
    res,
    signal,
    model,
  }: AiChatStreamArgs): Promise<void> {
    // Resolve / create the chat. A new chat is created when no valid chatId is
    // supplied or the supplied one does not belong to this workspace.
    let isNewChat = false;
    let chatId = body.chatId;
    if (chatId) {
      const existing = await this.aiChatRepo.findById(chatId, workspace.id);
      if (!existing) {
        chatId = undefined;
      }
    }
    if (!chatId) {
      const chat = await this.aiChatRepo.insert({
        creatorId: user.id,
        workspaceId: workspace.id,
      });
      chatId = chat.id;
      isNewChat = true;
    }

    // Extract the incoming user turn (the last user message from useChat).
    const incoming = lastUserMessage(body.messages);
    const incomingText = uiMessageText(incoming);

    // Persist the user message before contacting the model.
    await this.aiChatMessageRepo.insert({
      chatId,
      workspaceId: workspace.id,
      userId: user.id,
      role: 'user',
      content: incomingText,
      // jsonb column: UIMessage parts are JSON-serializable at runtime but not
      // structurally `JsonValue`, so cast through unknown.
      metadata: (incoming?.parts
        ? { parts: incoming.parts }
        : null) as never,
    });

    // Rebuild the conversation from persisted history (not the client payload),
    // so the model always sees the authoritative server-side transcript. Load
    // the most RECENT tail (oldest -> newest) so chats longer than one page do
    // not drop recent turns (incl. the user message just inserted above).
    const history = await this.aiChatMessageRepo.findRecent(
      chatId,
      workspace.id,
      50,
    );
    const uiMessages = history.map(rowToUiMessage);
    // convertToModelMessages is async in ai@6.0.134 (returns Promise<ModelMessage[]>).
    const messages = await convertToModelMessages(uiMessages);

    // The model is resolved by the controller before hijack (clean 503 path).
    // Here we only need the admin-configured system prompt.
    const resolved = await this.aiSettings.resolve(workspace.id);
    const system = buildSystemPrompt({
      workspace,
      adminPrompt: resolved?.systemPrompt,
    });

    // Pass the resolved chatId so the write tools can mint provenance tokens
    // (access + collab) carrying { actor:'agent', aiChatId: chatId }, making
    // agent REST/collab writes attributable and non-spoofable (§6.5/§6.6).
    const docmostTools = await this.tools.forUser(
      user,
      sessionId,
      workspace.id,
      chatId,
    );

    // Merge in admin-configured external MCP tools (web search, etc.; §6.8).
    // A down/slow external server never crashes the turn — toolsFor skips it and
    // records the outcome. The returned client handles MUST be closed in the
    // streamText lifecycle (onFinish/onError/onAbort) — leaking them is a bug.
    // Docmost tools take precedence on a name clash (external are namespaced, so
    // a clash is not expected; the spread order makes intent explicit).
    let external: Awaited<ReturnType<McpClientsService['toolsFor']>> = {
      tools: {},
      clients: [],
      outcomes: [],
    };
    try {
      external = await this.mcpClients.toolsFor(workspace.id);
    } catch (err) {
      // Building the external toolset must never break the turn; proceed with
      // Docmost-only tools. Never log URLs/headers — short message only.
      this.logger.warn(
        `External MCP toolset unavailable: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
    const tools = { ...external.tools, ...docmostTools };

    // Close every external client EXACTLY ONCE across the turn's terminal
    // callbacks (onFinish/onError/onAbort all fire at most once collectively,
    // but guard anyway). Close errors are swallowed so they never break the
    // response.
    let clientsClosed = false;
    const closeExternalClients = async (): Promise<void> => {
      if (clientsClosed) return;
      clientsClosed = true;
      await Promise.all(
        external.clients.map((c) =>
          c.close().catch((closeErr) => {
            this.logger.warn(
              `Failed to close external MCP client: ${
                closeErr instanceof Error ? closeErr.message : 'unknown error'
              }`,
            );
          }),
        ),
      );
    };

    // Persist the assistant message. Used by onFinish (full result) and the
    // abort/error paths (partial result). Guarded so we persist at most once.
    let persisted = false;
    const persistAssistant = async (data: {
      text: string;
      toolCalls: unknown;
      metadata: Record<string, unknown>;
    }): Promise<void> => {
      if (persisted) return;
      persisted = true;
      try {
        await this.aiChatMessageRepo.insert({
          chatId,
          workspaceId: workspace.id,
          userId: user.id,
          role: 'assistant',
          content: data.text ?? '',
          toolCalls: (data.toolCalls ?? null) as never,
          metadata: data.metadata as never,
        });
      } catch (err) {
        this.logger.error('Failed to persist assistant message', err as Error);
      }
    };

    // NOTE: streamText is synchronous in v6 — do NOT await it. A synchronous
    // failure here (or in pipe below) would skip the terminal callbacks, so the
    // catch releases the leased external clients to avoid a connection leak.
    let result: ReturnType<typeof streamText>;
    try {
      result = streamText({
      model,
      system,
      messages,
      tools,
      // No maxOutputTokens cap on the agent: tool-call arguments (e.g. a full
      // page body for the write tools) are emitted as OUTPUT tokens, so a fixed
      // cap would truncate complex tool calls mid-argument. Let the model use its
      // natural per-step budget. (Cost/credit limits are an account concern, not
      // something to enforce by silently breaking the agent.)
      stopWhen: stepCountIs(8),
      abortSignal: signal,
      onFinish: async ({ text, finishReason, totalUsage, steps }) => {
        await persistAssistant({
          text,
          toolCalls: serializeSteps(steps),
          metadata: {
            finishReason,
            usage: totalUsage,
            // Persist the FULL set of UIMessage parts for the turn (text +
            // tool-call/result), so the rebuilt history replays prior tool
            // context to the model on later turns.
            parts: assistantParts(steps, text),
          },
        });
        // Lifecycle: release the external MCP clients leased for this turn.
        await closeExternalClients();
      },
      onError: async ({ error }) => {
        // NestJS Logger.error(message, stack?, context?): pass the real message
        // (with statusCode when present) + the stack string, not the Error
        // object, so the actual provider cause is clearly logged.
        const e = error as {
          statusCode?: number;
          message?: string;
          stack?: string;
        };
        const errorText = e?.statusCode
          ? `${e.statusCode}: ${e.message ?? String(error)}`
          : (e?.message ?? String(error));
        this.logger.error(`AI chat stream error: ${errorText}`, e?.stack);
        // Persist whatever text we have (likely empty) so the turn is recorded,
        // and record the error text in metadata so it is visible in history.
        await persistAssistant({
          text: '',
          toolCalls: null,
          metadata: { finishReason: 'error', parts: [], error: errorText },
        });
        await closeExternalClients();
      },
      onAbort: async ({ steps }) => {
        // Client disconnected / request aborted: persist the partial answer,
        // including any completed tool steps so the turn replays faithfully.
        const text = steps.map((s) => s.text ?? '').join('');
        await persistAssistant({
          text,
          toolCalls: serializeSteps(steps),
          metadata: {
            finishReason: 'aborted',
            parts: assistantParts(steps, text),
          },
        });
        await closeExternalClients();
      },
      });

      // Fire-and-forget async title generation for a freshly created chat. Never
      // block the stream on it; swallow any error.
      if (isNewChat && incomingText) {
        void this.generateTitle(chatId, workspace.id, incomingText).catch(
          (err) => {
            this.logger.warn(
              `Title generation failed: ${(err as Error)?.message ?? err}`,
            );
          },
        );
      }

      // Stream the UI-message protocol straight to the hijacked Node response.
      // Without onError the AI SDK masks the cause ('An error occurred.') and the
      // UI shows a generic failure. Surface the real provider message instead.
      // AI SDK error messages / 4xx bodies never contain the API key, so this is
      // safe; we never dump the resolved config/apiKey.
      result.pipeUIMessageStreamToResponse(res.raw, {
        onError: (error: unknown) => {
          const e = error as { statusCode?: number; message?: string };
          return e?.statusCode
            ? `${e.statusCode}: ${e.message}`
            : (e?.message ?? 'AI stream error');
        },
      });
    } catch (err) {
      // Synchronous failure before/while wiring the stream: the terminal
      // callbacks will not run, so release the leased external clients here and
      // re-throw for the controller to surface on the socket.
      await closeExternalClients();
      throw err;
    }
  }

  /**
   * Cheap, non-blocking title generation from the first user message. Uses
   * generateText (async) and writes the result back onto the chat row. Any
   * failure is caught by the caller — title is best-effort cosmetic metadata.
   */
  private async generateTitle(
    chatId: string,
    workspaceId: string,
    firstMessage: string,
  ): Promise<void> {
    const model = await this.ai.getChatModel(workspaceId);
    const { text } = await generateText({
      model,
      system:
        'Generate a short, descriptive chat title (max 6 words) for the ' +
        "user's first message. Reply with the title only — no quotes, no " +
        'punctuation at the end.',
      prompt: firstMessage.slice(0, 2000),
    });
    const title = text.trim().replace(/^["']|["']$/g, '').slice(0, 120);
    if (title) {
      await this.aiChatRepo.update(chatId, { title }, workspaceId);
    }
  }
}

/** The last message with role 'user' from a useChat payload, if any. */
function lastUserMessage(
  messages: UIMessage[] | undefined,
): UIMessage | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return messages[i];
  }
  return undefined;
}

/** Concatenate the text parts of a UIMessage into a plain string. */
function uiMessageText(message: UIMessage | undefined): string {
  if (!message?.parts) return '';
  return message.parts
    .filter((p): p is { type: 'text'; text: string } => p?.type === 'text')
    .map((p) => p.text)
    .join('');
}

/** Build a single text part array (or empty when there is no text). */
function textPart(text: string): Array<{ type: 'text'; text: string }> {
  return text ? [{ type: 'text', text }] : [];
}

/**
 * Minimal shapes of the AI SDK v6 step objects we read to rebuild UIMessage
 * parts (see ai@6.0.134 `StepResult`: `text`, `toolCalls` -> TypedToolCall,
 * `toolResults` -> TypedToolResult). Typed loosely so this survives provider
 * variation; only the fields we persist are referenced.
 */
type StepLike = {
  text?: string;
  toolCalls?: ReadonlyArray<{
    toolCallId?: string;
    toolName?: string;
    input?: unknown;
  }>;
  toolResults?: ReadonlyArray<{
    toolCallId?: string;
    toolName?: string;
    output?: unknown;
  }>;
};

/**
 * Rebuild the FULL UIMessage `parts` for an assistant turn from the SDK steps,
 * so multi-turn history replays prior tool-calls/results to the model (not just
 * the final text). Per step we emit the step's text part (if any) followed by a
 * static `tool-${name}` UI part per tool call — `output-available` when the
 * tool returned, or a synthetic `output-error` when it did not (so the call is
 * never persisted unpaired). Both shapes `convertToModelMessages` consumes on
 * the next turn map to a balanced assistant `tool-call` + tool-message
 * `tool-result`; a bare `input-available` would instead replay as an unpaired
 * call and throw MissingToolResultsError. Tools here are statically named, so
 * `tool-${name}` (not `dynamic-tool`) is faithful and `getStaticToolName`
 * recovers the name. Falls back to a single `text` part built from
 * `fallbackText` when the steps carry no text.
 */
function assistantParts(
  steps: ReadonlyArray<StepLike> | undefined,
  fallbackText: string,
): UIMessage['parts'] {
  const parts: Array<Record<string, unknown>> = [];
  let sawText = false;
  for (const step of steps ?? []) {
    if (step.text) {
      parts.push({ type: 'text', text: step.text });
      sawText = true;
    }
    // Index this step's results by tool call id to pair calls with outputs.
    const resultsById = new Map<string, unknown>();
    for (const r of step.toolResults ?? []) {
      if (r.toolCallId) resultsById.set(r.toolCallId, r.output);
    }
    for (const call of step.toolCalls ?? []) {
      if (!call.toolName || !call.toolCallId) continue;
      const hasResult = resultsById.has(call.toolCallId);
      if (hasResult) {
        // output-available: the tool returned; the next turn replays its result.
        parts.push({
          type: `tool-${call.toolName}`,
          toolCallId: call.toolCallId,
          state: 'output-available',
          input: call.input,
          output: resultsById.get(call.toolCallId),
        });
      } else {
        // No paired result (e.g. aborted mid-step). Persisting a bare
        // tool-call (input-available) would replay as an unpaired call and
        // throw MissingToolResultsError on the next turn (convertToModelMessages
        // emits no tool-result for it). Emit a SYNTHETIC paired result instead:
        // an output-error round-trips through convertToModelMessages as a
        // balanced tool-call + tool-result, keeping the rebuilt history valid.
        parts.push({
          type: `tool-${call.toolName}`,
          toolCallId: call.toolCallId,
          state: 'output-error',
          input: call.input,
          errorText: 'Tool call did not complete.',
        });
      }
    }
  }
  if (!sawText && fallbackText) {
    // No per-step text (e.g. a single final block): append the final text after
    // any tool parts so the natural call -> result -> answer order is preserved.
    parts.push({ type: 'text', text: fallbackText });
  }
  return parts as UIMessage['parts'];
}

/**
 * Map a persisted message row back to a UIMessage. User messages restore their
 * stored parts when available; assistant messages restore the reconstructable
 * parts from metadata, falling back to a single text part from `content`.
 */
function rowToUiMessage(row: AiChatMessage): Omit<UIMessage, 'id'> & {
  id: string;
} {
  const role = row.role === 'assistant' ? 'assistant' : 'user';
  const meta = (row.metadata ?? {}) as { parts?: UIMessage['parts'] };
  const parts =
    Array.isArray(meta.parts) && meta.parts.length > 0
      ? meta.parts
      : textPart(row.content ?? '');
  return { id: row.id, role, parts: parts as UIMessage['parts'] };
}

/**
 * Reduce SDK step objects to a compact, JSON-serializable trace for the
 * `tool_calls` column. Stores only what the UI action-log and history need —
 * never raw provider payloads or keys.
 */
function serializeSteps(
  steps: ReadonlyArray<{
    toolCalls?: ReadonlyArray<{ toolName?: string; input?: unknown }>;
    toolResults?: ReadonlyArray<{ toolName?: string; output?: unknown }>;
  }>,
): unknown {
  const calls: Array<{ toolName?: string; input?: unknown; output?: unknown }> =
    [];
  for (const step of steps ?? []) {
    for (const call of step.toolCalls ?? []) {
      calls.push({ toolName: call.toolName, input: call.input });
    }
    for (const r of step.toolResults ?? []) {
      calls.push({ toolName: r.toolName, output: r.output });
    }
  }
  return calls.length > 0 ? calls : null;
}
