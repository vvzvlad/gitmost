import {
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
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
import { AiChatPageSnapshotRepo } from '@docmost/db/repos/ai-chat/ai-chat-page-snapshot.repo';
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
import { computePageChange } from './page-change/page-change.util';
import { roleModelOverride } from './roles/role-model-config';
import {
  startSseHeartbeat,
  stripStreamingHopByHopHeaders,
} from './sse-resilience';

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
    return {
      toolChoice: 'none',
      system: `${system}\n\n${FINAL_STEP_INSTRUCTION}`,
    };
  }
  return undefined;
}

export { MAX_AGENT_STEPS, FINAL_STEP_INSTRUCTION };

// Pure, unit-testable post-processing for a model-generated title (#199): trim
// whitespace, strip a single pair of surrounding quotes the model often adds,
// drop a trailing period, and hard-cap the length to the page-title column.
export function cleanGeneratedTitle(text: string): string {
  return text
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\.+$/, '')
    .trim()
    .slice(0, 255);
}

/**
 * Pure, unit-testable (#198): decide whether THIS turn is an interrupt-resume,
 * i.e. it directly follows a user interruption of the previous (still-partial)
 * assistant turn. The client "send now" flag is only a HINT — confirm it against
 * the just-loaded history so a spoofed/stale flag cannot inject the interrupt
 * note onto an ordinary turn.
 *
 * `history` is the model history oldest -> newest, with the just-inserted user
 * row as its tail; the turn before it is `history[len-2]`. We treat the new turn
 * as an interrupt-resume only when the client said so AND the preceding assistant
 * turn really ended unfinished: 'aborted' (onAbort already finalized it), or
 * still 'streaming' (onAbort has not finalized yet — the abort/resend race; the
 * partial output is already in history thanks to the step-granular write path).
 */
export function isInterruptResume(
  history: Array<{ role: string; status?: string | null }>,
  clientInterrupted: boolean | undefined,
): boolean {
  if (clientInterrupted !== true) return false;
  const prev = history[history.length - 2];
  return (
    prev?.role === 'assistant' &&
    (prev.status === 'aborted' || prev.status === 'streaming')
  );
}

/**
 * Whether two timestamps refer to the SAME instant (#274 page-change fast path).
 * The snapshot's `pageUpdatedAt` comes back from Postgres as a Date, the live
 * page's `updatedAt` is a Date too; compare by epoch millis so a value that
 * round-tripped through the driver as a string still matches. Either side
 * missing => treat as different (fall through to the diff, never a false skip).
 */
export function sameInstant(
  a: Date | string | null | undefined,
  b: Date | string | null | undefined,
): boolean {
  if (a == null || b == null) return false;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
  return ta === tb;
}

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
  // Set by the client "send now" action (#198): this turn immediately follows a
  // user interruption of the previous turn. A hint only — the server re-confirms
  // it against persisted history (`isInterruptResume`) before injecting the
  // interrupt note, so a spoofed/stale flag on an ordinary turn is ignored.
  interrupted?: boolean;
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
export class AiChatService implements OnModuleInit {
  private readonly logger = new Logger(AiChatService.name);

  constructor(
    private readonly ai: AiService,
    private readonly aiChatRepo: AiChatRepo,
    private readonly aiChatMessageRepo: AiChatMessageRepo,
    private readonly aiChatPageSnapshotRepo: AiChatPageSnapshotRepo,
    private readonly aiSettings: AiSettingsService,
    private readonly tools: AiChatToolsService,
    private readonly mcpClients: McpClientsService,
    private readonly aiAgentRoleRepo: AiAgentRoleRepo,
    private readonly pageRepo: PageRepo,
    private readonly pageAccess: PageAccessService,
  ) {}

