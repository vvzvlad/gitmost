import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import {
  streamText,
  generateText,
  convertToModelMessages,
  stepCountIs,
  type UIMessage,
  type ModelMessage,
  type LanguageModel,
  type PrepareStepResult,
} from 'ai';
import { AiService } from '../../integrations/ai/ai.service';
import { AiSettingsService } from '../../integrations/ai/ai-settings.service';
import { describeProviderError } from '../../integrations/ai/ai-error.util';
import { AiChatRepo } from '@docmost/db/repos/ai-chat/ai-chat.repo';
import { AiChatMessageRepo } from '@docmost/db/repos/ai-chat/ai-chat-message.repo';
import { AiChatRunStepRepo } from '@docmost/db/repos/ai-chat/ai-chat-run-step.repo';
import { AiChatPageSnapshotRepo } from '@docmost/db/repos/ai-chat/ai-chat-page-snapshot.repo';
import { AiChatPageBindingRepo } from '@docmost/db/repos/ai-chat/ai-chat-page-binding.repo';
import { AiAgentRoleRepo } from '@docmost/db/repos/ai-agent-roles/ai-agent-roles.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageAccessService } from '../page/page-access/page-access.service';
import {
  User,
  Workspace,
  AiChatMessage,
  AiAgentRole,
} from '@docmost/db/types/entity.types';
import {
  AiChatToolsService,
  type ViewImageCache,
  type ViewImageCacheEntry,
} from './tools/ai-chat-tools.service';
import { McpClientsService } from './external-mcp/mcp-clients.service';
import {
  MCP_FAILURES_CAP,
  MCP_FAILURE_REASON_MAX,
} from './external-mcp/mcp.constants';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { AiChatStreamRegistryService } from './ai-chat-stream-registry.service';
import { buildSystemPrompt } from './ai-chat.prompt';
import {
  CORE_TOOL_KEYS,
  CORE_TOOL_SET,
  LOAD_TOOLS_NAME,
  makeLoadToolsTool,
  buildExternalToolCatalog,
} from './tools/tool-tiers';
import {
  RunAlreadyActiveError,
  AiChatRunService,
} from './ai-chat-run.service';
import { inAppToolCallCapMs } from './tools/ai-chat-tools.service';
import { computePageChange } from './page-change/page-change.util';
import {
  sanitizeSelection,
  type SelectionContext,
} from './tools/current-page.util';
import { roleModelOverride } from './roles/role-model-config';
import {
  resolveReplayBudget,
  resolveEffectiveReplayThreshold,
  isContextOverflowError,
  trimHistoryForReplay,
} from './history-budget';
import {
  startSseHeartbeat,
  stripStreamingHopByHopHeaders,
} from './sse-resilience';
import {
  isDegenerateOutput,
  truncateDegeneratedTail,
  shouldCheckDegeneration,
} from './output-degeneration';
import { incAiChatBindSkipped } from '../../integrations/metrics/metrics.registry';

// Max agent steps per turn. One step = one model generation; a step that calls
// tools is followed by another step carrying the tool results. Raised from 8 so
// multi-search research questions are not cut off mid-investigation, then from 20
// to 50 (#444) so read-heavy turns (e.g. dozens of searchInPage sweeps) do not
// exhaust the budget before acting.
const MAX_AGENT_STEPS = 50;

// How many steps before the LAST one the step-budget warning starts firing
// (#444). At MAX-STEP_BUDGET_WARNING_LEAD .. MAX-2 the model is told to stop
// exploring and start acting, with the remaining count decreasing each step; the
// last step (MAX-1) has its own final nudge / lockdown instead (see
// prepareAgentStep).
const STEP_BUDGET_WARNING_LEAD = 6;

// Wall-clock ceiling for building the external MCP toolset during the per-turn
// setup phase (before streamText owns the lifecycle). Defense-in-depth ABOVE the
// per-server connect bound in mcp-clients.service (CONNECT_TIMEOUT_MS): even if
// that per-server timeout regressed, this outer deadline — together with the run's
// abort signal — guarantees the setup phase can never wedge a turn at step 0 (the
// production hang) and the run always finalizes. It stays a TRUE backstop because
// buildEntry connects to the servers CONCURRENTLY, so the total build time is
// bounded by the SLOWEST single server (~2×CONNECT_TIMEOUT_MS), not the SUM across
// them — the per-server bound fires first no matter how many servers are enabled,
// and this outer deadline only catches a total build stall the per-server bound
// somehow missed.
const MCP_TOOLSET_BUILD_DEADLINE_MS = 60_000;

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

// SOFT final-step nudge (#444), used when the final-step lockdown toggle is OFF
// (the new default). Unlike FINAL_STEP_INSTRUCTION it does NOT strip tools
// (toolChoice stays untouched), so the model is never forced into a tool-less
// state mid-work — that tool-stripping is what triggered the 255KB token-loop
// degeneration incident. It only asks the model to finish with a text summary.
const FINAL_STEP_NUDGE =
  'This is the LAST step of this turn. Write your final answer to the user now.\n' +
  'You may still call tools, but the turn ends after this step either way —\n' +
  'prefer finishing with a clear text summary of what was done and what remains.';

// Synthetic marker text appended in onFinish when a step-exhausted turn produced
// NO text at all (#444, mitigates the "empty turn" the lockdown used to prevent
// when the toggle is OFF). Makes the exhausted-without-answer state explicit to
// the user and, on replay, to the model on the next turn.
// This is a HARDCODED English sentence and is NOT localized: it is appended
// verbatim into the assistant row's `content` and rendered/replayed as-is — the
// client does NOT run it through `t()`, and there is no i18n key for it. English
// replaced an earlier hardcoded Russian string (which rendered Russian for every
// locale and fed Russian back to the model on replay). Keep it a plain,
// model-readable English sentence so the next turn's replay reads cleanly.
const STEP_LIMIT_NO_ANSWER_MARKER =
  '(Step limit reached — no final answer was produced; the work may be ' +
  'unfinished. Reply "continue" to let the agent carry on.)';

// Reason recorded in ai_chat_runs.error / the assistant row when the token-
// degeneration detector (#444) aborts a run. Distinct from a user Stop (no error)
// and from a server restart ('streaming' -> swept to 'aborted' with no message).
const OUTPUT_DEGENERATION_ERROR =
  'Output degeneration detected (repeated token loop)';

// Prefix recorded on the assistant row when the provider rejected the turn for
// CONTEXT OVERFLOW (#490): the replayed history exceeded the model's window. The
// row is ALSO stamped `metadata.replayOverflowCount` (the consecutive-overflow
// counter, #520) so the NEXT turn's budgeter trims with escalating aggression (the
// reactive recovery — the overflowing turn had no usage signal to trigger
// preventive trimming, so the classified 400 is what un-bricks it).
export const CONTEXT_OVERFLOW_ERROR_PREFIX =
  'Диалог превысил контекстное окно модели; история будет агрессивно ' +
  'сокращена на следующем ходу.';

/**
 * Compute the step-budget warning text (#444), or '' when this step is outside
 * the warning band. The warning fires on steps
 * MAX_AGENT_STEPS-STEP_BUDGET_WARNING_LEAD .. MAX_AGENT_STEPS-2 (NOT the last
 * step, which has its own final nudge/lockdown), telling the model to stop
 * exploring and start acting. `N` is the number of tool-use steps still
 * remaining (`MAX_AGENT_STEPS - 1 - stepNumber`), so it decreases toward the
 * end. Pure.
 */
export function stepBudgetWarning(stepNumber: number): string {
  const isLastStep = stepNumber >= MAX_AGENT_STEPS - 1;
  const inBand = stepNumber >= MAX_AGENT_STEPS - STEP_BUDGET_WARNING_LEAD;
  if (isLastStep || !inBand) return '';
  const remaining = MAX_AGENT_STEPS - 1 - stepNumber;
  return (
    `Only ${remaining} tool-use steps remain in this turn. Stop exploring and start acting now\n` +
    '(make the edits / create the comments / produce results). Leave room to finish\n' +
    'with a final text answer.'
  );
}

// Pure, unit-testable: decide per-step overrides. Responsibilities:
//   1. Final-step handling. Two modes, chosen by `finalStepLockdownEnabled`:
//      - toggle ON (legacy): on the final allowed step force a text-only
//        synthesis answer (toolChoice 'none' + FINAL_STEP_INSTRUCTION). This WINS
//        — it takes precedence over the deferred-tool narrowing below.
//      - toggle OFF (new default, #444): do NOT touch toolChoice — tools stay
//        available on every step incl. the last, so the model is never stripped
//        of its tools mid-work (the cause of the token-loop degeneration
//        incident). A SOFT nudge (FINAL_STEP_NUDGE) is appended to `system`, and
//        the deferred-tool `activeTools` narrowing still applies to the last step
//        (both `activeTools` and `system` are returned together).
//   2. Step-budget warning (#444): on steps in the warning band (but not the
//      last, which has its own nudge/lockdown) append stepBudgetWarning(...) to
//      `system` so the model starts acting before it runs out of steps.
//   3. Deferred tool visibility (#332): when `deferredEnabled`, expose only the
//      CORE tools + loadTools + whatever loadTools has activated so far this turn
//      (`activatedTools`), via `activeTools`. Deferred tools stay in the
//      <tool_catalog> until the model loads them.
//
// `system` is the in-scope system prompt; we CONCATENATE so the original
// persona/context is preserved — a bare `system` override would REPLACE the
// whole system prompt for the step. `activatedTools` is a closure Set grown by
// loadTools and owned by the streaming loop; the caller seeds it from and
// persists it to the chat's metadata across turns (#490), but this function only
// READS the Set it is handed, so it stays a pure function of its arguments (not
// module-global).
//
// NOTE: at AI SDK v7 the per-step `system` field is renamed to `instructions`.
// On v6 (`^6.0.134`) `system` is the correct field — adjust when bumping.
export function prepareAgentStep(
  stepNumber: number,
  system: string,
  activatedTools: ReadonlySet<string> | readonly string[] = [],
  deferredEnabled = false,
  finalStepLockdownEnabled = false,
):
  | { toolChoice: 'none'; system: string }
  | { activeTools: string[]; system?: string }
  | { system: string }
  | undefined {
  const isLastStep = stepNumber >= MAX_AGENT_STEPS - 1;

  // Legacy final-step lockdown (toggle ON): text-only synthesis. WINS over the
  // deferred narrowing AND drops tools for this step.
  if (isLastStep && finalStepLockdownEnabled) {
    return {
      toolChoice: 'none',
      system: `${system}\n\n${FINAL_STEP_INSTRUCTION}`,
    };
  }

  // Compute the extra system text for this step: the soft final nudge on the last
  // step (toggle OFF), or the step-budget warning in the warning band. At most one
  // of these applies (stepBudgetWarning returns '' on the last step).
  const extra = isLastStep ? FINAL_STEP_NUDGE : stepBudgetWarning(stepNumber);
  const systemForStep = extra ? `${system}\n\n${extra}` : undefined;

  // Deferred tool loading: narrow this step's visible tools to CORE + loadTools +
  // the tools already activated this turn. Applies on EVERY step incl. the last
  // (toggle OFF), so the model keeps its core tools available while being nudged
  // to finish. Return `system` alongside `activeTools` when we have extra text.
  if (deferredEnabled) {
    const activated = Array.isArray(activatedTools)
      ? activatedTools
      : [...activatedTools];
    const activeTools = [...CORE_TOOL_KEYS, LOAD_TOOLS_NAME, ...activated];
    return systemForStep ? { activeTools, system: systemForStep } : { activeTools };
  }

  // Deferred OFF: all tools stay active; only append the extra system text (if any).
  return systemForStep ? { system: systemForStep } : undefined;
}

export {
  MAX_AGENT_STEPS,
  STEP_BUDGET_WARNING_LEAD,
  FINAL_STEP_INSTRUCTION,
  FINAL_STEP_NUDGE,
  STEP_LIMIT_NO_ANSWER_MARKER,
  OUTPUT_DEGENERATION_ERROR,
};

// #588: the fixed instruction that accompanies an injected viewImage image so the
// model knows the following image part is the one it just requested.
const VIEW_IMAGE_INJECT_TEXT =
  'Below is the image from your viewImage call. Assess it.';

/**
 * Build the ephemeral user-role message that carries a viewImage image to the
 * model (#588). v6 image-part shape is `{ type:'image', image:<base64>,
 * mediaType }` (the field is `mediaType`, NOT `mimeType`). Returned as a plain
 * ModelMessage; it is injected via prepareStep's `messages` override for the
 * CURRENT step only and is NEVER persisted (buildStepParts reads step.toolResults,
 * not `messages`), so it stays ephemeral. Exported for unit testing.
 */
export function userImageMessage(img: ViewImageCacheEntry): ModelMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text: VIEW_IMAGE_INJECT_TEXT },
      { type: 'image', image: img.data, mediaType: img.mediaType },
    ],
  };
}

/**
 * #588: has the model produced assistant TEXT on a step that comes AFTER the step
 * containing `toolCallId`? Deterministic function of the finished-steps array the
 * SDK hands prepareStep (`opts.steps`). Used to decide when to EVICT a viewImage
 * cache entry: once the model has "spoken about" the image (any later step with
 * non-empty assistant text), the image no longer needs re-injecting on every
 * subsequent step, so we stop re-billing it.
 *
 * Locate the step whose toolCalls/content references the id, then scan strictly
 * LATER steps for non-empty `text`. Returns false when the call is not yet among
 * the finished steps (it was just issued on the step being prepared), so the image
 * keeps getting injected until a genuine text step follows. Pure.
 */
