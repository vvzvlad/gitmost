import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
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
import { describeProviderError } from '../../integrations/ai/ai-error.util';
import { AiChatRepo } from '@docmost/db/repos/ai-chat/ai-chat.repo';
import { AiChatMessageRepo } from '@docmost/db/repos/ai-chat/ai-chat-message.repo';
import { AiAgentRoleRepo } from '@docmost/db/repos/ai-agent-roles/ai-agent-roles.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageAccessService } from '../page/page-access/page-access.service';
import {
  User,
  Workspace,
  AiChatMessage,
  AiAgentRole,
} from '@docmost/db/types/entity.types';
import { AiChatToolsService } from './tools/ai-chat-tools.service';
import { McpClientsService } from './external-mcp/mcp-clients.service';
import { buildSystemPrompt } from './ai-chat.prompt';
import { roleModelOverride } from './roles/role-model-config';

// Max agent steps per turn. One step = one model generation; a step that calls
// tools is followed by another step carrying the tool results. Raised from 8 so
// multi-search research questions are not cut off mid-investigation.
const MAX_AGENT_STEPS = 20;

// System-prompt addendum injected ONLY on the final step (see prepareAgentStep).
// It forbids further tool calls and tells the model to synthesize the best
// answer it can from what it already gathered, so a tool-heavy turn never ends
// empty.
const FINAL_STEP_INSTRUCTION =
  'You have reached the maximum number of tool-use steps for this turn. ' +
  'Do NOT call any more tools. Using only the information already gathered, ' +
  "write the most complete, useful final answer you can now, in the user's " +
  'language. If the information is incomplete, say so explicitly: summarize ' +
  'what you found, what is still missing, and give your best partial conclusion.';

// Pure, unit-testable: decide per-step overrides. Returns undefined for normal
// steps; on the final allowed step forces a text-only synthesis answer.
// `system` is the in-scope system prompt; we CONCATENATE so the original
// persona/context is preserved — a bare `system` override would REPLACE the
// whole system prompt for the step.
//
// NOTE: at AI SDK v7 the per-step `system` field is renamed to `instructions`.
// On v6 (`^6.0.134`) `system` is the correct field — adjust when bumping.
export function prepareAgentStep(
  stepNumber: number,
  system: string,
): { toolChoice: 'none'; system: string } | undefined {
  if (stepNumber >= MAX_AGENT_STEPS - 1) {
    return { toolChoice: 'none', system: `${system}\n\n${FINAL_STEP_INSTRUCTION}` };
  }
  return undefined;
}

export { MAX_AGENT_STEPS, FINAL_STEP_INSTRUCTION };

/**
 * Payload accepted from the client `useChat` POST body. We do NOT bind a strict
 * DTO (the global ValidationPipe whitelist would strip the useChat-specific
 * fields), so this is a loose shape parsed straight off `req.body`.
 */