  /**
   * Crash-recovery sweep on server start (#183): any assistant row left in the
   * 'streaming' state is the relic of a turn whose process died before it
   * reached a terminal status. Flip those to 'aborted' so history/export show
   * them settled (with whatever finished steps were already persisted) instead
   * of perpetually "streaming". Best-effort: a sweep failure is logged but must
   * never block server startup.
   */
  async onModuleInit(): Promise<void> {
    try {
      const swept = await this.aiChatMessageRepo.sweepStreaming();
      if (swept > 0) {
        this.logger.log(
          `Startup sweep: marked ${swept} dangling 'streaming' assistant ` +
            `message(s) as 'aborted'.`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Startup sweep of dangling 'streaming' messages failed: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
  }

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

  /**
   * Validate the client-supplied open page and return its AUTHORITATIVE identity
   * ({ id, title }) or null. The client controls BOTH the id and the title in the
   * request body, so neither is trusted: the id must resolve to a real page in
   * THIS workspace that the user may read, and the title is taken from the DB row
   * (never the client) so the model can't be told it is "on Page A" while the id
   * points at page B (#159). Fail-closed — any missing / foreign / inaccessible
   * page, or any non-Forbidden access-check fault, returns null.
   */
  private async resolveOpenPageContext(
    openPage: { id?: string; title?: string } | null | undefined,
    workspace: Workspace,
    user: User,
  ): Promise<{ id: string; title: string; updatedAt: Date } | null> {
    const candidatePageId = openPage?.id;
    if (!candidatePageId) return null;
    const page = await this.pageRepo.findById(candidatePageId);
    if (!page || page.workspaceId !== workspace.id) return null;
    try {
      await this.pageAccess.validateCanView(page, user);
    } catch (e) {
      // A ForbiddenException is the expected "user cannot read this page" case;
      // log anything else (e.g. a DB error) so a real fault is not masked.
      if (!(e instanceof ForbiddenException)) {
        this.logger.warn(
          `open page access check failed: ${
            e instanceof Error ? e.message : 'unknown error'
          }`,
        );
      }
      return null;
    }
    // updatedAt is the page's last-modified instant, used by the #274 per-turn
    // page-change detection as a cheap fast path (unchanged instant => skip the
    // render + diff). The system-prompt / tool consumers ignore the extra field.
    return { id: page.id, title: page.title ?? '', updatedAt: page.updatedAt };
  }

  /**
   * Per-turn page-change detection (#274). The agent rebuilds its context from the
   * DB each turn and otherwise cannot tell that the user hand-edited the open page
   * since it last spoke — so it can silently overwrite those edits. This compares
   * the page's CURRENT Markdown against the snapshot taken at the END of the
   * agent's previous turn (see `snapshotOpenPage`) and, when a human changed
   * something in between, returns a `{ title, diff }` the caller feeds to
   * `buildSystemPrompt` as an ephemeral note.
   *
   * Edge cases: page not open / no snapshot (first turn) / page untouched since
   * the snapshot (updatedAt fast path) / empty-after-normalization diff => null
   * (no note). Best-effort: any fault is logged and downgraded to "no note" so it
   * never breaks the turn.
   */
  private async detectPageChange(
    chatId: string,
    openPageContext: { id: string; title: string; updatedAt: Date } | null,
    workspace: Workspace,
    user: User,
    sessionId: string,
  ): Promise<{ title: string; diff: string } | null> {
    if (!openPageContext) return null;
    try {
      const snapshot = await this.aiChatPageSnapshotRepo.findByChatPage(
        chatId,
        openPageContext.id,
        workspace.id,
      );
      // No snapshot yet => first turn on this page; there is nothing to diff
      // against. onFinish seeds it; the note starts from the NEXT turn.
      if (!snapshot) return null;
      // Fast path: the page has not been touched since the snapshot instant, so
      // nothing changed — skip the render + diff entirely.
      if (sameInstant(snapshot.pageUpdatedAt, openPageContext.updatedAt)) {
        return null;
      }
      // Render the current page the SAME way the snapshot end was rendered, so
      // pure formatting never registers as a change.
      const currentMd = await this.tools.exportPageMarkdown(
        user,
        sessionId,
        workspace.id,
        chatId,
        openPageContext.id,
      );
      const change = computePageChange(snapshot.contentMd, currentMd);
      if (!change.changed) return null;
      return {
        title: openPageContext.title || 'Untitled',
        diff: change.diff,
      };
    } catch (err) {
      this.logger.warn(
        `page-change detection skipped (chat ${chatId}): ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
      return null;
    }
  }

  /**
   * Write the end-of-turn snapshot for the open page (#274): the page's current
   * Markdown after ALL of the agent's edits this turn, plus the page's
   * updated_at. The agent's own edits are therefore baked into the snapshot, so
   * the next turn's diff isolates exactly what a HUMAN changed in between. Also
   * seeds the snapshot on the first turn. Best-effort — a deleted/foreign page or
   * any fault simply skips the write (no snapshot, no note next turn).
   *
   * Ordering note (deliberate): read updated_at BEFORE exporting, and store that
   * earlier value. This keeps the stored updated_at <= the true version of the
   * stored content, which is the SAFE direction for the fast path: it can only
   * ever be too conservative (force an extra diff), never falsely skip. Concretely
   * — if a user edit lands in the tiny window between the read and the export, the
   * export captures the NEW content while we store the OLDER updated_at; next turn
   * the two updated_ats differ, so the fast path is bypassed and we diff — which
   * resolves to "no change" because that edit is already baked into the stored
   * content. The only cost is not emitting a page_changed note for that specific
   * window edit, which is safe: the snapshot already contains it, so it can never
   * be silently overwritten later.
   *
   * The OPPOSITE order (read updated_at AFTER the export) is what would be unsafe:
   * a concurrent edit's NEWER updated_at would be stored alongside the OLDER
   * exported content, and next turn's fast path would then match on updated_at and
   * SKIP detection while the content genuinely diverged — a real missed edit. So
   * we intentionally do NOT re-read updated_at after the export.
   */
  private async snapshotOpenPage(
    chatId: string,
    pageId: string,
    workspace: Workspace,
    user: User,
    sessionId: string,
  ): Promise<void> {
    try {
      const freshPage = await this.pageRepo.findById(pageId);
      // Page deleted during the turn (or somehow foreign) => don't write.
      if (!freshPage || freshPage.workspaceId !== workspace.id) return;
      const currentMd = await this.tools.exportPageMarkdown(
        user,
        sessionId,
        workspace.id,
        chatId,
        pageId,
      );
      await this.aiChatPageSnapshotRepo.upsert({
        chatId,
        pageId,
        workspaceId: workspace.id,
        contentMd: currentMd,
        pageUpdatedAt: freshPage.updatedAt,
        contentHash: createHash('sha256').update(currentMd).digest('hex'),
      });
    } catch (err) {
      this.logger.warn(
        `page snapshot skipped (chat ${chatId}): ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
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
    // The open page the client sent is attacker-controllable — BOTH its id and
    // its title. Resolve it ONCE against the DB (workspace-scoped + access-
    // checked) and use the AUTHORITATIVE identity everywhere below: the system
    // prompt context, the getCurrentPage tool, and the new-chat history origin.
    // Previously the client title was echoed verbatim, so a navigation / two-tab
    // desync (openPage.id -> page B, title -> "Page A") made the model report
    // "updated Page A" while it edited page B (#159). Null when no page is open
    // or the page is foreign / inaccessible / missing.
    const openPageContext = await this.resolveOpenPageContext(
      body.openPage,
      workspace,
      user,
    );

    if (!chatId) {
      // The history-list origin is the validated open page (see above):
      // persisting an unvalidated id would leak a title via the chat-list join,
      // or violate the page_id FK on insert (this runs after res.hijack(), so a
      // DB error would break the stream).
      const originPageId: string | null = openPageContext?.id ?? null;
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
      metadata: (incoming?.parts ? { parts: incoming.parts } : null) as never,
    });

    // Rebuild the conversation from persisted history (not the client payload),
    // so the model always sees the authoritative server-side transcript. Load
    // the FULL history in chronological order (oldest -> newest, incl. the user
    // message just inserted above) so NO turns are dropped — there is no
    // recent-tail window anymore. `findAllByChat` keeps a 5000-row memory-safety
    // backstop (on overflow it keeps the NEWEST rows and logs a warning); that
    // is a safety net far above any realistic chat, not a conversational limit.
    const history = await this.aiChatMessageRepo.findAllByChat(
      chatId,
      workspace.id,
    );
    const uiMessages = history.map(rowToUiMessage);
    // convertToModelMessages is async in ai@6.0.134 (returns Promise<ModelMessage[]>).
    const messages = await convertToModelMessages(uiMessages);

    // Interrupt-resume detection (#198): the client "send now" flag is only a
    // hint — confirm it against the persisted history (the preceding assistant
    // turn must really be aborted/streaming) so a spoofed flag cannot inject the
    // interrupt note onto an ordinary turn. The partial output the model needs is
    // already in `messages` (the aborted assistant row replays via findRecent).
    const interrupted = isInterruptResume(history, body.interrupted);

    // Per-turn page-change detection (#274): if the open page was hand-edited by
    // the user since the agent's last turn ended, compute the unified diff so the
    // system prompt can warn the agent its copy is stale (else it overwrites those
    // edits). Best-effort (null on the fast path / first turn / any fault) — never
    // blocks the turn. Snapshot is (re)written at turn end in onFinish below.
    const pageChanged = await this.detectPageChange(
      chatId,
      openPageContext,
      workspace,
      user,
      sessionId,
    );

    // The model is resolved by the controller before hijack (clean 503 path).
    // Here we only need the admin-configured system prompt.
    const resolved = await this.aiSettings.resolve(workspace.id);

    // Build the external MCP toolset FIRST so the system prompt can carry each
    // connected server's admin-authored guidance (#180). Merge in admin-
    // configured external MCP tools (web search, etc.; §6.8). A down/slow
    // external server never crashes the turn — toolsFor skips it and records the
    // outcome. The returned client handles MUST be closed in the streamText
    // lifecycle (onFinish/onError/onAbort) — leaking them is a bug. Docmost
    // tools take precedence on a name clash (external are namespaced, so a clash
    // is not expected; the spread order makes intent explicit).
    let external: Awaited<ReturnType<McpClientsService['toolsFor']>> = {
      tools: {},
      clients: [],
      outcomes: [],
      instructions: [],
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

    // Close every external client EXACTLY ONCE across the turn's terminal
    // callbacks (onFinish/onError/onAbort all fire at most once collectively,
    // but guard anyway). DEFINED HERE — before the prompt/toolset are built — so
    // that if buildSystemPrompt or forUser throws AFTER the external lease was
    // taken (toolsFor above), the lease is still released. Otherwise its refCount
    // stays >= 1 forever and the external undici sockets leak until restart
    // (#180 reorder moved toolsFor ahead of these; #185 review). Close errors are
    // swallowed so they never break the response.
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

    // Turn-end snapshot of the open page (#274), run EXACTLY ONCE across the
    // terminal callbacks. This MUST run on onError/onAbort too, not only on the
    // successful onFinish: the write tools commit page edits to the DB
    // synchronously during a step, so an agent edit followed by an abort/error
    // (client disconnect, stop(), provider failure) still persists and bumps
    // page.updatedAt. If the snapshot did not advance on those paths, the NEXT
    // turn would diff the agent's OWN committed edit against the stale previous
    // snapshot and mis-report it as a user edit — breaking the "own edits excluded
    // by construction" guarantee. Best-effort (snapshotOpenPage swallows + logs);
    // skipped when no page is open.
    let snapshotWritten = false;
    const snapshotTurnEnd = async (): Promise<void> => {
      if (snapshotWritten) return;
      snapshotWritten = true;
      if (!openPageContext) return;
      await this.snapshotOpenPage(
        chatId,
        openPageContext.id,
        workspace,
        user,
        sessionId,
      );
    };

    // Build the system prompt + Docmost toolset. If either throws after the
    // external MCP lease was taken above, release the lease before rethrowing so
    // the leased transports are not leaked (#185 review).
    let system: string;
    let docmostTools: Awaited<ReturnType<AiChatToolsService['forUser']>>;
    try {
      system = buildSystemPrompt({
        workspace,
        adminPrompt: resolved?.systemPrompt,
        // The role (pre-resolved by the controller) REPLACES the persona layer;
        // the safety framework is still appended by buildSystemPrompt.
        roleInstructions: role?.instructions,
        // Server-validated open page (authoritative title), not the client value.
        openedPage: openPageContext,
        // Guidance only for servers that connected and yielded ≥1 callable tool.
        mcpInstructions: external.instructions,
        // History-confirmed interrupt-resume flag (#198): adds the interrupt note
        // so the model treats the partial answer above as cut off, not finished.
        interrupted,
        // Detected between-turns human edit to the open page (#274): adds the
        // page_changed note + unified diff so the agent doesn't overwrite it.
        pageChanged,
      });

      // Pass the resolved chatId so the write tools can mint provenance tokens
      // (access + collab) carrying { actor:'agent', aiChatId: chatId }, making
      // agent REST/collab writes attributable and non-spoofable (§6.5/§6.6).
      docmostTools = await this.tools.forUser(
        user,
        sessionId,
        workspace.id,
        chatId,
        // Same server-validated open page used by the system prompt above;
        // exposed to the model via getCurrentPage so page identity (and the
        // AUTHORITATIVE title) survives prompt mangling / client title spoofing.
        openPageContext,
      );
    } catch (err) {
      await closeExternalClients();
      throw err;
    }

    const tools = { ...external.tools, ...docmostTools };

    // Accumulate the turn's streamed output so a provider error / disconnect can
    // persist the PARTIAL answer the user already saw — the SDK's onError/onAbort
    // callbacks don't hand us the in-progress text. `capturedSteps` holds finished
    // steps (tool calls + their text); `inProgressText` holds the text streamed in
    // the CURRENT, not-yet-finished step, reset whenever a step finishes.
    const capturedSteps: StepLike[] = [];
    let inProgressText = '';

    // Step-granular durability (#183): create the assistant row UPFRONT in the
    // 'streaming' state (before any token), then UPDATE it as each step finishes
    // and finalize it once on the terminal callback. If the process dies
    // mid-turn the row survives with every finished step already persisted; the
    // startup sweep (sweepStreaming) later flips a dangling 'streaming' row to
    // 'aborted'. The DB is now the single source of truth for the turn — the
    // socket is never required for the write path. A failed upfront insert is
    // logged and leaves assistantId undefined; the per-step/terminal updates then
    // no-op (guarded below) so the turn still streams to the user.
    let assistantId: string | undefined;
    try {
      const seed = flushAssistant([], '', 'streaming');
      const seeded = await this.aiChatMessageRepo.insert({
        chatId,
        workspaceId: workspace.id,
        userId: user.id,
        role: 'assistant',
        content: seed.content,
        // jsonb columns: cast through never (same as the user insert above).
        toolCalls: (seed.toolCalls ?? null) as never,
        metadata: seed.metadata as never,
        status: seed.status,
      });
      assistantId = seeded?.id;
    } catch (err) {
      this.logger.error(
        `Failed to insert upfront assistant row (chat ${chatId}, workspace ${workspace.id})`,
        err as Error,
      );
    }

    // Per-step (non-terminal) update: persist the finished steps the moment a
    // step ends. Tolerant — a failed update is logged and swallowed so it never
    // throws into the stream. Keeps status 'streaming'.
    const updateStreaming = async (): Promise<void> => {
      if (!assistantId) return;
      // Cheap short-circuit once the turn is finalized (see `finalized` below).
      // The AUTHORITATIVE guard is `onlyIfStreaming` on the UPDATE: a late
      // fire-and-forget step update could still be in flight on another pool
      // connection when finalize runs, so the SQL `WHERE status='streaming'`
      // (not this flag) is what prevents it clobbering the terminal row.
      if (finalized) return;
      try {
        await this.aiChatMessageRepo.update(
          assistantId,
          workspace.id,
          flushAssistant(capturedSteps, '', 'streaming'),
          { onlyIfStreaming: true },
        );
      } catch (err) {
        this.logger.warn(
          `Failed to update streaming assistant row: ${
            err instanceof Error ? err.message : 'unknown error'
          }`,
        );
      }
    };

    // Serialize the per-step updates (#183 review): onStepFinish fires them
    // without await, so two could otherwise commit out of order on different pool
    // connections (step N landing after N+1). Chaining each onto the previous
    // keeps the persisted row monotonic with step order; each link short-circuits
    // on `finalized`, so a tail of late updates is cheap.
    let stepUpdateChain: Promise<void> = Promise.resolve();

    // Terminal finalize: write the completed/error/aborted row exactly once
    // across the (mutually-exclusive, at-most-once) onFinish/onError/onAbort
    // callbacks — mirroring the pre-#183 persist-at-most-once guard for the
    // TERMINAL status (the row may be updated many times with 'streaming' before
    // this fires once).
    let finalized = false;
    const finalizeAssistant = async (
      flushed: AssistantFlush,
    ): Promise<void> => {
      if (finalized) return;
      finalized = true;
      const plan = planFinalizeAssistant(assistantId);
      try {
        // Shared dispatch (see applyFinalize): UPDATE the upfront row, or — when
        // the upfront insert failed (kind 'insert') — INSERT the terminal row as
        // the only safety against losing the turn entirely.
        await applyFinalize(
          this.aiChatMessageRepo,
          plan,
          { chatId, workspaceId: workspace.id, userId: user.id },
          flushed,
        );
      } catch (err) {
        this.logger.error(
          `Failed to finalize assistant message (kind=${plan.kind})`,
          err as Error,
        );
      }
    };

    // DIAGNOSTIC (Safari stream-drop investigation) — temporary. Measure
    // first-chunk latency, the model-silent gap right before a disconnect, and
    // how many SSE heartbeats were written, so a Safari drop can be classified
    // (idle-gap vs hard wall-clock cap vs slow first chunk).
    const streamStartedAt = Date.now();
    let firstModelChunkAt: number | undefined;
    let lastModelChunkAt = streamStartedAt;
    let heartbeatsSent = 0;

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
          // DIAGNOSTIC (Safari stream-drop investigation) — temporary. Any model
          // output chunk means the stream is actively emitting bytes; track first
          // + most-recent activity timestamps.
          const now = Date.now();
          firstModelChunkAt ??= now;
          lastModelChunkAt = now;
          // 'text-delta' is the assistant's prose; tool-call args are separate chunk
          // types — so this mirrors exactly what streams to the client.
          if (chunk.type === 'text-delta') inProgressText += chunk.text;
        },
        onStepFinish: (step) => {
          // The finished step's full text is now in `step.text`; fold it in and reset
          // the in-progress accumulator for the next step.
          capturedSteps.push(step as StepLike);
          inProgressText = '';
          // Step-granular durability (#183): persist this finished step (its text +
          // tool calls + tool RESULTS) the moment it ends, so a process death after
          // this point still recovers the step. Not awaited here (never block the
          // stream), but SERIALIZED via stepUpdateChain so the writes commit in
          // step order; updateStreaming is error-tolerant (logs + swallows).
          stepUpdateChain = stepUpdateChain.then(() => updateStreaming());
        },
        onFinish: async ({ text, finishReason, totalUsage, usage, steps }) => {
          // DIAGNOSTIC (Safari stream-drop investigation) — temporary: success
          // baseline for Safari comparison.
          const diagNow = Date.now();
          this.logger.log(
            `AI chat stream DIAGNOSTIC (finish): elapsed=${diagNow - streamStartedAt}ms ` +
              `firstChunkLatency=${firstModelChunkAt ? firstModelChunkAt - streamStartedAt : 'none'}ms ` +
              `heartbeatsSent=${heartbeatsSent} steps=${steps.length}`,
          );
          // Finalize the assistant row (#183): the upfront 'streaming' row is
          // UPDATEd to 'completed' with the turn's final text, cumulative usage and
          // full UIMessage parts. We pass the SDK `steps` (which carry the final
          // step's text) as the captured steps so metadata.parts matches the
          // pre-#183 onFinish record exactly; `inProgressText` is '' here (the last
          // step already finished). Final-step usage (usage.input+output) ≈ the
          // conversation's CURRENT context size, distinct from totalUsage.
          //
          // COLUMN-SEMANTICS NOTE (#183): `content` is built by flushAssistant as
          // the CONCATENATION of every step's text (stepsText), whereas pre-#183
          // it stored only the FINAL step's text. This is a deliberate, harmless
          // change: the UI and the Markdown export render from `metadata.parts`
          // (per-step text + tool parts), not from `content`; `content` is the
          // plain-text projection (full-text search / fallback). A multi-step
          // turn's `content` therefore now holds all steps' prose, not just the
          // last block.
          await finalizeAssistant(
            flushAssistant(steps as StepLike[], '', 'completed', {
              finishReason: finishReason as string,
              usage: totalUsage as StreamUsage,
              contextTokens:
                (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) ||
                undefined,
              // Max context window for the chat header badge denominator;
              // resolved from the admin-configured provider settings (in
              // closure scope here). Omitted/0 = no limit.
              maxContextTokens: resolved?.chatContextWindow,
            }),
          );
          // Lifecycle: release the external MCP clients leased for this turn.
          await closeExternalClients();

          // Turn end (#274): snapshot the open page's current Markdown (after all
          // of the agent's edits this turn) so the NEXT turn can diff against it
          // and detect edits a human made in between. Self-clearing — the agent's
          // own edits are baked in — and this also SEEDS the snapshot on the first
          // turn. Runs once across every terminal path (see snapshotTurnEnd).
          await snapshotTurnEnd();

          // Generate the chat title for a freshly created chat AFTER the stream's
          // provider call has completed — NOT concurrently with it. The z.ai coding
          // endpoint stalls one of two concurrent requests to the same plan, which
          // black-holed the chat stream (~300s headers timeout) when title
          // generation raced it. Running it here (solo, fire-and-forget) avoids the
          // race; never block the turn on it, swallow any error.
          if (isNewChat && incomingText) {
            void this.generateTitle(chatId, workspace.id, incomingText).catch(
              (err) => {
                this.logger.warn(
                  `Title generation failed: ${(err as Error)?.message ?? err}`,
                );
              },
            );
          }
        },
        onError: async ({ error }) => {
          // NestJS Logger.error(message, stack?, context?): pass the real message
          // (with statusCode when present) + the stack string, not the Error
          // object, so the actual provider cause is clearly logged. Reuse the
          // shared formatter so provider error formatting stays unified.
          const e = error as { stack?: string };
          const errorText = describeProviderError(error, String(error));
          this.logger.error(`AI chat stream error: ${errorText}`, e?.stack);
          // DIAGNOSTIC (Safari stream-drop investigation) — temporary: timing of
          // an error-terminated stream.
          const diagNow = Date.now();
          this.logger.warn(
            `AI chat stream DIAGNOSTIC (error): elapsed=${diagNow - streamStartedAt}ms ` +
              `firstChunkLatency=${firstModelChunkAt ? firstModelChunkAt - streamStartedAt : 'none'}ms ` +
              `silentGapBeforeDrop=${diagNow - lastModelChunkAt}ms heartbeatsSent=${heartbeatsSent}`,
          );
          // Finalize the PARTIAL answer streamed before the failure (text + any
          // finished tool steps) WITH the error in metadata, so the turn shows what
          // the user already saw plus the cause — not just a bare error. Status
          // 'error' (#183).
          await finalizeAssistant(
            flushAssistant(capturedSteps, inProgressText, 'error', {
              error: errorText,
            }),
          );
          await closeExternalClients();
          // Advance the page snapshot even on failure (#274): an agent edit that
          // committed before the error must be baked into the snapshot, or the
          // next turn would mis-report it as a user edit.
          await snapshotTurnEnd();
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
          // DIAGNOSTIC (Safari stream-drop investigation) — temporary: THE key
          // line — classifies the Safari drop.
          const diagNow = Date.now();
          this.logger.warn(
            `AI chat stream DIAGNOSTIC (abort/disconnect): elapsed=${diagNow - streamStartedAt}ms ` +
              `firstChunkLatency=${firstModelChunkAt ? firstModelChunkAt - streamStartedAt : 'none'}ms ` +
              `silentGapBeforeDrop=${diagNow - lastModelChunkAt}ms heartbeatsSent=${heartbeatsSent} ` +
              `steps=${steps.length}`,
          );
          await finalizeAssistant(
            flushAssistant(capturedSteps, inProgressText, 'aborted'),
          );
          await closeExternalClients();
          // Advance the page snapshot even on abort (#274): an agent edit that
          // committed before the client disconnect / stop() must be baked into the
          // snapshot, or the next turn would mis-report it as a user edit.
          await snapshotTurnEnd();
        },
      });

      // Drain the stream independently of the client socket so the turn always
      // runs to completion (or to its abort) and the terminal callbacks
      // (onFinish/onError/onAbort) fire — releasing the per-turn object graph
      // (history, the per-request toolset closures, captured steps, SDK buffers)
      // and closing leased MCP clients. WITHOUT this, a client disconnect leaves
      // the pipe's dead socket as the only reader; backpressure stalls the stream,
      // the callbacks never run, and every dropped turn stays rooted in memory —
      // the heap-OOM leak. consumeStream removes that backpressure (AI SDK v6
      // "Handling client disconnects"). NOT awaited (fire-and-forget); the stream
      // errors are already logged by the streamText `onError` callback above, so
      // swallow here to avoid an unhandledRejection.
      void result.consumeStream({ onError: () => undefined });

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
      // Scrub the SDK's hop-by-hop Connection header before it writes the head (Safari/HTTP2).
      stripStreamingHopByHopHeaders(res.raw);
      // Running sum of per-step usage (v6 `finish-step.usage` is per-step). Sent
      // as the cumulative authoritative usage so the client never jumps DOWN.
      let cumulativeStepUsage: ChatStreamUsage | undefined;
      result.pipeUIMessageStreamToResponse(res.raw, {
        headers: { 'X-Accel-Buffering': 'no' },
        // Surface the authoritative chatId on the streamed assistant UI message so
        // the client adopts the REAL id of the row we created, instead of guessing
        // the newest chat in its list. `messageMetadata` is invoked by the AI SDK
        // on the `start`, `finish-step` and `finish` stream parts (ai@6 — note the
        // `finish-step` trigger relies on it being delivered as its own
        // message-metadata chunk); we attach `chatId` on the `start` part so it
        // reaches the client (as message.metadata.chatId) at the very first chunk —
        // before any second tab can race a newer chat into the list. This fixes the
        // two-tab "adoption race" (#137).
        //
        // `finish-step.usage` is PER-STEP (not cumulative) in v6, and the client
        // merges each metadata.usage by replacement — so on a multi-step agent turn
        // (up to MAX_AGENT_STEPS) the naive per-step value would make the live
        // counter jump DOWN at each boundary. We keep a running sum here and send
        // the CUMULATIVE usage, which converges to `finish.totalUsage` (#151).
        messageMetadata: ({ part }) => {
          const p = part as StreamMetadataPart;
          if (p.type === 'finish-step') {
            cumulativeStepUsage = accumulateStepUsage(
              cumulativeStepUsage,
              normalizeStreamUsage(p.usage),
            );
          }
          return chatStreamMetadata(p, chatId, cumulativeStepUsage);
        },
        // Stream reasoning (thinking) parts to the client so the live counter can
        // estimate reasoning tokens from streamed text. v6 default is already
        // true; set explicitly so the intent survives any future SDK default
        // change. Providers that don't emit reasoning text still surface the
        // count via the authoritative `usage.reasoningTokens` on finish-step.
        sendReasoning: true,
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
      // Heartbeat: keep the SSE stream progressing during silent tool/think gaps (Safari/proxy idle timeout).
      // DIAGNOSTIC (Safari stream-drop investigation) — temporary: count beats so a disconnect log can show
      // how many pings were written before Safari dropped.
      startSseHeartbeat(res.raw, 15_000, () => {
        heartbeatsSent += 1;
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
   * One-shot page-title generation from a note's content (#199). No tools, no
   * streaming — mirrors generateTitle() but for an arbitrary note body supplied
   * by the client, and RETURNS the title instead of writing it (the client
   * applies it via the existing /pages/update route, which enforces edit
   * permission). The content is truncated to keep the prompt cheap and within
   * context limits. Throws AiNotConfiguredException (503) if AI is unconfigured.
   */
  async generatePageTitle(workspaceId: string, content: string): Promise<string> {
    const model = await this.ai.getChatModel(workspaceId);
    const { text } = await generateText({
      model,
      system:
        'You generate a single concise, descriptive title for a note based on ' +
        'its content. Reply with the title only — at most 8 words, no quotes, ' +
        'no trailing punctuation, written in the same language as the note.',
      prompt: content.slice(0, 8000),
    });
    return cleanGeneratedTitle(text);
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
    const title = text
      .trim()
      .replace(/^["']|["']$/g, '')
      .slice(0, 120);
    if (title) {
      await this.aiChatRepo.update(chatId, { title }, workspaceId);
    }
  }
}

/** Shape of the AI SDK v6 LanguageModelUsage we forward to the client. The SDK
 *  exposes `reasoningTokens` both as a (deprecated) top-level field and under
 *  `outputTokenDetails.reasoningTokens`; we normalize to a single field so the
 *  client gets one stable usage shape regardless of provider/SDK version. */
interface StreamUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  outputTokenDetails?: { reasoningTokens?: number };
}

/** A streamed part the messageMetadata callback can receive (only the fields we read). */
interface StreamMetadataPart {
  type: string;
  usage?: StreamUsage;
  totalUsage?: StreamUsage;
}

/** Authoritative usage we attach to a streamed assistant message's metadata. */
export interface ChatStreamUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
}

/** Normalize an AI SDK usage object to our flat client-facing shape, resolving
 *  reasoning tokens from either the new `outputTokenDetails` or the deprecated
 *  top-level field. Returns undefined for a missing usage object. */
function normalizeStreamUsage(
  usage: StreamUsage | undefined,
): ChatStreamUsage | undefined {
  if (!usage) return undefined;
  const reasoningTokens =
    usage.outputTokenDetails?.reasoningTokens ?? usage.reasoningTokens;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    reasoningTokens,
  };
}

/** Sum a (normalized) per-step usage into a running cumulative usage. v6's
 *  `finish-step.usage` is PER-STEP, so the caller accumulates across steps; the
 *  cumulative sum converges to the turn's `totalUsage` (no down-jump on the
 *  client). Returns undefined only when both sides are absent. Pure. */
export function accumulateStepUsage(
  acc: ChatStreamUsage | undefined,
  step: ChatStreamUsage | undefined,
): ChatStreamUsage | undefined {
  if (!acc) return step;
  if (!step) return acc;
  const add = (a?: number, b?: number): number | undefined =>
    a == null && b == null ? undefined : (a ?? 0) + (b ?? 0);
  return {
    inputTokens: add(acc.inputTokens, step.inputTokens),
    outputTokens: add(acc.outputTokens, step.outputTokens),
    totalTokens: add(acc.totalTokens, step.totalTokens),
    reasoningTokens: add(acc.reasoningTokens, step.reasoningTokens),
  };
}

/**
 * Pure metadata builder for the streamed assistant UI message. The AI SDK calls
 * `messageMetadata` on the `start`, `finish-step` and `finish` stream parts; we
 * attach (as `message.metadata`):
 *  - `start`        -> `{ chatId }` so the client adopts the real created chat id
 *                      at the first chunk (see adopt-chat-id.ts / #137).
 *  - `finish-step`  -> `{ usage }` the CUMULATIVE authoritative usage so far
 *                      (incl. reasoning tokens) — the caller passes the running
 *                      sum (`cumulativeStepUsage`), since v6 per-step usage is not
 *                      cumulative; the client snaps to exact without jumping down.
 *  - `finish`       -> `{ usage }` from the turn's `totalUsage` (final reconcile).
 * Any other part type contributes no metadata. Pure + unit-testable.
 */
export function chatStreamMetadata(
  part: StreamMetadataPart,
  chatId: string,
  cumulativeStepUsage?: ChatStreamUsage,
): { chatId: string } | { usage: ChatStreamUsage } | undefined {
  if (part.type === 'start') return { chatId };
  if (part.type === 'finish-step') {
    return cumulativeStepUsage ? { usage: cumulativeStepUsage } : undefined;
  }
  if (part.type === 'finish') {
    const usage = normalizeStreamUsage(part.totalUsage);
    return usage ? { usage } : undefined;
  }
  return undefined;
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
 * The persisted-row patch shape produced by {@link flushAssistant}. It is the
 * SAME shape the assistant repo insert/update consume (content + toolCalls +
 * metadata) plus the lifecycle `status` column added in #183.
 */
export interface AssistantFlush {
  content: string;
  toolCalls: unknown;
  metadata: Record<string, unknown>;
  status: 'streaming' | 'completed' | 'error' | 'aborted';
}

/**
 * Pure decision for the terminal finalize (#183): given whether the upfront
 * assistant row exists (`assistantId`), choose whether the terminal payload is
 * written by UPDATEing that row or — when the upfront insert failed and there is
 * no id — by INSERTing a fresh terminal row so the turn is not lost entirely.
 * Returns `{ kind: 'update', id }` or `{ kind: 'insert' }`. Extracted so the
 * fallback-insert branch (the only safety against losing a turn whose upfront
 * insert failed) is unit-testable without seaming streamText.
 */
export function planFinalizeAssistant(
  assistantId: string | undefined,
): { kind: 'update'; id: string } | { kind: 'insert' } {
  return assistantId ? { kind: 'update', id: assistantId } : { kind: 'insert' };
}

/** The repo surface the terminal finalize needs (structural — the real repo and
 *  a test mock both satisfy it). */
export interface FinalizeRepo {
  insert(insertable: Record<string, unknown>): Promise<unknown>;
  update(
    id: string,
    workspaceId: string,
    patch: AssistantFlush,
  ): Promise<unknown>;
}

/**
 * Apply a finalize `plan` to the repo with the terminal `flushed` payload (#183):
 * UPDATE the upfront row, or INSERT a fresh terminal row as the fallback when the
 * upfront insert failed. The SINGLE dispatch shared by the service's
 * finalizeAssistant and its test, so the test exercises the real path instead of
 * a copy (#186 review). Pure of error handling — the caller wraps it.
 */
export async function applyFinalize(
  repo: FinalizeRepo,
  plan: { kind: 'update'; id: string } | { kind: 'insert' },
  base: { chatId: string; workspaceId: string; userId: string },
  flushed: AssistantFlush,
): Promise<void> {
  if (plan.kind === 'update') {
    await repo.update(plan.id, base.workspaceId, flushed);
    return;
  }
  await repo.insert({
    chatId: base.chatId,
    workspaceId: base.workspaceId,
    userId: base.userId,
    role: 'assistant',
    content: flushed.content,
    toolCalls: flushed.toolCalls ?? null,
    metadata: flushed.metadata,
    status: flushed.status,
  });
}

/**
 * PURE assistant-row builder (#183 step-granular durability). Given the turn's
 * accumulated steps + the in-progress (not-yet-finished) text + the lifecycle
 * status, it returns the row patch to persist. The SAME path runs for the
 * upfront insert (empty steps, status 'streaming'), every per-step update, and
 * the terminal finalize (completed/error/aborted) — and a future background
 * worker can call it identically, so it must stay a pure function of its inputs
 * (NO `this`, no IO).
 *
 * `metadata.parts` is built by assistantParts over the finished steps, then the
 * in-progress text appended as a trailing text part, so rowToUiMessage /
 * findAllByChat keep replaying the turn unchanged. `metadata.finishReason`,
 * `metadata.error`, `metadata.usage`, `metadata.contextTokens` and
 * `metadata.maxContextTokens` are attached only when provided/relevant, matching
 * the pre-#183 onFinish/onError records.
 */
export function flushAssistant(
  capturedSteps: ReadonlyArray<StepLike> | undefined,
  inProgressText: string,
  status: 'streaming' | 'completed' | 'error' | 'aborted',
  extra?: {
    finishReason?: string;
    usage?: ChatStreamUsage | StreamUsage | undefined;
    contextTokens?: number;
    maxContextTokens?: number;
    error?: string;
  },
): AssistantFlush {
  const finished = capturedSteps ?? [];
  const stepsText = finished.map((s) => s.text ?? '').join('');
  const trailing = inProgressText ?? '';
  // assistantParts emits text parts only for FINISHED steps; append the
  // in-progress step's text (the partial answer cut off by an error/abort, or
  // simply not yet flushed mid-stream) as the last text part so the persisted
  // parts match what streamed to the client.
  const parts = assistantParts(finished, '') as unknown as Array<
    Record<string, unknown>
  >;
  if (trailing) parts.push({ type: 'text', text: trailing });

  const metadata: Record<string, unknown> = {
    parts: parts as unknown as UIMessage['parts'],
  };
  // finishReason: prefer an explicit one; else derive a sensible value from the
  // terminal status (so onError/onAbort records keep their historical reason).
  if (extra?.finishReason) {
    metadata.finishReason = extra.finishReason;
  } else if (status === 'error' || status === 'aborted') {
    metadata.finishReason = status;
  }
  if (extra?.usage !== undefined) {
    metadata.usage =
      normalizeStreamUsage(extra.usage as StreamUsage) ?? extra.usage;
  }
  if (extra?.contextTokens) metadata.contextTokens = extra.contextTokens;
  if (extra?.maxContextTokens)
    metadata.maxContextTokens = extra.maxContextTokens;
  if (extra?.error) metadata.error = extra.error;

  return {
    content: stepsText + trailing,
    toolCalls: serializeSteps(finished),
    metadata,
    status,
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