export function modelSpokeAboutItAfter(
  toolCallId: string,
  steps: ReadonlyArray<StepLike> | undefined,
): boolean {
  if (!steps || steps.length === 0) return false;
  let callIdx = -1;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const inCalls = (s.toolCalls ?? []).some(
      (c) => c.toolCallId === toolCallId,
    );
    const inContent = (s.content ?? []).some(
      (p) =>
        (p.type === 'tool-call' || p.type === 'tool-result') &&
        p.toolCallId === toolCallId,
    );
    if (inCalls || inContent) {
      callIdx = i;
      break;
    }
  }
  if (callIdx === -1) return false;
  for (let i = callIdx + 1; i < steps.length; i++) {
    if ((steps[i].text ?? '').trim().length > 0) return true;
  }
  return false;
}

/**
 * #588: given the current prepareStep options and the live viewImage cache, build
 * the per-step `messages` override that injects every still-live cached image as
 * an ephemeral trailing user message, and EVICT any entry the model has already
 * spoken about (see modelSpokeAboutItAfter). Returns the merged step result:
 * `base` (prepareAgentStep's disjoint {activeTools|toolChoice|system} keys) with
 * `messages` appended — the merge preserves base's keys so a toolChoice:'none'
 * lockdown step still carries the injected image to the synthesis step. Returns
 * `base` unchanged when there is nothing to inject. Mutates `cache` (eviction).
 *
 * Exported + pure w.r.t. its inputs (aside from the intended cache eviction) so
 * the injection/eviction/merge semantics are unit-testable without streamText.
 */