export interface AiChatStreamBody {
  chatId?: string;
  // The agent role selected by the client. Honoured ONLY when creating a new
  // chat (no valid chatId) — it is persisted to ai_chats.role_id and is
  // immutable afterwards. For existing chats the role is read from the chat row,
  // never from this field, so it cannot be swapped per-turn.
  roleId?: string | null;
  // The page the user is currently viewing (client-supplied), or null on a
  // non-page route. Used ONLY as prompt context so the agent knows what "this
  // page" refers to; the page itself is never fetched server-side here. The id
  // is attacker-controllable but harmless: the agent reads/writes via its
  // CASL-enforced page tools, which 403 on a page the user cannot access.
  openPage?: { id?: string; title?: string } | null;
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
  // For a role with a model override this already carries the override-resolved
  // model (or the controller threw a 503 if the override driver was unconfigured).
  model: LanguageModel;
  // The agent role to apply this turn, pre-resolved by the controller from the
  // chat row (existing chat) or the request body (new chat). null => universal
  // assistant. Carried here so the turn never re-loads it.
  role: AiAgentRole | null;
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
    private readonly aiAgentRoleRepo: AiAgentRoleRepo,
    private readonly pageRepo: PageRepo,
    private readonly pageAccess: PageAccessService,
  ) {}

  /**
   * Resolve the agent role that applies to this stream request, scoped to the
   * workspace and soft-delete aware. For an EXISTING chat the role is read from
   * `ai_chats.role_id` (authoritative — never from the body). For a NEW chat
   * (no valid chatId) the role comes from the request body's `roleId`. Returns
   * null for the universal assistant or when the referenced role is missing /
   * soft-deleted.
   */
  async resolveRoleForRequest(
    workspace: Workspace,
    body: AiChatStreamBody,
  ): Promise<AiAgentRole | null> {
    let roleId: string | null | undefined;
    if (body.chatId) {
      const chat = await this.aiChatRepo.findById(body.chatId, workspace.id);
      // A valid existing chat fixes the role from its own row.
      if (chat) roleId = chat.roleId;
      else roleId = body.roleId; // stale chatId => treated as a new chat
    } else {
      roleId = body.roleId;
    }
    if (!roleId) return null;
    // A disabled or soft-deleted role falls back to the universal assistant: it
    // must not apply its persona/model override even to a chat that was bound to
    // it earlier. findLiveEnabled enforces this (live + enabled + workspace
    // scope), server-authoritatively, for both the new-chat (body.roleId) and
    // existing-chat (chat.role_id) paths — the single shared invariant.
    return (
      (await this.aiAgentRoleRepo.findLiveEnabled(roleId, workspace.id)) ?? null
    );
  }

  /**
   * Resolve the chat language model for the workspace, applying the role's
   * optional model override. Exposed so the controller can resolve it BEFORE
   * res.hijack(): an unconfigured provider (incl. a role pointing at an
   * unconfigured driver) throws AiNotConfiguredException there and returns a
   * clean 503 instead of breaking mid-stream.
   */
  getChatModel(
    workspaceId: string,
    role?: AiAgentRole | null,
  ): Promise<LanguageModel> {
    return this.ai.getChatModel(workspaceId, roleModelOverride(role));
  }

  async stream({
    user,
    workspace,
    sessionId,
    body,
    res,
    signal,
    model,
    role,
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
      // Resolve the origin document for the history list. body.openPage.id is
      // attacker-controllable, so validate it before persisting: it must be a
      // real page in THIS workspace that the user is allowed to read. Anything
      // else (foreign workspace, inaccessible/restricted, or non-existent) is
      // dropped to null — persisting it would leak the page's title via the
      // chat-list join, or violate the page_id FK on insert (this runs after
      // res.hijack(), so a DB error would break the stream).
      let originPageId: string | null = null;
      const candidatePageId = body.openPage?.id;
      if (candidatePageId) {
        const page = await this.pageRepo.findById(candidatePageId);
        if (page && page.workspaceId === workspace.id) {
          try {
            await this.pageAccess.validateCanView(page, user);
            originPageId = page.id;
          } catch (e) {
            // Fail-closed: no provenance on any failure. A ForbiddenException is
            // the expected "user cannot read this page" case; log anything else
            // (e.g. a DB error) so a real fault is not masked as "no access".
            if (!(e instanceof ForbiddenException)) {
              this.logger.warn(
                `origin page access check failed: ${
                  e instanceof Error ? e.message : 'unknown error'
                }`,
              );
            }
            originPageId = null;
          }
        }
      }
      const chat = await this.aiChatRepo.insert({
        creatorId: user.id,
        workspaceId: workspace.id,
        // Bind the chat to the resolved role (if any) at creation time. The role
        // is immutable afterwards (later turns read it from this column).
        roleId: role?.id ?? null,
        // Validated above: a real, readable page in this workspace, else null.
        pageId: originPageId,
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
      // The role (pre-resolved by the controller) REPLACES the persona layer;
      // the safety framework is still appended by buildSystemPrompt.
      roleInstructions: role?.instructions,
      openedPage: body.openPage,
    });

    // Pass the resolved chatId so the write tools can mint provenance tokens
    // (access + collab) carrying { actor:'agent', aiChatId: chatId }, making
    // agent REST/collab writes attributable and non-spoofable (§6.5/§6.6).
    const docmostTools = await this.tools.forUser(
      user,
      sessionId,
      workspace.id,
      chatId,
      // Same open-page value used by the system prompt above; exposed to the
      // model via getCurrentPage so page identity survives prompt mangling.
      body.openPage,
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

    // Accumulate the turn's streamed output so a provider error / disconnect can
    // persist the PARTIAL answer the user already saw — the SDK's onError/onAbort
    // callbacks don't hand us the in-progress text. `capturedSteps` holds finished
    // steps (tool calls + their text); `inProgressText` holds the text streamed in
    // the CURRENT, not-yet-finished step, reset whenever a step finishes.
    const capturedSteps: StepLike[] = [];
    let inProgressText = '';

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
      stopWhen: stepCountIs(MAX_AGENT_STEPS),
      // Forced finalization: reserve the LAST allowed step for a text-only
      // answer. Without this, a turn that spends all its steps on tool calls
      // ends with no assistant text (an empty turn). prepareAgentStep forbids
      // further tool calls and appends a synthesis instruction on that step,
      // concatenated onto the original `system` so the persona is preserved.
      prepareStep: ({ stepNumber }) => prepareAgentStep(stepNumber, system),
      abortSignal: signal,
      onChunk: ({ chunk }) => {
        // 'text-delta' is the assistant's prose; tool-call args are separate chunk
        // types — so this mirrors exactly what streams to the client.
        if (chunk.type === 'text-delta') inProgressText += chunk.text;
      },
      onStepFinish: (step) => {
        // The finished step's full text is now in `step.text`; fold it in and reset
        // the in-progress accumulator for the next step.
        capturedSteps.push(step as StepLike);
        inProgressText = '';
      },
      onFinish: async ({ text, finishReason, totalUsage, usage, steps }) => {
        await persistAssistant({
          text,
          toolCalls: serializeSteps(steps),
          metadata: {
            finishReason,
            usage: totalUsage,
            // Final-step usage = the context actually fed to the model on the last LLM
            // call (full history + tool results) plus the answer it just generated.
            // input+output of the FINAL step ≈ the conversation's CURRENT context size,
            // distinct from totalUsage which sums every step (cumulative tokens spent).
            contextTokens:
              (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) || undefined,
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
        // object, so the actual provider cause is clearly logged. Reuse the
        // shared formatter so provider error formatting stays unified.
        const e = error as { stack?: string };
        const errorText = describeProviderError(error, String(error));
        this.logger.error(`AI chat stream error: ${errorText}`, e?.stack);
        // Persist the PARTIAL answer streamed before the failure (text + any
        // finished tool steps) WITH the error in metadata, so the turn shows what
        // the user already saw plus the cause — not just a bare error.
        await persistAssistant(
          buildPartialAssistantRecord(
            capturedSteps,
            inProgressText,
            'error',
            errorText,
          ),
        );
        await closeExternalClients();
      },
      onAbort: async ({ steps }) => {
        const partialChars =
          capturedSteps.reduce((n, s) => n + (s.text?.length ?? 0), 0) +
          inProgressText.length;
        // Unlike onError/onFinish, this terminal path otherwise writes nothing, so
        // an aborted turn (client disconnect / proxy drop / stop()) would be
        // invisible in the logs. Log it (warn) so the abort is traceable.
        this.logger.warn(
          `AI chat stream aborted (chat ${chatId}) after ${steps.length} ` +
            `step(s), ${partialChars} chars partial text; persisting partial turn.`,
        );
        await persistAssistant(
          buildPartialAssistantRecord(capturedSteps, inProgressText, 'aborted'),
        );
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
      //
      // SSE buffering / proxy note: pipeUIMessageStreamToResponse writes the
      // headers immediately (res.writeHead) and each chunk incrementally, and the
      // SDK's default UI_MESSAGE_STREAM_HEADERS already include
      // `x-accel-buffering: no` (disables nginx response buffering) plus
      // `content-type: text/event-stream` and `cache-control: no-cache`. We pass
      // `headers` explicitly anyway so the intent is visible here and survives any
      // future change to the SDK defaults (prepareHeaders only fills a header when
      // absent, so this never clobbers the SDK's content-type). DEPLOYMENT: the
      // reverse proxy in front of this server MUST NOT buffer this route, or the
      // whole response is released at once and nothing streams. nginx honours the
      // `x-accel-buffering: no` header we send (and additionally set
      // `proxy_buffering off; proxy_cache off;` for /api/ai-chat/stream); traefik
      // does not buffer responses by default.
      result.pipeUIMessageStreamToResponse(res.raw, {
        headers: { 'X-Accel-Buffering': 'no' },
        // Surface the authoritative chatId on the streamed assistant UI message so
        // the client adopts the REAL id of the row we created, instead of guessing
        // the newest chat in its list. `messageMetadata` is invoked by the AI SDK
        // on the `start` and `finish` stream parts (ai@6); we attach `chatId` on the
        // `start` part so it reaches the client (as message.metadata.chatId) at the
        // very first chunk — before any second tab can race a newer chat into the
        // list. This fixes the two-tab "adoption race" (#137) where a new chat in
        // tab A could adopt tab B's id and leak its turns into the wrong row.
        messageMetadata: ({ part }) =>
          part.type === 'start' ? { chatId } : undefined,
        onError: (error: unknown) => {
          // Reuse the shared formatter so provider error formatting stays
          // unified between the log line and the streamed error message.
          return describeProviderError(error, 'AI stream error');
        },
      });

      // Force the status line + headers onto the socket NOW (before the model's
      // first token), so the proxy sees the response start immediately even if the
      // provider's first chunk is delayed. writeToServerResponse already called
      // writeHead synchronously above; flushHeaders is a belt-and-braces no-op once
      // headers are sent, and is guarded for response-likes that lack it.
      res.raw.flushHeaders?.();
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
 * Compaction tunables for persisted tool OUTPUTS. Read tools (getPage,
 * getPageJson, getNode, diffPageVersions, exportPageMarkdown, ...) return whole
 * pages with no size cap. Their outputs are stored in `metadata.parts` and
 * RE-SENT to the provider on every later turn via convertToModelMessages, so an
 * uncompacted large body grows token cost, latency, and DB row size on every
 * turn. We shrink the big payloads while preserving the object's shape and its
 * small scalar fields (id/title/pageId) the client reads to render citations.
 */
// Only outputs whose JSON serialization exceeds this are compacted at all
// (fast path: smaller outputs are returned unchanged, by identity).
const MAX_TOOL_OUTPUT_BYTES = 4000;
// A string longer than this is truncated to a leading preview.
const TOOL_OUTPUT_STRING_LIMIT = 600;
// Number of leading characters kept from a truncated string.
const TOOL_OUTPUT_STRING_PREVIEW = 500;
// Maximum number of array elements kept; the rest are summarized by a marker.
const TOOL_OUTPUT_ARRAY_LIMIT = 50;
// Beyond this nesting depth a subtree is replaced with a marker, bounding the
// recursion and the size of pathological deeply-nested payloads.
const TOOL_OUTPUT_MAX_DEPTH = 8;

/**
 * Recursively compact a single tool output before it is persisted (and thus
 * re-sent to the provider on later turns). Preserves the value's KIND and its
 * keys/scalars (so the client can still extract id/title/pageId citations from
 * `part.output`); only the large payloads (long strings, long arrays, very deep
 * subtrees) are shrunk. Returns a plain JSON-serializable value.
 *
 * Exported only so the unit test can import the pure helper; exporting it does
 * not change runtime behavior.
 */
export function compactToolOutput(output: unknown): unknown {
  // Fast path: nothing to do for null/undefined or non-serializable values.
  if (output === null || output === undefined) return output;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(output);
  } catch {
    // Non-serializable (e.g. circular): return unchanged, never throw here.
    return output;
  }
  // JSON.stringify returns undefined for values like a bare function/symbol.
  if (serialized === undefined) return output;
  // Below the size threshold: return the original unchanged (by identity).
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_TOOL_OUTPUT_BYTES) {
    return output;
  }
  return compactValue(output, 0);
}

/** Recursive worker for compactToolOutput; see the constants above for limits. */
function compactValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    if (value.length > TOOL_OUTPUT_STRING_LIMIT) {
      return `${value.slice(0, TOOL_OUTPUT_STRING_PREVIEW)}…[truncated ${
        value.length - TOOL_OUTPUT_STRING_PREVIEW
      } chars]`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    const kept = value
      .slice(0, TOOL_OUTPUT_ARRAY_LIMIT)
      .map((el) => compactValue(el, depth + 1));
    if (value.length > TOOL_OUTPUT_ARRAY_LIMIT) {
      // Append a marker summarizing the dropped tail so the size is bounded
      // while signalling that the array was longer.
      kept.push({
        _truncated: true,
        omittedItems: value.length - TOOL_OUTPUT_ARRAY_LIMIT,
      });
    }
    return kept;
  }
  if (typeof value === 'object' && value !== null) {
    if (depth >= TOOL_OUTPUT_MAX_DEPTH) {
      return { _truncated: true, note: 'nested content omitted for replay' };
    }
    // Rebuild the object preserving keys (keeps id/title/pageId), compacting
    // each value one level deeper.
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = compactValue(v, depth + 1);
    }
    return out;
  }
  // Numbers, booleans, etc.: nothing to shrink.
  return value;
}

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
// Exported only so the unit tests can import these pure helpers; exporting
// them does not change runtime behavior.
export function assistantParts(
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
          output: compactToolOutput(resultsById.get(call.toolCallId)),
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
export function rowToUiMessage(row: AiChatMessage): Omit<UIMessage, 'id'> & {
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
 * Build the assistant-message record persisted on a partial/failed turn (the
 * streamText onError / onAbort paths). Captures the partial answer the user
 * already saw: each finished step's text + tool parts (via assistantParts),
 * then the in-progress step's text appended last. When `errorText` is provided
 * it is recorded in metadata.error so the cause shows in history; an aborted
 * turn passes none. Pure, so the partial-recording shape is unit-testable
 * without seaming streamText.
 */
export function buildPartialAssistantRecord(
  steps: ReadonlyArray<StepLike> | undefined,
  inProgressText: string,
  finishReason: 'error' | 'aborted',
  errorText?: string,
): { text: string; toolCalls: unknown; metadata: Record<string, unknown> } {
  const finished = steps ?? [];
  const stepsText = finished.map((s) => s.text ?? '').join('');
  const trailing = inProgressText ?? '';
  // assistantParts emits text parts only for FINISHED steps; append the
  // in-progress step's text (the answer cut off by the error) as the last text
  // part so the persisted parts match what streamed to the client.
  const parts = assistantParts(finished, '') as unknown as Array<
    Record<string, unknown>
  >;
  if (trailing) parts.push({ type: 'text', text: trailing });
  return {
    text: stepsText + trailing,
    toolCalls: serializeSteps(finished),
    metadata: {
      finishReason,
      parts: parts as unknown as UIMessage['parts'],
      ...(errorText ? { error: errorText } : {}),
    },
  };
}

/**
 * Reduce SDK step objects to a compact, JSON-serializable trace for the
 * `tool_calls` column. Stores only what the UI action-log and history need —
 * never raw provider payloads or keys.
 */
export function serializeSteps(
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
      calls.push({ toolName: r.toolName, output: compactToolOutput(r.output) });
    }
  }
  return calls.length > 0 ? calls : null;
}