export function injectViewImages(
  base: ReturnType<typeof prepareAgentStep>,
  opts: {
    messages: ReadonlyArray<ModelMessage>;
    steps: ReadonlyArray<StepLike> | undefined;
  },
  cache: ViewImageCache,
): PrepareStepResult {
  if (cache.size === 0) return base;
  const injected: ModelMessage[] = [];
  for (const [toolCallId, img] of cache) {
    injected.push(userImageMessage(img));
    // Evict AFTER queuing this step's injection (inject-then-delete): the step
    // whose prepareStep first observes "the model has spoken" still gets the image
    // once more (never starve the synthesis step), then future steps skip it.
    if (modelSpokeAboutItAfter(toolCallId, opts.steps)) cache.delete(toolCallId);
  }
  if (injected.length === 0) return base;
  return {
    ...(base ?? {}),
    messages: [...opts.messages, ...injected],
  };
}

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
  history: Array<{
    role: string;
    status?: string | null;
    metadata?: unknown;
  }>,
  clientInterrupted: boolean | undefined,
): boolean {
  if (clientInterrupted !== true) return false;
  const prev = history[history.length - 2];
  if (prev?.role !== 'assistant') return false;
  // #487: a reconcile STAMP (metadata.finalizeFailed) is NOT a genuine user
  // interruption — the previous turn's process died and a reconcile settled the
  // row as 'aborted'. Treating it as an interrupt-resume would inject a false
  // "you were interrupted" note. Exclude any finalizeFailed row.
  const meta = prev.metadata as { finalizeFailed?: unknown } | null | undefined;
  if (meta && meta.finalizeFailed === true) return false;
  return prev.status === 'aborted' || prev.status === 'streaming';
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
 * Race `work` against an abort signal AND a wall-clock deadline, so a hung
 * external-MCP toolset build during the pre-streamText setup phase can NEITHER
 * wedge the turn NOR make it un-stoppable, and the run always finalizes. It
 *  - resolves with `work`'s value when it settles first;
 *  - REJECTS EARLY if `signal` aborts (with `signal.reason` when that is an Error,
 *    else a generic `Error('aborted')`) — so an explicit Stop is honored mid-setup;
 *  - REJECTS EARLY if `deadlineMs` elapses (defense-in-depth backstop);
 *  - invokes `onLateResolve(value)` when `work` settles AFTER the race was already
 *    lost, so the caller can release any resources that abandoned value owns
 *    (e.g. close leased MCP clients that would otherwise leak their sockets).
 *
 * A rejection handler is attached to `work` so a late rejection is never an
 * unhandledRejection; the timer is unref'd and cleared once the race settles.
 */
export function raceAgainstAbortAndTimeout<T>(
  work: Promise<T>,
  signal: AbortSignal,
  deadlineMs: number,
  onLateResolve?: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        signal.reason instanceof Error ? signal.reason : new Error('aborted'),
      );
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`setup timed out after ${deadlineMs}ms`));
    }, deadlineMs);
    // Do not keep the process alive just for this setup-deadline timer.
    timer.unref?.();
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    work.then(
      (value) => {
        if (settled) {
          // The race was already lost (abort/deadline): hand the abandoned value to
          // the caller so it can release the resources that value owns.
          onLateResolve?.(value);
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      },
      (err: unknown) => {
        // A late rejection after the race is already handled — swallow so it is
        // never an unhandledRejection.
        if (settled) return;
        settled = true;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
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
  //
  // `selection` is the user's editor selection snapshotted client-side at send
  // time (#388). It is CLIENT-controlled and UNTRUSTED — a loose `unknown` here
  // (the body is parsed off req.body without a DTO) that is type-checked and
  // capped by `sanitizeSelection` before it is ever surfaced to the model.
  openPage?: { id?: string; title?: string; selection?: unknown } | null;
  // Set by the client "send now" action (#198): this turn immediately follows a
  // user interruption of the previous turn. A hint only — the server re-confirms
  // it against persisted history (`isInterruptResume`) before injecting the
  // interrupt note, so a spoofed/stale flag on an ordinary turn is ignored.
  interrupted?: boolean;
  // #487: server-side supersede CAS. When present, this POST asks the server to
  // STOP the run `supersede.runId` (which the client saw as the chat's active run)
  // and, once it has settled, start THIS turn in its place. The server validates
  // the target against the chat and answers 400 (wrong chat) / 409
  // SUPERSEDE_TARGET_MISMATCH / 409 SUPERSEDE_TIMEOUT, or proceeds normally
  // (degrade / ready). Absent => an ordinary send (rejected with 409
  // A_RUN_ALREADY_ACTIVE if a run is already active on the chat).
  supersede?: { runId?: string } | null;
  // useChat sends the full UIMessage list; the last one is the new user turn.
  messages?: UIMessage[];
}

/**
 * Optional run-lifecycle hooks (#184 phase 1). When supplied, the turn is wrapped
 * in a first-class server-side RUN: `begin` is called once the chat id is known
 * and returns the run's AbortSignal (decoupled from the HTTP socket — a browser
 * disconnect no longer governs the abort), and the lifecycle callbacks persist
 * the run's progress and terminal status. Absent (the default) => the legacy
 * socket-bound behavior is unchanged.
 */
export interface AiChatRunHooks {
  // Called once the chat id is resolved; returns the run handle whose `signal`
  // drives the agent loop's abort. Returning null disables run tracking (the
  // turn falls back to the passed-in socket signal).
  begin(chatId: string): Promise<{ runId: string; signal: AbortSignal } | null>;
  onAssistantSeeded?(
    runId: string,
    assistantMessageId: string,
  ): Promise<void> | void;
  onStep?(runId: string, stepCount: number): void;
  onSettled?(
    runId: string,
    status: 'completed' | 'error' | 'aborted',
    error?: string,
  ): Promise<void> | void;
}

export interface AiChatStreamArgs {
  user: User;
  workspace: Workspace;
  sessionId: string;
  body: AiChatStreamBody;
  res: FastifyReply;
  signal: AbortSignal;
  // Run-lifecycle hooks (#184). When present the turn becomes a detached,
  // durable RUN whose abort is governed by the run (explicit stop), not the
  // socket; when absent the turn stays socket-bound (legacy behavior).
  runHooks?: AiChatRunHooks;
  // Resolved by the controller BEFORE res.hijack(), so an unconfigured provider
  // (AiNotConfiguredException -> 503) surfaces as clean JSON before streaming.
  // For a role with a model override this already carries the override-resolved
  // model (or the controller threw a 503 if the override driver was unconfigured).
  model: LanguageModel;
  // The agent role to apply this turn, pre-resolved by the controller from the
  // chat row (existing chat) or the request body (new chat). null => universal
  // assistant. Carried here so the turn never re-loads it.
  role: AiAgentRole | null;
  // #487: true when this turn was started by SUPERSEDING a still-live previous run
  // (the controller ran the supersede CAS to a `ready` result). Adds the
  // SUPERSEDE_NOTE to the system prompt (the previous run's last ops may still be
  // applying — no side-effect quiescence). Absent on an ordinary send.
  superseded?: boolean;
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
export class AiChatService implements OnModuleInit, OnModuleDestroy {
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
    // Reads the AI_CHAT_DEFERRED_TOOLS toggle (#332). Injected last so existing
    // positional constructor callers (tests) only append one stub.
    private readonly environment: EnvironmentService,
    // #184 phase 1.5 run-stream registry. OPTIONAL so existing positional
    // constructions (int-specs) compile unchanged; Nest always injects the real
    // provider in production. Only ever touched on the run-wrapped + flag-on path.
    private readonly streamRegistry?: AiChatStreamRegistryService,
    // #487: the run lifecycle service, for the periodic + opportunistic reconcile
    // (zombie re-drive + stale-run abort). OPTIONAL so positional test
    // constructions compile unchanged; Nest always injects the real singleton, so
    // reconcile sees the SAME in-memory active/zombie maps the runner mutates.
    private readonly aiChatRunService?: AiChatRunService,
    // #492 append-persist: per-step INSERT into the lightweight steps table (the
    // O(Σ steps) replacement for the O(n²) full-row `metadata.parts` rewrite).
    // OPTIONAL so existing positional constructions (int-specs) compile unchanged;
    // Nest injects the real singleton. When ABSENT the per-step path falls back to
    // the pre-#492 full-row flush (no regression, only no WAL win).
    private readonly aiChatRunStepRepo?: AiChatRunStepRepo,
    // #665: the mutable page->chat binding repo. The server is the BIRTH writer —
    // it upserts the binding right after the FIRST user message of a chat sent from
    // a page. OPTIONAL and injected LAST so existing positional constructions
    // (int-specs) compile unchanged; absent => the birth-bind is silently skipped
    // (no crash), present in production (Nest injects the singleton).
    private readonly aiChatPageBindingRepo?: AiChatPageBindingRepo,
  ) {}

  // #487: periodic reconcile timer (single-process phase 1). Started in
  // onModuleInit, cleared in onModuleDestroy.
  private reconcileTimer?: ReturnType<typeof setInterval>;

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

    // #487: start the PERIODIC reconcile (was boot-only). It heals both directions
    // of the run<->message lifecycle asymmetry that a boot sweep alone left to the
    // NEXT restart. Single-process phase 1: the in-memory active/zombie maps are
    // authoritative, so "no live entry" is a safe primary gate.
    const staleMs = this.reconcileStalenessMs();
    // boot-warn if the per-call cap is configured so high the derived staleness is
    // unusually long (a stale run then lingers longer before reconcile aborts it).
    if (staleMs > 30 * 60 * 1000) {
      this.logger.warn(
        `#487 reconcile staleness is ${Math.round(staleMs / 60000)}min ` +
          `(derived from max(2 x per-call cap, 15min)); a per-call cap this high ` +
          `delays stale-run recovery. Review AI_CHAT_INAPP_TOOL_CALL_CAP_MS.`,
      );
    }
    const intervalMs = this.reconcileIntervalMs();
    this.reconcileTimer = setInterval(() => {
      void this.reconcile().catch((err) => {
        this.logger.warn(
          `Periodic reconcile failed: ${
            err instanceof Error ? err.message : 'unknown error'
          }`,
        );
      });
    }, intervalMs);
    this.reconcileTimer.unref?.();
  }

  /** #487: stop the periodic reconcile timer on shutdown. */
  onModuleDestroy(): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }
  }

  /**
   * #487: reconcile staleness threshold X — a run/message is only a "no live
   * runner" abort candidate once UNTOUCHED past this. Derived as
   * max(2 x per-call cap, 15min): 2x the longest legitimate single tool call plus
   * a floor, so a marathon turn making steady progress (updatedAt bumped each
   * step) is never swept.
   */
  private reconcileStalenessMs(): number {
    return Math.max(2 * inAppToolCallCapMs(), 15 * 60 * 1000);
  }

  /** #487: how often the periodic reconcile runs (env-tunable, default 2min). */
  private reconcileIntervalMs(): number {
    const raw = Number(process.env.AI_CHAT_RECONCILE_INTERVAL_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 2 * 60 * 1000;
  }

  /**
   * #487: the periodic BIDIRECTIONAL reconcile. Runs the clauses IN ORDER; each is
   * best-effort (a failure of one never blocks the others). Single-process phase 1
   * — the run service's in-memory maps are authoritative for "live entry".
   *
   *  (a) re-drive ZOMBIE runs (a terminal write that gave up) — apply the intended
   *      status via the conditional UPDATE;
   *  (b) message 'streaming' + its RUN terminal -> stamp the message by the run's
   *      status (succeeded-run + stuck row -> 'aborted'+finalizeFailed, NOT
   *      'completed' with empty parts — the final text lived only in the dead
   *      process's memory, a documented loss);
   *  (c) run active + NO live entry + NO zombie + stale -> aborted (the run
   *      service applies the "no entry" primary gate + last-progress staleness);
   *  (d) message 'streaming' + age>X + NO active run on the chat -> aborted
   *      (historical-row safety, double-gated).
   */
  async reconcile(): Promise<void> {
    const staleMs = this.reconcileStalenessMs();

    // (a) zombie re-drive.
    if (this.aiChatRunService) {
      for (const runId of this.aiChatRunService.zombieRunIds()) {
        try {
          await this.aiChatRunService.settleZombie(runId);
        } catch (err) {
          this.logger.warn(
            `Reconcile (a) zombie ${runId} re-drive failed: ${
              err instanceof Error ? err.message : 'unknown error'
            }`,
          );
        }
      }
    }

    // (b) message streaming + run terminal -> stamp message by run status.
    try {
      const stuck = await this.aiChatMessageRepo.findStreamingWithTerminalRun();
      for (const s of stuck) {
        // succeeded-run -> 'aborted' (NOT 'completed'-empty); failed -> 'error';
        // aborted -> 'aborted'. All via the finalizeFailed stamp.
        const status = s.runStatus === 'failed' ? 'error' : 'aborted';
        await this.aiChatMessageRepo.stampTerminalIfStreaming(
          s.messageId,
          s.workspaceId,
          status,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Reconcile (b) message<-run failed: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }

    // (c) stale active run with no live runner -> aborted.
    if (this.aiChatRunService) {
      try {
        await this.aiChatRunService.reconcileStaleRuns(staleMs);
      } catch (err) {
        this.logger.warn(
          `Reconcile (c) stale-run abort failed: ${
            err instanceof Error ? err.message : 'unknown error'
          }`,
        );
      }
    }

    // (d) historical streaming row, no active run on the chat, stale -> aborted.
    try {
      await this.aiChatMessageRepo.sweepStreamingWithoutActiveRun(staleMs);
    } catch (err) {
      this.logger.warn(
        `Reconcile (d) historical-row sweep failed: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
  }

  /**
   * #487: OPPORTUNISTIC single-chat reconcile at the start of a turn (beginRun /
   * supersede path), so a user who returns to a chat with a stuck streaming row
   * (its run already terminal) sees it settled WITHOUT waiting for the periodic
   * job. Best-effort — a failure NEVER fails the turn (swallowed by the caller).
   */
  async reconcileChat(chatId: string, workspaceId: string): Promise<void> {
    const stuck = await this.aiChatMessageRepo.findStreamingWithTerminalRun(50, {
      chatId,
      workspaceId,
    });
    for (const s of stuck) {
      const status = s.runStatus === 'failed' ? 'error' : 'aborted';
      await this.aiChatMessageRepo.stampTerminalIfStreaming(
        s.messageId,
        s.workspaceId,
        status,
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
    openPage:
      | { id?: string; title?: string; selection?: unknown }
      | null
      | undefined,
    workspace: Workspace,
    user: User,
  ): Promise<{
    id: string;
    title: string;
    updatedAt: Date;
    selection: SelectionContext | null;
  } | null> {
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
    //
    // The sanitized editor selection (#388) is attached ONLY here, on a
    // successful page resolve: the fail-closed branches above return null for the
    // WHOLE context, so a selection can never outlive a foreign/missing/deleted
    // page (decision 3). Downstream consumers that don't care (detectPageChange,
    // snapshotOpenPage) ignore the extra field, same as updatedAt.
    return {
      id: page.id,
      title: page.title ?? '',
      updatedAt: page.updatedAt,
      selection: sanitizeSelection(openPage?.selection),
    };
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
      // Fast-path (#490): if a snapshot already exists at THIS page version
      // (same updated_at instant), its content is already current — skip the full
      // Markdown export + upsert entirely. A turn that did NOT touch the open page
      // (the common case) thus does no snapshot work. This mirrors the read-side
      // fast path in detectPageChange (sameInstant): both trust that a page edit
      // bumps updated_at. When the agent (or a human) DID edit the page this turn,
      // updated_at advanced, so this does not match and we re-export as before.
      const existing = await this.aiChatPageSnapshotRepo.findByChatPage(
        chatId,
        pageId,
        workspace.id,
      );
      if (existing && sameInstant(existing.pageUpdatedAt, freshPage.updatedAt)) {
        return;
      }
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
    runHooks,
    superseded,
  }: AiChatStreamArgs): Promise<void> {
    // Resolve / create the chat. A new chat is created when no valid chatId is
    // supplied or the supplied one does not belong to this workspace.
    let isNewChat = false;
    let chatId = body.chatId;
    // Persisted chat-level metadata bag (#490): read once here so the deferred-tool
    // activation set can be seeded from the previous turn. Undefined for a new chat.
    let chatMetadata: Record<string, unknown> | undefined;
    if (chatId) {
      const existing = await this.aiChatRepo.findById(chatId, workspace.id);
      if (!existing) {
        chatId = undefined;
      } else {
        chatMetadata = (existing.metadata ?? undefined) as
          | Record<string, unknown>
          | undefined;
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
      // ORPHAN-ON-BEGIN-FAILURE tradeoff (#486, B3): the chat row is inserted
      // HERE, before runHooks.begin below. If begin fails (e.g. a 503 / run-slot
      // rejection) the turn aborts before the client is told this new chatId, so
      // an empty chat is left behind and a retry mints ANOTHER one. We accept this
      // over reordering: begin needs a chatId to bind the run to, and inserting
      // the chat first keeps the id stable + the FK/history-join invariants above
      // intact. Orphan empty chats are cheap and swept by normal chat cleanup.
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

    // Start the durable RUN now that the chat id is known (#184 phase 1). The
    // returned `runId` + `signal` make the turn a first-class server-side object
    // whose abort is governed by the run (an explicit user stop), NOT by the HTTP
    // socket — so a browser disconnect no longer ends the turn. With no runHooks
    // (the default / flag off) the turn stays socket-bound via `signal` and
    // `runId` is undefined, leaving the legacy path byte-for-byte unchanged.
    let runId: string | undefined;
    let effectiveSignal = signal;
    if (runHooks) {
      try {
        const handle = await runHooks.begin(chatId);
        if (handle) {
          runId = handle.runId;
          effectiveSignal = handle.signal;
        }
      } catch (err) {
        // RACE BACKSTOP: the run-row INSERT lost the chat's single active slot
        // (the partial unique index rejected it). This is the AUTHORITATIVE
        // concurrency gate — the controller's pre-check is only a fast-path, and a
        // request that slipped past it must NOT proceed. Reject the turn with a
        // 409 NOW, BEFORE any AI/provider call: no tokens are spent and no
        // untracked turn streams. (Matches the controller's pre-check 409.)
        if (err instanceof RunAlreadyActiveError) {
          throw new ConflictException({
            message: 'An agent run is already in progress for this chat',
            code: 'A_RUN_ALREADY_ACTIVE',
          });
        }
        // Any OTHER run-start failure (e.g. a DB-pool blip) must FAIL THE TURN,
        // not silently stream without a run-row. The old fallback let the turn
        // continue untracked: in autonomous mode nobody could then abort it —
        // /stop can't see a run that doesn't exist, a client disconnect doesn't
        // abort it, and the one-run-per-chat gate would let a SECOND run in. That
        // is an unstoppable, invisible run until process restart. Reject NOW,
        // BEFORE the first byte (nothing is written yet, no user row inserted, no
        // MCP lease taken), so the controller's post-hijack catch turns this
        // HttpException into an honest 503 on the raw socket. Same policy for BOTH
        // modes — #487 inherits it (no mode-branching here).
        this.logger.error(
          `Failed to begin agent run (chat ${chatId}); failing the turn`,
          err as Error,
        );
        throw new ServiceUnavailableException({
          message:
            'Could not start the agent run. This is usually temporary — please try again.',
          code: 'A_RUN_BEGIN_FAILED',
          // Self-describe the status in the body: the controller's post-hijack
          // catch writes getResponse() verbatim onto the raw socket, and an
          // object-arg HttpException does NOT inject statusCode. Without it the
          // client's 503 classifier (which reads the body JSON) could not see the
          // status. With it present, the client's A_RUN_BEGIN_FAILED branch (which
          // runs strictly before the generic-503 branch) shows "temporary, retry".
          statusCode: 503,
        });
      }
    }

    // #487: opportunistic single-chat reconcile — settle any streaming row on this
    // chat whose run is already terminal BEFORE this turn's history load, so the
    // user never waits on the periodic job and the new turn's model history is not
    // polluted by a stuck 'streaming' row. Best-effort: it must NEVER fail the turn.
    try {
      await this.reconcileChat(chatId, workspace.id);
    } catch (err) {
      this.logger.debug(
        `Opportunistic reconcile for chat ${chatId} failed (ignored): ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }

    try {
      // Extract the incoming user turn (the last user message from useChat).
      const incoming = lastUserMessage(body.messages);
      const incomingText = uiMessageText(incoming);

      // #489: sanitize client-supplied parts ON RECEIPT. The client only ever
      // sends `sendMessage({ text })` (a single text part); there is no
      // file/attachment path. Any other part — most dangerously a tool-part in
      // `input-available` state — is untrusted data that, once persisted to
      // `metadata.parts` verbatim, is REPLAYED through convertToModelMessages on
      // every later turn. A malformed tool-part makes that conversion throw,
      // 500-ing every future turn of the chat forever ("bricked"). Drop any
      // non-whitelisted part with a warn.
      const sanitizedParts = sanitizeUserParts(incoming?.parts, (type) =>
        this.logger.warn(
          `Dropping unsupported user message part '${type}' on chat ${chatId}`,
        ),
      );

      // #489: rebuild the conversation from persisted history (not the client
      // payload) and CONVERT it to model messages BEFORE persisting the user row.
      // Load the OLD history (WITHOUT the new row) and append the incoming turn in
      // memory for the conversion. This makes the insert happen only after a
      // successful conversion, so a conversion failure cannot leave a DUPLICATE
      // user row behind on the client's retry (the "bricked chat" that accreted a
      // dup on every 500). `findAllByChat` returns chronological order (oldest ->
      // newest) and keeps a 5000-row memory-safety backstop (on overflow it keeps
      // the NEWEST rows and logs a warning); that is a safety net far above any
      // realistic chat, not a conversational limit.
      const oldHistory = await this.aiChatMessageRepo.findAllByChat(
        chatId,
        workspace.id,
      );
      // #492: HYDRATE needy assistant rows from the steps table BEFORE the replay
      // map. A #492 mid-run assistant row carries only a step marker
      // (metadata.parts:[]); its real per-step parts live in `ai_chat_run_steps`.
      // The graceful terminal callbacks (onFinish/onError/onAbort -> flushAssistant)
      // assemble the full inline parts, so a normally-ended turn already has them.
      // But a HARD crash mid-run (SIGKILL/OOM) fires NO terminal callback, so the
      // row stays parts:[]; without this, rowToUiMessage falls back to an empty
      // text part and the partial tool-calls/results/text — durable in the steps
      // table — would DROP OUT of the model's replay context (regressing #183
      // step-granular durability for the model consumer). Mirrors the controller's
      // withReconstructedParts EXACTLY (same needy predicate + hydration helper).
      // Guarded on the optional repo: absent (positional test builds) degrades to
      // the current behavior rather than crashing.
      let replayHistory = oldHistory;
      if (this.aiChatRunStepRepo) {
        const needy = oldHistory.filter(
          (r) => r.role === 'assistant' && !rowHasInlineParts(r),
        );
        if (needy.length > 0) {
          const stepsByMessage = await this.aiChatRunStepRepo.findByMessageIds(
            needy.map((r) => r.id),
            workspace.id,
          );
          replayHistory = hydrateAssistantParts(oldHistory, stepsByMessage);
        }
      }
      const uiMessages: Array<Omit<UIMessage, 'id'> & { id: string }> = [
        ...replayHistory.map(rowToUiMessage),
        {
          id: 'pending-user',
          role: 'user',
          parts: (sanitizedParts && sanitizedParts.length > 0
            ? sanitizedParts
            : textPart(incomingText)) as UIMessage['parts'],
        },
      ];
      // convertToModelMessages is async in ai@6.0.134 (returns Promise<ModelMessage[]>).
      // Resilient (#489): a single poisoned row in the OLD history is isolated via
      // per-row conversion and degraded to plain text with a "[tool context
      // omitted]" marker rather than 500-ing the whole turn (silent loss of tool
      // context is not acceptable — the model must see the truncation).
      let messages = await convertHistoryResilient(uiMessages, (index, err) =>
        this.logger.warn(
          `Degraded unconvertible history row ${index} on chat ${chatId} to text: ${
            err instanceof Error ? err.message : 'unknown error'
          }`,
        ),
      );

      // Persist the user message only AFTER a successful conversion (#489).
      await this.aiChatMessageRepo.insert({
        chatId,
        workspaceId: workspace.id,
        userId: user.id,
        role: 'user',
        content: incomingText,
        // jsonb column: UIMessage parts are JSON-serializable at runtime but not
        // structurally `JsonValue`, so cast through unknown. Persist the SANITIZED
        // parts (never the raw client parts) so the row is always convertible.
        metadata: (sanitizedParts ? { parts: sanitizedParts } : null) as never,
      });

      // #665 BIRTH BIND: on the FIRST saved user message of this chat sent FROM a
      // page, point that page's binding at this chat. The gate is a FACT, not a
      // code path — `oldHistory.length === 0` (loaded above, WITHOUT the row just
      // inserted) means "this is the first user message this chat ever persisted".
      // It deliberately is NOT `isNewChat`: a chat orphaned when runHooks.begin
      // failed has isNewChat=false on its retry but still oldHistory.length===0, and
      // must bind then (else its page never rebinds). Later turns (oldHistory>0)
      // never rebind — which preserves the agent-badge deeplink and "navigation
      // doesn't bind" decisions.
      //
      // The bound page is `openPageContext.id` — the VALIDATED page the message was
      // sent from (not `ai_chats.page_id`): on an orphan retry from another page Y
      // we bind Y ("the page you're standing on"), while page_id stays the birth
      // page X as provenance. `openPageContext === null` (off a document) => no write.
      //
      // Written AFTER the message insert (so "bound => the chat has >= 1 message"),
      // and fail-SOFT (NOT transactional): a binding-write failure must never roll
      // back the user's message or fail the turn. Worst case is "message saved, page
      // still points at the old chat" — the declared safe degradation.
      if (
        oldHistory.length === 0 &&
        openPageContext &&
        this.aiChatPageBindingRepo
      ) {
        try {
          await this.aiChatPageBindingRepo.upsert(
            user.id,
            openPageContext.id,
            chatId,
          );
        } catch (err) {
          this.logger.warn(
            `Birth page-binding failed for chat ${chatId} on page ${openPageContext.id} (reason=birth_bind_failed): ${
              err instanceof Error ? err.message : 'unknown error'
            }`,
          );
          incAiChatBindSkipped('birth_bind_failed');
        }
      }

      // Interrupt-resume detection (#198): the client "send now" flag is only a
      // hint — confirm it against the persisted history (the preceding assistant
      // turn must really be aborted/streaming) so a spoofed flag cannot inject the
      // interrupt note onto an ordinary turn. The partial output the model needs is
      // already in `messages`: a #492 mid-run row's per-step parts live only in the
      // `ai_chat_run_steps` table and were hydrated into the replay history above,
      // so the aborted assistant turn replays WITH its partial parts intact.
      // Append the new user turn (shape-only) so index -2 is the prior assistant.
      const interrupted = isInterruptResume(
        [...oldHistory, { role: 'user', status: null, metadata: null }],
        body.interrupted,
      );

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

      // History-replay token budget (#490). The full conversation is replayed to
      // the provider every turn, so a long chat eventually 400s on the context
      // window — forever. Bound the REPLAYED history (never the persisted rows).
      // PRIMARY signal is the provider's own fact: the last turn's contextTokens.
      const replayBudget = resolveReplayBudget(resolved?.chatContextWindowRaw);
      if (replayBudget.usedDefault) {
        // The default fires precisely for installs with NO configured window —
        // the ones that hit terminal overflow. Warn so it is observable.
        this.logger.warn(
          `AI chat (chat ${chatId}): no chatContextWindow configured; ` +
            `applying the default replay budget (${replayBudget.thresholdTokens} tokens).`,
        );
      }
      // Last turn's provider-reported context size (authoritative when present).
      const priorContextTokens = lastAssistantContextTokens(oldHistory);
      // Reactive recovery (#490/#520): `k` = how many CONSECUTIVE preceding turns
      // were rejected for context overflow (stamped by onError). Each consecutive
      // overflow trims MORE aggressively (resolveEffectiveReplayThreshold scales the
      // budget by 0.5**k, clamped at the floor) so recovery ESCALATES until the
      // history fits — the overflowing turn produced no usage signal, so a single
      // fixed cut may not shrink enough when the real model window is small. This is
      // what un-bricks a chat that keeps 400'ing on the context window.
      const priorOverflowCount = lastAssistantReplayOverflowCount(oldHistory);
      const effectiveThreshold = resolveEffectiveReplayThreshold(
        replayBudget.thresholdTokens,
        priorOverflowCount,
      );
      // #520 Option B: recovery MAY cut the replay budget BELOW the admin-configured
      // window when the provider keeps proving non-fit (the anti-brick invariant of
      // the reactive branch beats a config that a 400 has disproved). Surface it so
      // the admin sees their window is factually too large, and mark the turn so the
      // UI/telemetry can show it. Only true when actually below (not on in-budget
      // escalation edge cases); k>0 implies below for any budget >= 2 tokens.
      const replayBelowConfiguredBudget =
        replayBudget.thresholdTokens != null &&
        effectiveThreshold != null &&
        effectiveThreshold < replayBudget.thresholdTokens;
      if (priorOverflowCount > 0) {
        if (replayBelowConfiguredBudget) {
          this.logger.warn(
            `AI chat (chat ${chatId}): configured replay budget ` +
              `(${replayBudget.thresholdTokens} tokens) does not fit the model — ` +
              `replaying BELOW it at ${effectiveThreshold} tokens after ` +
              `${priorOverflowCount} consecutive context overflow(s) ` +
              `(escalation level ${priorOverflowCount}). Lower chatContextWindow ` +
              `to match the model's real context window.`,
          );
        } else {
          this.logger.warn(
            `AI chat (chat ${chatId}): ${priorOverflowCount} consecutive context ` +
              `overflow(s); applying escalated aggressive replay budget ` +
              `(${effectiveThreshold} tokens).`,
          );
        }
      }
      const preTrim = trimHistoryForReplay(
        messages,
        effectiveThreshold,
        // A prior OVERFLOW means the provider count is stale/absent — force the
        // char-estimate path by ignoring priorContextTokens on recovery.
        priorOverflowCount > 0 ? undefined : priorContextTokens,
      );
      messages = preTrim.messages;
      // Observability (#490): record the budgeter's decision on the turn so the UI
      // can surface "replay truncated at N tokens". Threaded into flushAssistant.
      let replayTrimmedToTokens: number | undefined = preTrim.trimmed
        ? preTrim.estimatedTokens
        : undefined;
      if (preTrim.trimmed) {
        this.logger.log(
          `AI chat (chat ${chatId}): replay history trimmed to ~${preTrim.estimatedTokens} ` +
            `tokens (budget ${replayBudget.thresholdTokens}).`,
        );
      }

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
      // #686 P4 (observability): the external-MCP connection failures surfaced to
      // the client (via the chatStreamMetadata seam) AND persisted into the
      // assistant message metadata. Populated from `external.outcomes` after a
      // build, or a single synthetic record when the whole build fails below.
      let mcpFailures: McpFailureRecord[] = [];
      try {
        // Bound the external-MCP toolset build by BOTH the run's abort signal and
        // a generous wall-clock deadline. This is the pre-streamText setup phase,
        // which streamText's terminal callbacks do NOT yet govern — so without this
        // a hung build would hang the turn at step 0 forever (the production hang),
        // unobservant of an explicit Stop. The deadline is defense-in-depth ABOVE
        // the per-server connect bound in mcp-clients.service. On a LATE resolve
        // (the race was already lost) RELEASE the abandoned toolset's leases —
        // c.close() here is the lease handle, so it decrements the cache entry's
        // refcount; it does NOT force-close the transports (the cache OWNS the
        // clients and closes them on TTL/evict). This just prevents the lease
        // refcount from being pinned >=1 forever by a toolset nobody will consume.
        external = await raceAgainstAbortAndTimeout(
          // #686: the toolset is per-user — admin servers ∪ THIS user's personal
          // servers. `user.id` is REQUIRED (the cache is always keyed per-user).
          this.mcpClients.toolsFor(workspace.id, user.id),
          effectiveSignal,
          MCP_TOOLSET_BUILD_DEADLINE_MS,
          (late) => {
            void Promise.all(
              late.clients.map((c) => c.close().catch(() => undefined)),
            );
          },
        );
        // Surface per-server connect failures (ok:false outcomes), capped.
        mcpFailures = buildMcpFailures(external.outcomes);
      } catch (err) {
        // An explicit Stop reached the RUN's signal DURING setup: re-throw so the
        // outer catch finalizes the run as aborted — never swallow a Stop. #487: the
        // turn is ALWAYS run-wrapped now (both modes), so `effectiveSignal` is the
        // RUN signal and `runId` is set in BOTH — a Stop (from /ai-chat/stop or a
        // legacy disconnect's requestStop) aborts it identically. The `runId` guard
        // now only defends the theoretical no-handle fallback (`begin` returned
        // nothing, leaving `effectiveSignal` as the bare socket signal): there we
        // keep the old warn-and-proceed rather than re-throw.
        if (runId && effectiveSignal.aborted) {
          throw err;
        }
        // Otherwise a down/slow server (build timeout or other fault) must never
        // break the turn: proceed with Docmost-only tools. Never log URLs/headers —
        // short message only.
        this.logger.warn(
          `External MCP toolset unavailable: ${
            err instanceof Error ? err.message : 'unknown error'
          }`,
        );
        // #686 P4: a TOTAL build failure yields no per-server outcomes, so
        // synthesize one record — otherwise a whole external toolset silently
        // vanishing would leave no signal (ARCH INVARIANT #10). The turn still
        // proceeds on Docmost-only tools.
        mcpFailures = [
          {
            name: '(external toolset)',
            reason: `build failed: ${truncateMcpReason(
              err instanceof Error ? err.message : 'unknown error',
            )}`,
          },
        ];
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
      // Deferred tool loading toggle (#332). When ON, the model sees a compact
      // <tool_catalog> and only CORE tools + loadTools are active each step; other
      // tools (fat/rare in-app tools + ALL external MCP tools) load on demand. When
      // OFF, every tool is active and nothing below changes.
      const deferredEnabled = this.environment.isAiChatDeferredToolsEnabled();
      // Final-step lockdown toggle (#444). Default OFF: the last step keeps its
      // tools and gets only a soft nudge (prepareAgentStep), and the token-
      // degeneration detector (onChunk below) is the anti-babble guard. ON =
      // legacy tool-stripping lockdown on the last step.
      const finalStepLockdownEnabled =
        this.environment.isAiChatFinalStepLockdownEnabled();

      // viewImage vision tool (#588). Default OFF (fail-closed). The SAME flag
      // gates BOTH the tool registration (forUser below) AND the prepareStep image
      // injection: when off, neither exists and the turn is byte-identical to
      // before. `viewImageCache` is a per-run closure Map shared BY REFERENCE with
      // viewImage.execute (which writes the delivered image bytes keyed by
      // toolCallId) — NOT experimental_context (the SDK marks that immutable inside
      // a tool execute). prepareStep reads it to inject the image as an ephemeral
      // user-role message on every step after the call, until the model has spoken.
      const viewImageEnabled = this.environment.isAiChatViewImageEnabled();
      const viewImageCache: ViewImageCache = new Map();

      let system: string;
      let docmostTools: Awaited<ReturnType<AiChatToolsService['forUser']>>;
      try {
        // Assemble the deferred catalog for the system prompt: hand-written lines
        // for the in-app deferred tools + a derived line for each external MCP tool
        // (also deferred by default). Only built when the feature is enabled.
        const toolCatalog = deferredEnabled
          ? [
              ...(await this.tools.getInAppDeferredCatalog()),
              ...buildExternalToolCatalog(external.tools),
            ]
          : [];

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
          // #487: this turn superseded a still-live run — warn the model the
          // previous run's last ops may still be applying (no quiescence).
          superseded,
          // Detected between-turns human edit to the open page (#274): adds the
          // page_changed note + unified diff so the agent doesn't overwrite it.
          pageChanged,
          // Deferred tool loading (#332): renders the <tool_catalog> block (only
          // when enabled + non-empty) so the model can activate deferred tools.
          deferredToolsEnabled: deferredEnabled,
          toolCatalog,
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
          // #588: gate + the per-run cache viewImage.execute writes into (read by
          // prepareStep below to inject the image). Off => tool not registered.
          viewImageEnabled,
          viewImageCache,
        );
      } catch (err) {
        await closeExternalClients();
        throw err;
      }

      // Base toolset: external MCP tools + Docmost in-app tools (Docmost wins on a
      // name clash — external are namespaced, so no clash is expected).
      const baseTools = { ...external.tools, ...docmostTools };

      // Deferred tool loading state (#332), scoped to THIS streaming loop:
      //  - `activatedTools` is a fresh closure Set per streamText call (not
      //    module-global), SEEDED from the chat's persisted metadata.activatedTools
      //    (#490, just below) so activation carries across turns. loadTools.execute
      //    adds to it; prepareAgentStep reads it to widen `activeTools` on the NEXT
      //    step; turn end persists it back.
      //  - `validDeferredNames` = every tool that is NOT core (the in-app deferred
      //    tools + ALL external MCP tools), computed from the ACTUAL toolset so an
      //    external tool is loadable by its namespaced name. loadTools rejects any
      //    name outside this set.
      const validDeferredNames = new Set<string>(
        Object.keys(baseTools).filter((k) => !CORE_TOOL_SET.has(k)),
      );
      // #490: seed the activation set from the chat's PERSISTED set so the model
      // does not re-run loadTools every turn to re-activate the same tools. Only
      // when deferred loading is enabled, and ALWAYS intersected with the CURRENT
      // valid deferred names — an allowlist/role change must never resurrect a tool
      // that no longer exists (prepareAgentStep would get a phantom active name).
      const activatedTools = new Set<string>(
        deferredEnabled
          ? seedActivatedTools(chatMetadata, validDeferredNames)
          : [],
      );
      // Add the loadTools meta-tool ONLY when the feature is enabled; when off the
      // toolset and behavior are exactly as before.
      const tools = deferredEnabled
        ? {
            ...baseTools,
            [LOAD_TOOLS_NAME]: makeLoadToolsTool(activatedTools, validDeferredNames),
          }
        : baseTools;

      // #490: persist the (deterministically ordered) activation set back onto the
      // chat metadata at turn end, so the NEXT turn seeds from it. Once-guarded and
      // skipped when nothing new was activated (the set equals its seed) so an
      // ordinary turn adds no extra write. Preserves other metadata keys.
      let activatedToolsPersisted = false;
      const persistActivatedTools = async (): Promise<void> => {
        if (!deferredEnabled || activatedToolsPersisted || !chatId) return;
        activatedToolsPersisted = true;
        const current = [...activatedTools].sort();
        const seeded = seedActivatedTools(chatMetadata, validDeferredNames).sort();
        if (current.length === 0 || current.join(' ') === seeded.join(' ')) {
          return; // nothing new activated -> no write
        }
        try {
          await this.aiChatRepo.update(
            chatId,
            {
              metadata: {
                ...(chatMetadata ?? {}),
                activatedTools: current,
              },
            } as never,
            workspace.id,
          );
        } catch (err) {
          this.logger.warn(
            `Failed to persist activated tools (chat ${chatId}): ${
              err instanceof Error ? err.message : 'unknown error'
            }`,
          );
        }
      };

      // Accumulate the turn's streamed output so a provider error / disconnect can
      // persist the PARTIAL answer the user already saw — the SDK's onError/onAbort
      // callbacks don't hand us the in-progress text. `capturedSteps` holds finished
      // steps (tool calls + their text); `inProgressText` holds the text streamed in
      // the CURRENT, not-yet-finished step, reset whenever a step finishes.
      const capturedSteps: StepLike[] = [];
      let inProgressText = '';

      // Per-turn step->parts memo (#490): shared across every flushAssistant call
      // this turn so each finished step's (large) output is JSON-stringified ONCE,
      // not re-stringified on every subsequent onStepFinish flush (was O(N²)).
      const partsCache: StepPartsCache = new WeakMap();

      // Token-degeneration guard (#444). When the final-step lockdown is OFF, a
      // runaway repetition loop (the 255KB "loadTools." incident) is aborted via
      // this internal controller, unioned with the run/socket signal below. The
      // detector runs on `inProgressText` in onChunk, throttled by growth so the
      // pure rules only fire every ~DEGENERATION_CHECK_STEP bytes.
      const degenerationController = new AbortController();
      let degenerationDetected = false;
      let lastDegenerationCheckLen = 0;

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
        const seed = flushAssistant([], '', 'streaming', { pageChanged });
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

      // Link the assistant message (the #183 projection) to its run (#184), so a
      // reconnecting client can resolve the run's output. Best-effort.
      if (runId && assistantId) {
        try {
          await runHooks?.onAssistantSeeded?.(runId, assistantId);
        } catch (err) {
          this.logger.warn(
            `Failed to link assistant row to run ${runId}: ${
              err instanceof Error ? err.message : 'unknown error'
            }`,
          );
        }
      }

      // Per-step (non-terminal) update: persist the finished steps the moment a
      // step ends. Tolerant — a failed update is logged and swallowed so it never
      // throws into the stream. Keeps status 'streaming'.
      //
      // #491: it now SIGNALS its outcome — the persisted `stepsPersisted` count on
      // a CONFIRMED write, or null when it was skipped/failed. The caller rotates
      // the run-stream registry ring ONLY on a non-null return (a confirmed
      // persist), so a failed persist never rotates away a step nobody has (the
      // classic inversion bug); a failure just makes the ring cover more.
      const updateStreaming = async (): Promise<number | null> => {
        if (!assistantId) return null;
        // Cheap short-circuit once the turn is finalized (see `finalized` below).
        // The AUTHORITATIVE guard is `onlyIfStreaming` on the UPDATE: a late
        // fire-and-forget step update could still be in flight on another pool
        // connection when finalize runs, so the SQL `WHERE status='streaming'`
        // (not this flag) is what prevents it clobbering the terminal row.
        if (finalized) return null;
        // The count derives from capturedSteps.length at THIS instant, so the
        // returned value is EXACTLY the persisted `stepsPersisted` the ring rotates
        // on (whether we take the append-persist path or the legacy fallback).
        const stepsPersisted = capturedSteps.length;
        try {
          if (this.aiChatRunStepRepo) {
            // #492 APPEND-PERSIST: write only THIS finished step's parts to the
            // steps table (O(step) WAL), then bump the row's CHEAP step marker —
            // NO growing `metadata.parts` blob (that O(n²) full-row rewrite is
            // exactly what this removes). The full `metadata.parts` is assembled
            // once at finalize; a mid-run resume seed is reconstructed from the
            // step rows (reconstructRunParts). The INSERT is idempotent
            // (ON CONFLICT DO NOTHING), so a re-fired step never doubles the parts.
            const index = stepsPersisted - 1;
            if (index >= 0) {
              const stepParts = assistantParts(
                [capturedSteps[index]],
                '',
                partsCache,
              );
              await this.aiChatRunStepRepo.insertStep(
                assistantId,
                workspace.id,
                index,
                stepParts,
              );
            }
            // Marker UPDATE: advance stepsPersisted + keep the toolTrace era marker
            // (bumps updatedAt so the delta poll observes the step, and carries the
            // frontier a resuming client attaches from). Scoped onlyIfStreaming so a
            // late marker never clobbers the terminal finalize.
            await this.aiChatMessageRepo.update(
              assistantId,
              workspace.id,
              { metadata: stepMarkerMetadata(stepsPersisted) },
              { onlyIfStreaming: true },
            );
          } else {
            // Legacy fallback (no steps table wired — positional test builds): the
            // pre-#492 full-row flush, so parts still land inline on the row.
            const flushed = flushAssistant(capturedSteps, '', 'streaming', {
              pageChanged,
              partsCache,
            });
            await this.aiChatMessageRepo.update(
              assistantId,
              workspace.id,
              flushed,
              { onlyIfStreaming: true },
            );
          }
          return stepsPersisted;
        } catch (err) {
          this.logger.warn(
            `Failed to update streaming assistant row: ${
              err instanceof Error ? err.message : 'unknown error'
            }`,
          );
          return null;
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
      // #487: the once-gate closes ONLY AFTER a successful write, and the write is
      // BOUNDED-RETRIED. Previously `finalized` was set BEFORE the write and never
      // retried, so a single failed UPDATE stranded the row 'streaming' forever
      // (the boot-only sweep was the only recovery). Now a transient blip is ridden
      // out in place; a total give-up leaves the gate OPEN and logs, and the
      // periodic reconcile (clauses b/d) later settles the row. Returns whether the
      // terminal write LANDED, so the caller can error-mark the RUN on a message
      // failure (the run is finalized regardless — never gated on the message).
      let finalized = false;
      const FINALIZE_MSG_MAX_ATTEMPTS = 3;
      const finalizeAssistant = async (
        flushed: AssistantFlush,
      ): Promise<boolean> => {
        if (finalized) return true;
        const plan = planFinalizeAssistant(assistantId);
        let lastError: unknown;
        for (let attempt = 1; attempt <= FINALIZE_MSG_MAX_ATTEMPTS; attempt++) {
          try {
            // Shared dispatch (see applyFinalize): conditionally UPDATE the upfront
            // row (owner-write priority), or — when the upfront insert failed (kind
            // 'insert') — INSERT the terminal row as the only safety against losing
            // the turn entirely.
            await applyFinalize(
              this.aiChatMessageRepo,
              plan,
              { chatId, workspaceId: workspace.id, userId: user.id },
              flushed,
            );
            finalized = true; // gate closes ONLY after a successful write
            return true;
          } catch (err) {
            lastError = err;
            this.logger.warn(
              `Assistant message finalize attempt ${attempt}/${FINALIZE_MSG_MAX_ATTEMPTS} ` +
                `failed (kind=${plan.kind}): ${
                  err instanceof Error ? err.message : 'unknown error'
                }`,
            );
            if (attempt < FINALIZE_MSG_MAX_ATTEMPTS) {
              await new Promise((r) => setTimeout(r, 50 * attempt));
            }
          }
        }
        // Gave up: leave the gate OPEN (no in-process second settler exists — the
        // terminal callbacks are mutually exclusive) and log. The periodic reconcile
        // settles the stranded row; a late owner-write is impossible for this turn,
        // so the reconcile stamp (aborted+finalizeFailed) is the final state.
        this.logger.error(
          `Assistant message finalize GAVE UP after ${FINALIZE_MSG_MAX_ATTEMPTS} ` +
            `attempts (row left 'streaming', chat ${chatId}); reconcile will settle it`,
          lastError as Error,
        );
        return false;
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
          // Pin the AI SDK per-request retry budget explicitly instead of relying
          // on its default (which is also 2). Connection arithmetic per turn:
          // (1 + maxRetries=2) × (1 + AI_STREAM_PRE_RESPONSE_RETRIES) network
          // connects worst-case — the two retry layers compose, so making the SDK
          // side explicit keeps that ceiling visible and pinned against SDK-default
          // drift.
          maxRetries: 2,
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
          prepareStep: (opts) => {
            const base = prepareAgentStep(
              opts.stepNumber,
              system,
              activatedTools,
              deferredEnabled,
              finalStepLockdownEnabled,
            );
            // #588: when viewImage is enabled, inject each still-live cached image
            // as an ephemeral trailing user message on EVERY step after its call
            // (so the model sees it on intermediate tool steps AND the final
            // synthesis step, incl. a toolChoice:'none' lockdown step), evicting an
            // entry once the model has spoken about it. When off, `base` is returned
            // untouched — no injection. The disjoint-key merge preserves base's
            // activeTools/toolChoice/system so the image rides to synthesis.
            if (!viewImageEnabled) return base;
            return injectViewImages(base, opts, viewImageCache);
          },
          // #184: the RUN's signal (explicit-stop) when a run wraps this turn, else
          // the socket-bound signal (legacy). A browser disconnect aborts only in
          // the legacy path. #444: UNION it with the internal degeneration signal
          // so a detected token-loop aborts the run too (AbortSignal.any — Node 20.3+).
          abortSignal: AbortSignal.any([
            effectiveSignal,
            degenerationController.signal,
          ]),
          onChunk: ({ chunk }) => {
            // DIAGNOSTIC (Safari stream-drop investigation) — temporary. Any model
            // output chunk means the stream is actively emitting bytes; track first
            // + most-recent activity timestamps.
            const now = Date.now();
            firstModelChunkAt ??= now;
            lastModelChunkAt = now;
            // 'text-delta' is the assistant's prose; tool-call args are separate chunk
            // types — so this mirrors exactly what streams to the client.
            if (chunk.type === 'text-delta') {
              inProgressText += chunk.text;
              // Token-degeneration guard (#444). Throttled: only re-run the pure
              // rules once the text has grown ~DEGENERATION_CHECK_STEP bytes since
              // the last check, so the tail heuristics cost is amortized. On a
              // trigger, abort the run ONCE with a distinguishable reason.
              if (
                !degenerationDetected &&
                shouldCheckDegeneration(
                  inProgressText.length,
                  lastDegenerationCheckLen,
                )
              ) {
                lastDegenerationCheckLen = inProgressText.length;
                if (isDegenerateOutput(inProgressText)) {
                  degenerationDetected = true;
                  this.logger.warn(
                    `AI chat stream aborted (chat ${chatId}): ${OUTPUT_DEGENERATION_ERROR}`,
                  );
                  degenerationController.abort(
                    new Error(OUTPUT_DEGENERATION_ERROR),
                  );
                }
              }
            }
          },
          onStepFinish: (step) => {
            // The finished step's full text is now in `step.text`; fold it in and reset
            // the in-progress accumulator for the next step.
            capturedSteps.push(step as StepLike);
            inProgressText = '';
            // Reset the degeneration-check watermark too (#486): it tracks a byte
            // offset INTO inProgressText, so once that resets to '' a stale (large)
            // mark makes `inProgressText.length - lastDegenerationCheckLen` go
            // negative and the throttled detector stays silent until a later step's
            // text re-grows past the old offset — a whole degenerate step could slip
            // through undetected. Zeroing it re-arms the check from the next byte.
            lastDegenerationCheckLen = 0;
            // Step-granular durability (#183): persist this finished step (its text +
            // tool calls + tool RESULTS) the moment it ends, so a process death after
            // this point still recovers the step. Not awaited here (never block the
            // stream), but SERIALIZED via stepUpdateChain so the writes commit in
            // step order; updateStreaming is error-tolerant (logs + swallows).
            // #491: on a CONFIRMED persist, rotate the run-stream registry ring to
            // drop the now-on-disk steps (stamp < stepsPersisted). Gated on the
            // resumable flag (same as open/bind) and identity-checked in the
            // registry; a null return (skipped/failed) rotates NOTHING (auto-safe).
            stepUpdateChain = stepUpdateChain.then(async () => {
              const persisted = await updateStreaming();
              if (
                persisted != null &&
                runId &&
                this.environment?.isAiChatResumableStreamEnabled?.()
              ) {
                this.streamRegistry?.confirmPersistedStep(
                  chatId,
                  runId,
                  persisted,
                );
              }
            });
            // #184: persist the run's progress (finished-step count). Fire-and-
            // forget; the hook swallows its own errors.
            if (runId) runHooks?.onStep?.(runId, capturedSteps.length);
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
            // Empty-turn mitigation (#444, toggle OFF). If the turn burned all its
            // steps WITHOUT ever producing text (every step's text is empty) and
            // the model stopped because it hit the step cap, there is no answer to
            // show — the lockdown used to force one. Append a synthetic marker as
            // the trailing text so the exhausted-without-answer state is explicit
            // to the user and, on replay, to the model next turn. `flushAssistant`
            // takes this as the `inProgressText` trailing text arg (empty here
            // otherwise). `stepCountIs(MAX_AGENT_STEPS)` surfaces as
            // finishReason === 'tool-calls' (or a length/other cap), so we key off
            // "no text produced" rather than a single finishReason string.
            const producedText = (steps as StepLike[]).some((s) => s.text?.trim());
            const stepExhausted = steps.length >= MAX_AGENT_STEPS;
            const emptyTurnMarker =
              !producedText && stepExhausted ? STEP_LIMIT_NO_ANSWER_MARKER : '';
            const msgOk = await finalizeAssistant(
              flushAssistant(steps as StepLike[], emptyTurnMarker, 'completed', {
                finishReason: finishReason as string,
                usage: totalUsage as StreamUsage,
                contextTokens:
                  (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) ||
                  undefined,
                // Max context window for the chat header badge denominator;
                // resolved from the admin-configured provider settings (in
                // closure scope here). Omitted/0 = no limit.
                maxContextTokens: resolved?.chatContextWindow,
                pageChanged,
                partsCache,
                replayTrimmedToTokens,
                // #520 Option B: mark the turn when recovery replayed BELOW the
                // configured budget (only when it actually did).
                replayBelowConfiguredBudget:
                  replayBelowConfiguredBudget || undefined,
                // #686 P4: persist the external-MCP failures for this turn.
                mcpFailures,
              }),
            );
            // #184/#487: the RUN is finalized ALWAYS (never gated on the message).
            // If the message finalize GAVE UP, error-mark the run so the asymmetry
            // "run succeeded / message streaming forever" cannot arise; the
            // periodic reconcile then settles the stuck message from this run.
            if (runId) {
              await runHooks?.onSettled?.(
                runId,
                msgOk ? 'completed' : 'error',
                msgOk
                  ? undefined
                  : 'Assistant message could not be persisted (finalize failed).',
              );
            }
            // Lifecycle: release the external MCP clients leased for this turn.
            await closeExternalClients();

            // Turn end (#274): snapshot the open page's current Markdown (after all
            // of the agent's edits this turn) so the NEXT turn can diff against it
            // and detect edits a human made in between. Self-clearing — the agent's
            // own edits are baked in — and this also SEEDS the snapshot on the first
            // turn. Runs once across every terminal path (see snapshotTurnEnd).
            await snapshotTurnEnd();
            // #490: persist the deferred-tool activation set for the next turn.
            await persistActivatedTools();

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
            // #490 reactive branch: classify a CONTEXT-OVERFLOW rejection (the
            // replayed history exceeded the model window). The overflowing turn had
            // no prior usage to trigger preventive trimming, so we record a clear,
            // distinguishable cause AND stamp the row so the NEXT turn's budgeter
            // trims aggressively — the reactive recovery that un-bricks the chat.
            const overflow = isContextOverflowError(error);
            const providerError = describeProviderError(error, String(error));
            const errorText = overflow
              ? `${CONTEXT_OVERFLOW_ERROR_PREFIX} (${providerError})`
              : providerError;
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
                pageChanged,
                partsCache,
                replayTrimmedToTokens,
                // #520: escalate the consecutive-overflow counter so the NEXT turn
                // trims MORE aggressively (0.5**k). k grows by 1 each consecutive
                // overflow; a clean finalize omits the field, resetting it to 0.
                replayOverflowCount: overflow
                  ? priorOverflowCount + 1
                  : undefined,
                // #520 Option B: mark the turn when THIS replay was already below the
                // configured budget (only when it actually was).
                replayBelowConfiguredBudget:
                  replayBelowConfiguredBudget || undefined,
                // #686 P4: persist the external-MCP failures for this turn.
                mcpFailures,
              }),
            );
            // #184: settle the RUN as failed, carrying the provider/transport cause.
            if (runId) await runHooks?.onSettled?.(runId, 'error', errorText);
            await closeExternalClients();
            // Advance the page snapshot even on failure (#274): an agent edit that
            // committed before the error must be baked into the snapshot, or the
            // next turn would mis-report it as a user edit.
            await snapshotTurnEnd();
            // #490: persist the deferred-tool activation set for the next turn.
            await persistActivatedTools();
          },
          onAbort: async ({ steps }) => {
            // #444: distinguish a degeneration abort (our internal controller) from
            // a user Stop / disconnect. On degeneration we truncate the runaway tail
            // before persist (so hundreds of KB of garbage never reach the DB /
            // replay) and record it as an ERROR with a clear, distinguishable reason
            // — NOT a bare 'aborted' (a user Stop) and NOT a swept 'streaming' (a
            // server restart).
            if (degenerationDetected) {
              const truncated = truncateDegeneratedTail(inProgressText);
              await finalizeAssistant(
                flushAssistant(capturedSteps, truncated, 'error', {
                  error: OUTPUT_DEGENERATION_ERROR,
                  pageChanged,
                  partsCache,
                  // #686 P4: persist the external-MCP failures for this turn.
                  mcpFailures,
                }),
              );
              if (runId)
                await runHooks?.onSettled?.(
                  runId,
                  'error',
                  OUTPUT_DEGENERATION_ERROR,
                );
              await closeExternalClients();
              await snapshotTurnEnd();
              // #490: persist the deferred-tool activation set for the next turn.
              await persistActivatedTools();
              return;
            }
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
              flushAssistant(capturedSteps, inProgressText, 'aborted', {
                pageChanged,
                partsCache,
                // #686 P4: persist the external-MCP failures for this turn.
                mcpFailures,
              }),
            );
            // #184: settle the RUN as aborted (an explicit user stop reached the
            // run's signal; a disconnect does not abort a run-wrapped turn).
            if (runId) await runHooks?.onSettled?.(runId, 'aborted');
            await closeExternalClients();
            // Advance the page snapshot even on abort (#274): an agent edit that
            // committed before the client disconnect / stop() must be baked into the
            // snapshot, or the next turn would mis-report it as a user edit.
            await snapshotTurnEnd();
            // #490: persist the deferred-tool activation set for the next turn.
            await persistActivatedTools();
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
          // #184 phase 1.5: run-wrapped mode only — the legacy path (flag off) stays
          // byte-for-byte identical, including the absence of start.messageId. Both
          // fields are gated on `runId` (present only for a durable run) AND the
          // AI_CHAT_RESUMABLE_STREAM flag; the seed `assistantId` is unconditional,
          // so gating on `assistantId` alone would change the legacy wire.
          ...(runId && this.environment?.isAiChatResumableStreamEnabled?.()
            ? {
                // Tee the SSE frames into the run-stream registry so late tabs can
                // attach (replay + live tail).
                consumeSseStream: ({
                  stream,
                }: {
                  stream: ReadableStream<string>;
                }) =>
                  this.streamRegistry?.bind(
                    chatId,
                    runId!,
                    assistantId,
                    stream,
                  ),
                // Stamp the persisted assistant row's DB id onto the streamed
                // message so every tab renders the SAME id as the DB row (id-based
                // reconciliation). Seeding is best-effort: when it failed, let the
                // client generate the id.
                ...(assistantId
                  ? { generateMessageId: () => assistantId }
                  : {}),
              }
            : {}),
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
            return chatStreamMetadata(
              p,
              chatId,
              cumulativeStepUsage,
              runId,
              // #686 P4: deliver the external-MCP failures on the `start` part.
              mcpFailures,
            );
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
    } catch (err) {
      // #184 safety net (see the opening comment): settle the run on ANY failure
      // before streamText's callbacks own the lifecycle, so the run row never
      // stays 'running' forever (which would 409 every later turn in this chat).
      // finalizeRun (onSettled) is idempotent — a settle here and a settle from a
      // streamText callback collapse to a single terminal write.
      if (runId) {
        // #184 phase 1.5: a failure here means the tee `done` will never arrive,
        // so release the registry entry's subscribers explicitly — otherwise an
        // attached tab hangs forever. Same flag gate as the tee wiring above.
        if (this.environment?.isAiChatResumableStreamEnabled?.()) {
          this.streamRegistry?.abortEntry(chatId, runId);
        }
        // Distinguish an explicit Stop (the run's signal aborted during setup) from
        // a real failure, so the run settles with the correct terminal status
        // instead of always 'error'. onSettled/finalizeRun is idempotent, so this
        // is safe even if a streamText callback also settles the run.
        const settleStatus = effectiveSignal.aborted ? 'aborted' : 'error';
        await runHooks?.onSettled?.(
          runId,
          settleStatus,
          settleStatus === 'aborted'
            ? undefined
            : err instanceof Error
              ? err.message
              : 'Agent run failed before streaming started',
        );
      }
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
  async generatePageTitle(
    workspaceId: string,
    content: string,
  ): Promise<string> {
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
/**
 * One external-MCP connection failure surfaced to the client + persisted (#686
 * P4). `name` is the server's display name (or `(external toolset)` for a total
 * build failure); `reason` is a short, non-sensitive cause (never a URL/header).
 */
export interface McpFailureRecord {
  name: string;
  reason: string;
}

/** Truncate a failure reason to the shared per-reason budget (#686). */
export function truncateMcpReason(reason: string): string {
  const r = typeof reason === 'string' ? reason : String(reason ?? '');
  return r.length > MCP_FAILURE_REASON_MAX
    ? r.slice(0, MCP_FAILURE_REASON_MAX)
    : r;
}

/**
 * Build the capped external-MCP failure list from a turn's per-server outcomes
 * (#686 P4): ONLY the `ok:false` outcomes, at most {@link MCP_FAILURES_CAP} of
 * them, each reason truncated to {@link MCP_FAILURE_REASON_MAX} chars (ARCH
 * INVARIANT #1 — a bounded payload). A hostile/verbose provider error therefore
 * can never dominate the delivered/persisted metadata.
 */
export function buildMcpFailures(
  outcomes:
    | ReadonlyArray<{ name?: string; ok?: boolean; reason?: string }>
    | undefined,
): McpFailureRecord[] {
  if (!Array.isArray(outcomes)) return [];
  const out: McpFailureRecord[] = [];
  for (const o of outcomes) {
    if (!o || o.ok !== false) continue;
    out.push({
      name: typeof o.name === 'string' ? o.name : '',
      reason: truncateMcpReason(o.reason ?? 'unavailable'),
    });
    if (out.length >= MCP_FAILURES_CAP) break;
  }
  return out;
}

export function chatStreamMetadata(
  part: StreamMetadataPart,
  chatId: string,
  cumulativeStepUsage?: ChatStreamUsage,
  // #184: the active run's id, attached alongside `chatId` on the `start` part so
  // the client learns the run it can reconnect to / stop. Omitted when the turn
  // is not run-wrapped (legacy path).
  runId?: string,
  // #686 P4: external-MCP connection failures for this turn, delivered on the
  // `start` part so the client can show which external tools are unavailable.
  // Omitted when the list is empty (unchanged wire for the common no-failure case).
  mcpFailures?: ReadonlyArray<McpFailureRecord>,
):
  | { chatId: string; runId?: string; mcpFailures?: McpFailureRecord[] }
  | { usage: ChatStreamUsage }
  | undefined {
  if (part.type === 'start') {
    const base = runId ? { chatId, runId } : { chatId };
    return mcpFailures && mcpFailures.length > 0
      ? { ...base, mcpFailures: [...mcpFailures] }
      : base;
  }
  if (part.type === 'finish-step') {
    return cumulativeStepUsage ? { usage: cumulativeStepUsage } : undefined;
  }
  if (part.type === 'finish') {
    const usage = normalizeStreamUsage(part.totalUsage);
    return usage ? { usage } : undefined;
  }
  return undefined;
}

/**
 * The provider-reported context size of the most recent assistant turn, read from
 * its persisted `metadata.contextTokens` (#490 replay budgeter's PRIMARY signal —
 * the provider's own fact, not an estimate). Returns undefined for a chat with no
 * assistant turn yet, or one whose last turn recorded no usage (e.g. it errored),
 * in which case the budgeter falls back to the char-estimate.
 */
export function lastAssistantContextTokens(
  history: ReadonlyArray<AiChatMessage>,
): number | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const row = history[i];
    if (row.role !== 'assistant') continue;
    const meta = (row.metadata ?? {}) as { contextTokens?: unknown };
    const n = meta.contextTokens;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
  }
  return undefined;
}

/**
 * Seed the per-turn deferred-tool activation set from a chat's persisted metadata
 * (#490), INTERSECTED with the current valid deferred names. Persisting the set
 * across turns saves the model re-running loadTools every turn to re-activate the
 * same tools; intersecting on load means a changed allowlist / role can never
 * resurrect a tool that no longer exists (which would hand prepareAgentStep a
 * phantom active name). Tolerant of any stored shape — a non-array is ignored.
 */
export function seedActivatedTools(
  metadata: Record<string, unknown> | undefined,
  validDeferredNames: ReadonlySet<string>,
): string[] {
  const stored = metadata?.activatedTools;
  if (!Array.isArray(stored)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of stored) {
    if (typeof name === 'string' && validDeferredNames.has(name) && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * How many CONSECUTIVE recent turns were rejected for CONTEXT OVERFLOW (#490/#520):
 * `k`, read from the most recent assistant row's `metadata.replayOverflowCount`
 * (stamped by the stream's onError, incremented each consecutive overflow and reset
 * to 0 on any clean finalize). The next turn's budgeter feeds this to
 * {@link resolveEffectiveReplayThreshold} to trim with ESCALATING aggression — the
 * reactive recovery. Only the LAST assistant turn matters (its count already carries
 * the consecutive streak; an older overflow followed by a clean turn was recovered),
 * so we stop at the first assistant row scanning backwards.
 *
 * BACK-COMPAT: a row written by the pre-#520 boolean stamp (`replayOverflow: true`,
 * no count) is read as k=1 — the old single 0.5× behavior — so in-flight chats do
 * not regress across the deploy.
 */
export function lastAssistantReplayOverflowCount(
  history: ReadonlyArray<AiChatMessage>,
): number {
  for (let i = history.length - 1; i >= 0; i--) {
    const row = history[i];
    if (row.role !== 'assistant') continue;
    const meta = (row.metadata ?? {}) as {
      replayOverflowCount?: unknown;
      replayOverflow?: unknown;
    };
    if (typeof meta.replayOverflowCount === 'number') {
      // Guard against a corrupt/negative persisted value.
      return meta.replayOverflowCount > 0
        ? Math.floor(meta.replayOverflowCount)
        : 0;
    }
    // Back-compat: legacy boolean stamp -> one overflow (0.5× cut).
    return meta.replayOverflow === true ? 1 : 0;
  }
  return 0;
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
 * Part types accepted on an INCOMING user turn (#489). The client only ever
 * sends `sendMessage({ text })` (a single text part); there is no file/attachment
 * path. Everything else on a client-supplied user message — most dangerously a
 * tool-part in `input-available` state — is untrusted data that would be
 * persisted to `metadata.parts` verbatim and replayed through
 * `convertToModelMessages` on every later turn, potentially bricking the chat.
 */
const ALLOWED_USER_PART_TYPES: ReadonlySet<string> = new Set(['text']);

/**
 * Keep only whitelisted parts on a client-supplied user message; report each
 * dropped part's type via `onDrop` (the caller warns). Returns `undefined` when
 * nothing survives (no parts / none whitelisted), so the caller persists a null
 * metadata rather than an empty-parts object. Never throws.
 */
export function sanitizeUserParts(
  parts: UIMessage['parts'] | undefined,
  onDrop: (type: string) => void,
): UIMessage['parts'] | undefined {
  if (!Array.isArray(parts)) return undefined;
  const kept = parts.filter((p) => {
    const type =
      typeof (p as { type?: unknown })?.type === 'string'
        ? (p as { type: string }).type
        : '';
    if (ALLOWED_USER_PART_TYPES.has(type)) return true;
    onDrop(type || '(unknown)');
    return false;
  });
  return kept.length > 0 ? (kept as UIMessage['parts']) : undefined;
}

/** Marker for a history row whose tool parts could not be replayed (#489). */
export const TOOL_CONTEXT_OMITTED_MARKER = '[tool context omitted]';

/**
 * Synthetic error text for a tool call that neither returned a result nor threw
 * a `tool-error` — i.e. it was interrupted mid-step (an abort / server restart).
 * Shared by `assistantParts` (the replayed `output-error` part) and
 * `serializeSteps` (the `{ kind: 'interrupted' }` trace element) so the replay
 * text and the trace stay in lockstep (#490).
 */
export const TOOL_CALL_INCOMPLETE_TEXT = 'Tool call did not complete.';

/**
 * Convert persisted UI history to model messages, tolerating a single poisoned
 * row (#489). `convertToModelMessages` over the WHOLE array throws if ANY row is
 * malformed (e.g. a tool-part left unbalanced / in `input-available` state),
 * which would otherwise 500 every turn of the chat forever. On a batch failure we
 * fall back to per-row conversion so the bad row is isolated: it is degraded to
 * plain text carrying its readable text plus a `[tool context omitted]` marker
 * (the model MUST see that its tool context was truncated — silent loss is not
 * acceptable), while every healthy row converts normally. Because AI SDK v6
 * carries a tool call and its result inside the SAME assistant UIMessage's parts,
 * per-row conversion preserves call/result pairing.
 */
export async function convertHistoryResilient(
  uiMessages: Array<Omit<UIMessage, 'id'> & { id: string }>,
  onDegrade: (index: number, err: unknown) => void,
): Promise<ModelMessage[]> {
  try {
    return await convertToModelMessages(uiMessages as UIMessage[]);
  } catch {
    const out: ModelMessage[] = [];
    for (let i = 0; i < uiMessages.length; i++) {
      const m = uiMessages[i];
      try {
        out.push(...(await convertToModelMessages([m as UIMessage])));
      } catch (err) {
        onDegrade(i, err);
        const text = uiMessageText(m as UIMessage);
        const degraded = text
          ? `${text}\n\n${TOOL_CONTEXT_OMITTED_MARKER}`
          : TOOL_CONTEXT_OMITTED_MARKER;
        out.push({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: degraded,
        } as ModelMessage);
      }
    }
    return out;
  }
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
  // ai@6.0.134: a tool that THREW surfaces as a `tool-error` content part
  // ({ type:'tool-error', toolCallId, toolName, input, error }), NOT as a
  // `toolResults` entry (which holds only successes). Read from here so failed
  // calls are persisted with their real error instead of being dropped.
  content?: ReadonlyArray<{
    type?: string;
    toolCallId?: string;
    toolName?: string;
    input?: unknown;
    error?: unknown;
  }>;
};

/**
 * Compaction tunables for persisted tool OUTPUTS. Read tools (getPage,
 * getPageJson, getNode, diffPageVersions, exportPageMarkdown, ...) return whole
 * pages. Their outputs are stored in `metadata.parts` and RE-SENT to the
 * provider on every later turn via convertToModelMessages. We deliberately keep
 * these outputs FULL up to a high safety cap (MAX_TOOL_OUTPUT_BYTES) so the
 * model never sees a shortened copy of content it already fetched: an earlier
 * 4000-byte cap shrank normal page reads (often tens of KB) to a tiny preview,
 * and the model — seeing a truncation marker in its OWN history — re-read the
 * same page, wasting tokens. Only a single output LARGER than the cap is
 * compacted at all, purely as a backstop against a pathological payload; even
 * then we preserve the object's shape and its small scalar fields
 * (id/title/pageId) that the client reads to render citations.
 */
// HIGH safety backstop: only an output whose JSON serialization EXCEEDS this is
// compacted at all. Normal reads (whole pages, tens of KB) stay well under it
// and are stored + replayed VERBATIM (fast path: returned unchanged, by
// identity). Only a single pathologically huge output (> 200 KB) is compacted.
const MAX_TOOL_OUTPUT_BYTES = 200_000;
// Inside the backstop path only (i.e. once the whole output already exceeded
// MAX_TOOL_OUTPUT_BYTES), a string longer than this is reduced to a leading
// preview; normal outputs never reach this branch.
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
      return `${value.slice(0, TOOL_OUTPUT_STRING_PREVIEW)}…[${
        value.length - TOOL_OUTPUT_STRING_PREVIEW
      } chars omitted from stored chat history to bound replay size — call the tool again to read the full output]`;
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
 * Extract a bounded string message from a `tool-error` part's `error` field for
 * persistence and history replay. The field may be an `Error`, a string, or an
 * arbitrary object, so pull a message robustly. The result is passed through
 * `compactValue` so a very long error honors the SAME truncation limits the file
 * already applies to tool outputs (no new limit is introduced here).
 */
function normalizeToolError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : error != null &&
            typeof (error as { message?: unknown }).message === 'string'
          ? (error as { message: string }).message
          : String(error);
  return compactValue(message, 0) as string;
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
/**
 * Per-turn memo for {@link assistantParts}: a step's rebuilt parts keyed by the
 * step OBJECT's identity (#490). A finished step in `capturedSteps` keeps a stable
 * reference across every mid-stream flush, and `compactToolOutput` inside it does a
 * `JSON.stringify` of the whole (often 50–200 KB) output — so without a memo each
 * `onStepFinish` re-stringifies EVERY prior step's output (O(N²) stringify over a
 * turn). Keyed by step identity => one stringify per step per turn. WeakMap so a
 * turn's steps are GC'd with the turn.
 */
export type StepPartsCache = WeakMap<object, Array<Record<string, unknown>>>;

/** Build the parts for ONE step (text + a part per tool call). Pure. */
function buildStepParts(step: StepLike): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  if (step.text) {
    parts.push({ type: 'text', text: step.text });
  }
  // Index this step's results by tool call id to pair calls with outputs.
  const resultsById = new Map<string, unknown>();
  for (const r of step.toolResults ?? []) {
    if (r.toolCallId) resultsById.set(r.toolCallId, r.output);
  }
  // Index this step's THROWN tool failures (ai@6 `tool-error` content parts)
  // by tool call id, so a call that failed replays with its real error text.
  const errorsById = new Map<string, unknown>();
  for (const part of step.content ?? []) {
    if (part.type === 'tool-error' && part.toolCallId) {
      errorsById.set(part.toolCallId, part.error);
    }
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
    } else if (errorsById.has(call.toolCallId)) {
      // The tool THREW: replay the REAL error so the model on the next turn
      // knows WHY the call failed (and does not blindly repeat it). An
      // output-error round-trips through convertToModelMessages as a balanced
      // tool-call + tool-result, keeping the rebuilt history valid.
      parts.push({
        type: `tool-${call.toolName}`,
        toolCallId: call.toolCallId,
        state: 'output-error',
        input: call.input,
        errorText: normalizeToolError(errorsById.get(call.toolCallId)),
      });
    } else {
      // No paired result AND no tool-error (e.g. aborted mid-step). Persisting
      // a bare tool-call (input-available) would replay as an unpaired call and
      // throw MissingToolResultsError on the next turn (convertToModelMessages
      // emits no tool-result for it). Emit a SYNTHETIC paired result instead:
      // an output-error round-trips through convertToModelMessages as a
      // balanced tool-call + tool-result, keeping the rebuilt history valid.
      parts.push({
        type: `tool-${call.toolName}`,
        toolCallId: call.toolCallId,
        state: 'output-error',
        input: call.input,
        errorText: TOOL_CALL_INCOMPLETE_TEXT,
      });
    }
  }
  return parts;
}

export function assistantParts(
  steps: ReadonlyArray<StepLike> | undefined,
  fallbackText: string,
  cache?: StepPartsCache,
): UIMessage['parts'] {
  const parts: Array<Record<string, unknown>> = [];
  for (const step of steps ?? []) {
    // Memoize per step object (#490): a finished step is immutable and keeps its
    // reference across flushes, so its parts (and the costly output stringify) are
    // built exactly once per turn. A cache miss (or no cache) just rebuilds.
    let stepParts = cache?.get(step as object);
    if (!stepParts) {
      stepParts = buildStepParts(step);
      cache?.set(step as object, stepParts);
    }
    parts.push(...stepParts);
  }
  const sawText = parts.some((p) => p.type === 'text');
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
 * Cheap step-marker metadata for the #492 per-step UPDATE. Advances
 * `stepsPersisted` (the resume attach frontier) and keeps the `toolTraceVersion`
 * era marker, WITHOUT the growing `parts` blob (those live in the steps table
 * now; the full `metadata.parts` is assembled once at finalize by flushAssistant).
 * `parts: []` is kept for shape stability — it reads as an empty inline-parts row,
 * which is exactly the discriminator that routes reconstruction to the steps table.
 */
export function stepMarkerMetadata(
  stepsPersisted: number,
): Record<string, unknown> {
  return { parts: [], toolTraceVersion: 2, stepsPersisted };
}

/**
 * Whether an assistant row already carries its full UI parts INLINE on the row
 * (`metadata.parts`). TRUE for every FINISHED row — old-era rows AND #492 rows,
 * whose full parts are assembled once at finalize — and for old-era streaming
 * snapshots (the pre-#492 per-step full-row flush). FALSE for a #492 MID-RUN
 * record, whose per-step parts live in the `ai_chat_run_steps` table. This is the
 * era discriminator the reconstruct seam branches on — no schema flag needed.
 */
export function rowHasInlineParts(row: { metadata?: unknown }): boolean {
  const meta = (row.metadata ?? {}) as { parts?: unknown };
  return Array.isArray(meta.parts) && meta.parts.length > 0;
}

/**
 * Concatenate persisted per-step parts (in `stepIndex` order) into the turn's UI
 * parts (#492). Reproduces EXACTLY what flushAssistant → assistantParts would have
 * written to `metadata.parts` for those finished steps, since each step row stored
 * `assistantParts([step])` at persist time.
 */
export function assembleStepParts(
  stepRows: ReadonlyArray<{ stepIndex: number; parts: unknown }>,
): UIMessage['parts'] {
  const parts: Array<Record<string, unknown>> = [];
  for (const step of [...stepRows].sort((a, b) => a.stepIndex - b.stepIndex)) {
    if (Array.isArray(step.parts)) {
      parts.push(...(step.parts as Array<Record<string, unknown>>));
    }
  }
  return parts as UIMessage['parts'];
}

/**
 * reconstructRunParts (#492) — the single backend-switch seam. Given an assistant
 * ROW and its persisted step rows, return the turn's UI `parts` + the persisted
 * step count, reading from the ROW when it already carries inline parts (old-era
 * records AND every finished record) and from the STEPS TABLE otherwise (a #492
 * mid-run record). The higher-level consumers (attach seed, delta poll, export)
 * route their row→parts through this / {@link hydrateAssistantParts}, so old and
 * new records reconstruct identically WITHOUT the consumers branching on the era.
 */
export function reconstructRunParts(
  row: { metadata?: unknown; content?: string | null },
  stepRows: ReadonlyArray<{ stepIndex: number; parts: unknown }>,
): { parts: UIMessage['parts']; stepsPersisted: number } {
  if (rowHasInlineParts(row)) {
    const meta = row.metadata as {
      parts: UIMessage['parts'];
      stepsPersisted?: number;
    };
    return {
      parts: meta.parts,
      stepsPersisted:
        typeof meta.stepsPersisted === 'number'
          ? meta.stepsPersisted
          : stepRows.length,
    };
  }
  if (stepRows.length > 0) {
    return {
      parts: assembleStepParts(stepRows),
      stepsPersisted: stepRows.length,
    };
  }
  // No inline parts and no step rows: an old-era seed / empty streaming row. Fall
  // back to a single text part from `content` (mirrors rowToUiMessage).
  return {
    parts: textPart(row.content ?? '') as UIMessage['parts'],
    stepsPersisted: 0,
  };
}

/**
 * Fill each assistant row's `metadata.parts` from its step rows when the row does
 * not already carry them inline (a #492 mid-run record), so a consumer that reads
 * `metadata.parts` off the RAW row (the client seed/poll, the Markdown export)
 * sees the reconstructed parts with NO change to itself. Rows that already have
 * inline parts (old-era + finished) and non-assistant rows pass through untouched.
 * Pure: returns new row objects, never mutates the inputs.
 */
export function hydrateAssistantParts<
  T extends { id: string; role?: string; metadata?: unknown },
>(
  rows: ReadonlyArray<T>,
  stepsByMessage: Map<
    string,
    ReadonlyArray<{ stepIndex: number; parts: unknown }>
  >,
): T[] {
  return rows.map((row) => {
    if (row.role !== 'assistant' || rowHasInlineParts(row)) return row;
    const steps = stepsByMessage.get(row.id);
    if (!steps || steps.length === 0) return row;
    return {
      ...row,
      metadata: {
        ...((row.metadata ?? {}) as Record<string, unknown>),
        parts: assembleStepParts(steps),
      },
    };
  });
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
  // #487: the OWNER terminal write is CONDITIONAL (status='streaming' OR
  // metadata.finalizeFailed) so the owner overwrites a reconcile stamp but never
  // an already-proper terminal row (owner-write priority).
  finalizeOwner(
    id: string,
    workspaceId: string,
    patch: AssistantFlush,
  ): Promise<unknown>;
}

/**
 * Apply a finalize `plan` to the repo with the terminal `flushed` payload (#183):
 * conditionally UPDATE the upfront row (owner-write priority, #487), or INSERT a
 * fresh terminal row as the fallback when the upfront insert failed. The SINGLE
 * dispatch shared by the service's finalizeAssistant and its test, so the test
 * exercises the real path instead of a copy (#186 review). Pure of error
 * handling — the caller wraps it (and RETRIES it, #487).
 */
export async function applyFinalize(
  repo: FinalizeRepo,
  plan: { kind: 'update'; id: string } | { kind: 'insert' },
  base: { chatId: string; workspaceId: string; userId: string },
  flushed: AssistantFlush,
): Promise<void> {
  if (plan.kind === 'update') {
    await repo.finalizeOwner(plan.id, base.workspaceId, flushed);
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
 * Deep-strip NUL characters (`\u0000`) from every string in a value, returning
 * the SAME reference when nothing changed (so the no-NUL common case allocates
 * nothing). Postgres rejects a NUL in BOTH `text` and `jsonb` columns ("invalid
 * input syntax for type json" / "unsupported Unicode escape sequence"), so a
 * stray NUL in model output or a tool result — e.g. a truncated multibyte read
 * of a web page — otherwise fails EVERY persist of the assistant row, silently
 * dropping that turn's content from the DB while the live stream still shows it.
 * Applied at the flushAssistant choke point so content + toolCalls + metadata are
 * all covered. Exported for the unit test.
 */
export function stripNulChars<T>(value: T): T {
  if (typeof value === 'string') {
    return (value.includes('\u0000')
      ? value.replace(/\u0000/g, '')
      : value) as T;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const s = stripNulChars(v);
      if (s !== v) changed = true;
      return s;
    });
    return (changed ? out : value) as T;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const s = stripNulChars(v);
      if (s !== v) changed = true;
      out[k] = s;
    }
    return (changed ? out : value) as T;
  }
  return value;
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
    pageChanged?: { title: string; diff: string } | null;
    // Per-turn step->parts memo (#490): pass the SAME cache on every flush of a
    // turn so each finished step's output is stringified once, not once per flush.
    partsCache?: StepPartsCache;
    // #490 observability: when the replay budgeter trimmed this turn's history,
    // the (estimated) token size it trimmed to — the UI can show "replay truncated
    // at N tokens". Omitted when nothing was trimmed.
    replayTrimmedToTokens?: number;
    // #490/#520 reactive branch: the consecutive context-overflow count for THIS
    // turn (prior streak + 1) when the provider rejected it for context overflow.
    // Stamped into metadata so the NEXT turn's budgeter trims with escalating
    // aggression (0.5**k). Omitted (undefined) on a clean turn, which resets k to 0.
    replayOverflowCount?: number;
    // #520 Option B observability: true when recovery replayed this turn's history
    // BELOW the admin-configured budget (the configured window did not fit and the
    // anti-brick invariant cut past it). Omitted on a normal in-budget replay so the
    // flag marks ONLY the "config is factually too large" case.
    replayBelowConfiguredBudget?: boolean;
    // #686 P4: the external-MCP connection failures for this turn (capped by
    // buildMcpFailures). Persisted so history / the UI can show which external
    // tools were unavailable. Omitted when there were none.
    mcpFailures?: ReadonlyArray<McpFailureRecord>;
  },
): AssistantFlush {
  const finished = capturedSteps ?? [];
  const stepsText = finished.map((s) => s.text ?? '').join('');
  const trailing = inProgressText ?? '';
  // assistantParts emits text parts only for FINISHED steps; append the
  // in-progress step's text (the partial answer cut off by an error/abort, or
  // simply not yet flushed mid-stream) as the last text part so the persisted
  // parts match what streamed to the client.
  const parts = assistantParts(
    finished,
    '',
    extra?.partsCache,
  ) as unknown as Array<Record<string, unknown>>;
  if (trailing) parts.push({ type: 'text', text: trailing });

  const metadata: Record<string, unknown> = {
    parts: parts as unknown as UIMessage['parts'],
    // Era marker for the `tool_calls` trace shape (#490): v2 stores outcome flags
    // ({ ok } / { error, kind }) and NO tool output (the output lives once in
    // `parts`). Old rows have no marker and the legacy { output } shape; a
    // dual-shape query branches on this. Old rows are deliberately NOT migrated.
    toolTraceVersion: 2,
    // #491 STEP MARKER: the number of FINISHED steps whose parts are in THIS row,
    // written by the SAME flush that builds `parts` (atomically — they are both
    // derived from `finished`, so the marker can NEVER disagree with the persisted
    // parts). This is the step-alignment anchor the resume stack builds on:
    // - the registry rotates its retention ring only on a CONFIRMED persist of
    //   step N (commit 3);
    // - attach slices the tail at "step > N" from the client's persisted seed.
    // It is NOT `run.stepCount`: recordStep is fire-and-forget and NOT atomic with
    // the parts write, so stepCount could race ahead of the persisted parts
    // (seed↔marker drift). The in-progress trailing text (an error/abort partial,
    // or a mid-stream flush) is NOT a finished step and is excluded from the count.
    stepsPersisted: finished.length,
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
  if (extra?.replayTrimmedToTokens)
    metadata.replayTrimmedToTokens = extra.replayTrimmedToTokens;
  if (extra?.replayOverflowCount && extra.replayOverflowCount > 0)
    metadata.replayOverflowCount = extra.replayOverflowCount;
  if (extra?.replayBelowConfiguredBudget)
    metadata.replayBelowConfiguredBudget = true;
  // #686 P4: persist the (already-capped) external-MCP failure list. Only when
  // non-empty so a clean turn's metadata is unchanged.
  if (extra?.mcpFailures && extra.mcpFailures.length > 0)
    metadata.mcpFailures = [...extra.mcpFailures];
  if (extra?.error) metadata.error = extra.error;
  // Persist the page-change diff the agent saw this turn (#274 observability),
  // so history / the Markdown export can show what the user changed. Only when
  // a non-empty diff was actually injected into the prompt this turn.
  if (extra?.pageChanged && extra.pageChanged.diff?.trim().length) {
    metadata.pageChanged = {
      title: extra.pageChanged.title,
      diff: extra.pageChanged.diff,
    };
  }

  // Strip NUL chars from the whole row before persisting: Postgres rejects a NUL
  // in both the `content` (text) and `toolCalls`/`metadata` (jsonb) columns, and a
  // single stray NUL in model/tool output would otherwise fail EVERY write of this
  // row and silently drop the turn's content from the DB (see stripNulChars).
  return stripNulChars({
    content: stepsText + trailing,
    toolCalls: serializeSteps(finished),
    metadata,
    status,
  });
}

/**
 * Reduce SDK step objects to a compact, JSON-serializable trace for the
 * `tool_calls` column — trace format **v2** (#490).
 *
 * v2 stores, per call, ONLY the metadata a queryable trace needs — never the
 * tool OUTPUT. Before #490 each output was persisted TWICE: once here (compacted)
 * and once in `metadata.parts` (via `assistantParts`), so a 50-step run with
 * 50–200 KB outputs wrote hundreds of MB per turn (each `onStepFinish` rewrote
 * the whole row). The parts copy is the one the model replays and the UI/Markdown
 * export render, so the trace copy of the output was pure duplication. v2 keeps
 * the output ONLY in parts and reduces the trace to outcome flags.
 *
 * Element shapes (paired per call, in order):
 *  - `{ toolName, input }`                       — the call
 *  - `{ toolName, ok: true }`                     — it returned a result (success)
 *  - `{ toolName, error, kind: 'thrown' }`        — it threw a `tool-error`
 *  - `{ toolName, error, kind: 'interrupted' }`   — no result and no throw (an
 *      abort / server restart mid-step). `kind` is MANDATORY: without it a
 *      synthetic "Tool call did not complete." is indistinguishable from a real
 *      hard-fail and pollutes any error-rate scan. The distinction is STRUCTURAL
 *      (an `errorsById` hit vs the synthetic fallback branch), NOT a per-tool
 *      classifier — soft failures stay OUT of the trace (they live in
 *      `metadata.parts` outputs; a per-tool mirror would persist its own bugs).
 *
 * Rows carry `metadata.toolTraceVersion: 2` (set by {@link flushAssistant}) so a
 * dual-shape query can branch on the era. Old rows are NOT migrated (rewriting
 * giant jsonb is the very WAL churn this removes); see docs/reading-ai-logs.md.
 */
export function serializeSteps(
  steps: ReadonlyArray<{
    toolCalls?: ReadonlyArray<{
      toolCallId?: string;
      toolName?: string;
      input?: unknown;
    }>;
    toolResults?: ReadonlyArray<{ toolCallId?: string; toolName?: string }>;
    content?: ReadonlyArray<{
      type?: string;
      toolCallId?: string;
      toolName?: string;
      error?: unknown;
    }>;
  }>,
): unknown {
  const calls: Array<
    | { toolName?: string; input?: unknown }
    | { toolName?: string; ok: true }
    | { toolName?: string; error: string; kind: 'thrown' | 'interrupted' }
  > = [];
  for (const step of steps ?? []) {
    // Index this step's results + thrown errors by tool call id, so each call is
    // paired with its outcome (mirrors assistantParts' pairing exactly).
    const resultIds = new Set<string>();
    for (const r of step.toolResults ?? []) {
      if (r.toolCallId) resultIds.add(r.toolCallId);
    }
    const errorsById = new Map<string, unknown>();
    for (const part of step.content ?? []) {
      if (part.type === 'tool-error' && part.toolCallId) {
        errorsById.set(part.toolCallId, part.error);
      }
    }
    for (const call of step.toolCalls ?? []) {
      calls.push({ toolName: call.toolName, input: call.input });
      if (call.toolCallId && resultIds.has(call.toolCallId)) {
        // Success: the output itself lives in metadata.parts, not here.
        calls.push({ toolName: call.toolName, ok: true });
      } else if (call.toolCallId && errorsById.has(call.toolCallId)) {
        // Hard fail: the tool threw. Persist the real (bounded) reason.
        calls.push({
          toolName: call.toolName,
          error: normalizeToolError(errorsById.get(call.toolCallId)),
          kind: 'thrown',
        });
      } else {
        // Neither a result nor a throw: interrupted mid-step (abort/restart).
        // Marked structurally so it never inflates a thrown-error count.
        calls.push({
          toolName: call.toolName,
          error: TOOL_CALL_INCOMPLETE_TEXT,
          kind: 'interrupted',
        });
      }
    }
  }
  return calls.length > 0 ? calls : null;
}
