import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { generateId } from "ai";
import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Group,
  Loader,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import {
  IconClockHour4,
  IconPlayerPlayFilled,
  IconX,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useChat, type UIMessage } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import MessageList from "@/features/ai-chat/components/message-list.tsx";
import ChatInput from "@/features/ai-chat/components/chat-input.tsx";
import RoleCards from "@/features/ai-chat/components/role-cards.tsx";
import ChatErrorAlert from "@/features/ai-chat/components/chat-error-alert.tsx";
import ChatStoppedNotice from "@/features/ai-chat/components/chat-stopped-notice.tsx";
import {
  IAiChatMessageRow,
  IAiRole,
} from "@/features/ai-chat/types/ai-chat.types.ts";
import {
  roleLaunchMessage,
  shouldResetRolePicked,
} from "@/features/ai-chat/utils/role-launch.ts";
import { describeChatError } from "@/features/ai-chat/utils/error-message.ts";
import {
  extractServerChatId,
  extractRunId,
} from "@/features/ai-chat/utils/adopt-chat-id.ts";
import { assistantMessageHasVisibleContent } from "@/features/ai-chat/utils/message-content.ts";
import {
  isStreamingTail,
  isSettledAssistantTail,
  stepsPersistedOf,
  mergeById,
} from "@/features/ai-chat/utils/resume-helpers.ts";
import { getRun } from "@/features/ai-chat/services/ai-chat-service.ts";
import { AI_CHAT_MESSAGES_RQ_KEY } from "@/features/ai-chat/queries/ai-chat-query.ts";
import type { EditorSelectionContext } from "@/features/editor/utils/get-editor-selection.ts";
import {
  dequeue,
  enqueueMessage,
  promoteToHead,
  removeQueuedById,
  type QueuedMessage,
} from "@/features/ai-chat/utils/queue-helpers.ts";
import {
  reduce,
  initialMachine,
  RECONNECT_MAX_ATTEMPTS,
  type Machine,
  type Event as RunEvent,
  type Effect as RunEffect,
} from "@/features/ai-chat/state/run-fsm.ts";
import classes from "@/features/ai-chat/components/ai-chat.module.css";

// Throttle how often the streamed `messages` state triggers a re-render. Without
// it, useChat updates state on EVERY token, so the whole transcript's markdown
// (marked + DOMPurify) is re-parsed per token — on a long agent run that grows
// into a quadratic CPU storm that pins the main thread and freezes the UI.
// ~50ms (20 Hz) keeps streaming visually smooth while decoupling re-render cost
// from the token rate.
const STREAM_THROTTLE_MS = 50;

// #488 commit 4a: how long the degraded poll may run with NO new run activity
// (its persisted rows unchanged) before the FSM declares the run STALLED and
// surfaces a banner + Retry — instead of the old silent `refetchInterval -> false`
// ("forever half-done answer"). Measured from INACTIVITY, so a long-but-progressing
// run keeps polling; only a genuinely stuck run trips it. This cap lives in the
// THREAD now (the FSM owns polling->stalled); the window just polls while armed.
const DEGRADED_POLL_IDLE_MAX_MS = 10 * 60_000;

// #541: the bound on the persist re-seed (getRun) wait when ENTERING the reconnect
// ladder after a live SSE drop. The axios client (lib/api-client.ts) sets NO request
// timeout, and the stalled-idle cap only arms AFTER the FSM enters reconnecting/
// polling — which never happens if getRun HANGS (connection established, no response).
// Without this bound a live drop + a hung getRun sticks the FSM in `streaming` with
// no banner and no poll until the browser socket timeout (minutes) — the silent-freeze
// class #497 eliminates. This is a deliberate RECOVERY-START bound (drop the live
// partial + enter the ladder so the poll/idle-cap arms), intentionally much shorter
// than any network socket timeout — not a network read timeout.
const RECONNECT_RESEED_TIMEOUT_MS = 4_000;

// #665: how long the FIRST send of a fresh thread waits for an in-flight "New
// chat" unbind (DELETE /bind-page) before sending anyway. It closes the "New
// chat -> instant role-card click" race (the DELETE and the birth UPSERT are two
// independent requests) by sequencing the send after the DELETE. Ample for a
// round-trip to our own backend (hundreds of ms) yet below the threshold where a
// send delay is noticeable; on timeout we send regardless (falling back to the
// original, harmless race). No env override: exceeding it only reverts to that
// benign race, so a knob would save nothing.
const AI_CHAT_UNBIND_GATE_TIMEOUT_MS = 1500;

/** The #487 active (non-terminal) run statuses — mirrors the server's
 *  ACTIVE_RUN_STATUSES. A run-fact is "active" only for these. */
function isActiveRunStatus(status: string | null | undefined): boolean {
  return status === "pending" || status === "running";
}

/** Read the `{ code, activeRunId }` off a JSON error response WITHOUT consuming
 *  the original body (reads a clone), so the caller can still return the Response
 *  untouched to the SDK. `activeRunId` is the server's field for the run currently
 *  active on the chat — it is the name emitted on BOTH 409 branches
 *  (SUPERSEDE_TARGET_MISMATCH and A_RUN_ALREADY_ACTIVE, see ai-chat.controller.ts).
 *  Reading `runId` here (the field the server never sends) silently yields
 *  `undefined`. Any parse failure => empty. */
async function read409(response: Response): Promise<{ code?: string; activeRunId?: string }> {
  try {
    const b = (await response.clone().json()) as { code?: unknown; activeRunId?: unknown };
    return {
      code: typeof b?.code === "string" ? b.code : undefined,
      activeRunId: typeof b?.activeRunId === "string" ? b.activeRunId : undefined,
    };
  } catch {
    return {};
  }
}

/** The page the user is currently viewing, sent as chat context. */
export interface OpenPageContext {
  id: string;
  title: string;
}

interface ChatThreadProps {
  /** The open chat id, or null for a brand-new (not-yet-created) chat. */
  chatId: string | null;
  /** This thread's mount key (the same value the parent uses as React `key`).
   *  Forwarded to onTurnFinished so the session can tell a turn finishing on the
   *  CURRENT thread from one ABANDONED by New chat mid-stream — whose onFinish/
   *  onError still fire after unmount and must not adopt the abandoned chat (#161). */
  threadKey?: string;
  /** Persisted rows to seed initial messages (existing chats only). */
  initialRows?: IAiChatMessageRow[];
  /** The page currently open in the workspace, or null on a non-page route.
   *  Sent with each turn so the agent knows what "this page" refers to. */
  openPage?: OpenPageContext | null;
  /** #388: snapshot the user's current editor selection at SEND time. Invoked
   *  inside prepareSendMessagesRequest and nested into openPage on the wire, so a
   *  fresh snapshot ships each turn. Null/absent => nothing selected. */
  getEditorSelection?: () => EditorSelectionContext | null;
  /** The agent role selected for a NEW chat (null = universal assistant). Sent
   *  in the request body so the server persists it on chat creation; ignored by
   *  the server for existing chats (the role is read from the chat row). */
  roleId?: string | null;
  /** Enabled roles for the new-chat empty state (only meaningful when
   *  `chatId === null`). Rendered as the colored role cards. */
  roles?: IAiRole[];
  /** Notify the parent which role was picked via a card, so it can update the
   *  header badge / assistant name for the brand-new chat. */
  onRolePicked?: (role: IAiRole) => void;
  /** Display name for the assistant label / typing line (the role name);
   *  forwarded to MessageList. Absent => the generic "AI agent". */
  assistantName?: string;
  /** Called when a turn finishes; the parent refreshes the chat list and, for a
   *  new chat, adopts the freshly created chat id. `serverChatId` is the
   *  authoritative id the server streamed on the assistant message metadata, or
   *  undefined on a failed turn — see adopt-chat-id.ts for the full #137 design.
   *  `finishingThreadKey` (this thread's mount key) lets the session ignore a turn
   *  finishing on a thread already abandoned by New chat mid-stream (#161). */
  onTurnFinished: (serverChatId?: string, finishingThreadKey?: string) => void;
  /** Called EARLY (at the stream's `start` chunk) with the authoritative server
   *  chat id streamed on the assistant message metadata, so a brand-new chat
   *  adopts its real id WHILE the first turn is still streaming (#174 — makes the
   *  Copy/export button available mid-stream). Distinct from onTurnFinished,
   *  which fires only at the terminal outcome. */
  onServerChatId?: (serverChatId?: string) => void;
  /** #184 phase 1.5: arm/disarm the parent's degraded-poll fallback for THIS
   *  chat's window. Called `true` when the FSM enters a poll-bearing recovery
   *  (attach 204 / starved-or-torn resumed finish / a stop), `false` the moment a
   *  local stream starts or the run settles. The window owns only the dumb 2.5s
   *  timer; the THREAD's FSM owns arm/disarm + the stalled cap (#488). */
  onResumeFallback?: (active: boolean) => void;
  /** #555 S3: the authoritative run fact carried by the degraded delta poll
   *  (`POST /ai-chat/messages/delta` → `run: { id, status } | null`), surfaced by
   *  the window's `useAiChatDeltaPoll`. The FSM consumes it: a fresh NEGATIVE fact
   *  (no active run) quenches a stale `reconnecting`/`polling`/`attaching`/`stopping`
   *  immediately (I3 fresh-negative gate), instead of waiting for the terminal ROW
   *  or the reconnect ladder to exhaust. `undefined` = no poll result yet (ignored).
   *  Only meaningful while the poll is armed (a poll-bearing recovery). */
  polledRunFact?: { id: string; status: string } | null;
  /** #184: whether detached/autonomous agent runs are enabled for this workspace.
   *  When true the Stop button must additionally hit the AUTHORITATIVE server stop
   *  (via onServerStop) — aborting only the local SSE is just a client disconnect,
   *  which the server deliberately ignores, so the detached run would keep going. */
  autonomousRunsEnabled?: boolean;
  /** #184: request the server-side stop of this chat's active run. Called with the
   *  resolved chat id when the user presses Stop in autonomous mode. */
  onServerStop?: (chatId: string) => void;
  /** #665: a WINDOW-owned ref holding the last "New chat" unbind (DELETE
   *  /bind-page) promise. The first send of a fresh thread reads-and-clears it and
   *  waits (bounded) so an instant role-card click can't race its DELETE past the
   *  server's birth UPSERT. The ref must live in the window (not here): "New chat"
   *  remounts this component, which would lose a ref held inside it. */
  pendingUnbindRef?: React.MutableRefObject<Promise<unknown> | null>;
}

/**
 * Map a persisted server row to an AI SDK UIMessage. Mirrors the server's
 * `rowToUiMessage`: `metadata.parts` are the UIMessage parts; otherwise fall
 * back to a single text part built from the plain-text `content`.
 */
function rowToUiMessage(row: IAiChatMessageRow): UIMessage {
  const role = row.role === "assistant" ? "assistant" : "user";
  const parts =
    Array.isArray(row.metadata?.parts) && row.metadata.parts.length > 0
      ? row.metadata.parts
      : ([{ type: "text", text: row.content ?? "" }] as UIMessage["parts"]);
  const error = row.metadata?.error;
  const finishReason = row.metadata?.finishReason;
  const metadata: Record<string, unknown> = {};
  if (error) metadata.error = error;
  if (finishReason) metadata.finishReason = finishReason;
  return {
    id: row.id,
    role,
    parts,
    // Carry persisted turn outcome (error text and/or finishReason) so MessageItem
    // can render the error banner / "stopped" marker after a remount and in
    // reopened history.
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  } as UIMessage;
}

/**
 * Owns the AI SDK `useChat` lifecycle for ONE chat. The parent remounts this
 * with a `key` when the selected chat changes, so initial messages re-seed
 * cleanly (the v6 transport-based hook keeps its state per mount).
 *
 * #488: the resume/reconnect/poll/stop/supersede lifecycle is driven by the pure
 * FSM in `state/run-fsm.ts` (see `run-fsm.spec.md`). The component is the RUNTIME:
 * it dispatches typed events (from SDK callbacks / HTTP outcomes) and executes the
 * reducer's command EFFECTS (attach GET, POST /run, POST /stop, POST /stream
 * supersede, backoff timers, poll arm/disarm). The FSM lives in this thread (not
 * the window) so a late SDK callback dies with the owner (#161). The one-shot-ref
 * zoo is gone: the epoch counter (I1) drops stale-generation outcomes.
 */
export default function ChatThread({
  chatId,
  threadKey,
  initialRows,
  openPage,
  getEditorSelection,
  roleId,
  roles,
  onRolePicked,
  assistantName,
  onTurnFinished,
  onServerChatId,
  onResumeFallback,
  polledRunFact,
  autonomousRunsEnabled,
  onServerStop,
  pendingUnbindRef,
}: ChatThreadProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  // --- The run-lifecycle FSM (source of truth) -----------------------------
  // Stored in state (drives UI re-render on phase/ctx change) + mirrored in a ref
  // for the transport/timer closures (useMemo([])-stable) that read it live.
  const [machine, setMachine] = useState<Machine>(() => initialMachine());
  const machineRef = useRef<Machine>(machine);
  // I1: the current generation. Command-transitions bump it; async OUTCOME events
  // carry the epoch they were issued under; a mismatch is dropped by the reducer.
  const epochRef = useRef(0);
  // The generation an in-flight attach GET was issued under (for stamping its
  // 2xx/204/throw outcome). Replaces the one-shot `noStreamHandledRef` guard.
  const pendingAttachEpochRef = useRef(0);
  // Stable dispatch handle for closures defined before `dispatch` (transport,
  // timers) — assigned once `dispatch` exists below.
  const dispatchRef = useRef<(e: RunEvent) => void>(() => undefined);

  // --- Effect-dependency refs (live values for the stable effect runner) -----
  // These are useChat/prop values that change identity across renders; the effect
  // runner (useCallback([])) reads them live so it never captures a stale closure.
  const resumeStreamRef = useRef<(() => Promise<void> | void) | null>(null);
  const setMessagesRef = useRef<
    ((updater: (prev: UIMessage[]) => UIMessage[]) => void) | null
  >(null);
  const sendMessageRef = useRef<((m: { text: string }) => void) | null>(null);
  const stopFnRef = useRef<(() => void) | null>(null);
  const onResumeFallbackRef = useRef<typeof onResumeFallback>(onResumeFallback);
  onResumeFallbackRef.current = onResumeFallback;
  const onServerStopRef = useRef<typeof onServerStop>(onServerStop);
  onServerStopRef.current = onServerStop;
  // #665: mirror the WINDOW-owned unbind ref into a STABLE local ref so the
  // useCallback([]) localSend can read the current unbind promise without
  // capturing a per-render prop. `.current` is the window's ref object (stable
  // identity), whose `.current` is the promise.
  const pendingUnbindRefRef =
    useRef<typeof pendingUnbindRef>(pendingUnbindRef);
  pendingUnbindRefRef.current = pendingUnbindRef;

  // Live mount flag: the attach GET / a resumed onFinish are async and can land
  // AFTER unmount (the parent remounts per chat). The epoch (I1) drops stale FSM
  // OUTCOMES, but the imperative onFinish side-effects (parent flush, invalidate)
  // still need a plain React-liveness bit — orthogonal to the run-lifecycle, so it
  // is NOT one of the lifecycle flags the FSM replaced.
  const mountedRef = useRef(true);

  // attachStrategy DATA (behind the resumeStream effect; #491 tail-only, WITHOUT
  // touching the FSM). The controller is effect-owned (aborted in cleanup, I5).
  // `anchorRef` is the PERSISTED assistant row that pins the run (server invariant
  // 6) and its persisted step frontier N: it feeds `?anchor=<id>&n=<stepsPersisted>`
  // so the tail-only attach returns frames for steps >= N (the seed carries 0..N-1).
  // It is NOT a "stripped" row — the seed keeps every row (tail-only replaces the
  // old full-replay+strip). Null when there is no streaming/active tail to resume.
  const attachAbortRef = useRef<AbortController | null>(null);
  const anchorRef = useRef<{ id: string; stepsPersisted: number } | null>(
    (() => {
      if (chatId === null || !isStreamingTail(initialRows ?? [])) return null;
      const rows = initialRows ?? [];
      const tail = rows[rows.length - 1];
      return { id: tail.id, stepsPersisted: stepsPersistedOf(tail) };
    })(),
  );
  // Effect-owned backoff timers (not lifecycle flags): the reconnect ladder and the
  // stalled inactivity cap. Cleared by the cancelReconnect effect / the cap effect.
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleCapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // #541: the persist re-seed (getRun) timeout race on the disconnect->reconnect
  // entry. Held in a ref so unmount (DISPOSE cleanup) clears it — no dangling timer.
  const reseedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // #491 tail-only: seed EVERY persisted row unchanged (no strip). The streaming
  // tail holds steps 0..N-1; the run-stream registry's tail (steps >= N) is APPENDED
  // to it by the SDK continuation (readUIMessageStream({ message })), so it must be
  // present in the store for the attach to continue the RIGHT message.
  const initialMessages = useMemo<UIMessage[]>(
    () => (initialRows ?? []).map(rowToUiMessage),
    [initialRows],
  );

  // Identity/data mirrors (NOT lifecycle flags — they stay as data).
  const chatIdRef = useRef<string | null>(chatId);
  chatIdRef.current = chatId;
  const openPageRef = useRef<OpenPageContext | null>(openPage ?? null);
  openPageRef.current = openPage ?? null;
  const getEditorSelectionRef = useRef<
    (() => EditorSelectionContext | null) | undefined
  >(getEditorSelection);
  getEditorSelectionRef.current = getEditorSelection;
  const roleIdRef = useRef<string | null>(roleId ?? null);
  roleIdRef.current = roleId ?? null;
  // Stable useChat store key for this mount (see the long #137/#174 note that used
  // to live here — recreating the store mid-stream wipes the live turn).
  const stableIdRef = useRef<string>(chatId ?? `new-${generateId()}`);
  const chatStoreId = stableIdRef.current;

  // Pending messages composed while a turn streams; flushed FIFO on a clean finish.
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  const queuedRef = useRef<QueuedMessage[]>([]);
  const setQueue = useCallback((next: QueuedMessage[]) => {
    queuedRef.current = next;
    setQueued(next);
  }, []);

  // #488 commit 5: the runId to inject into the NEXT POST as `supersede:{runId}`
  // (read-and-cleared by prepareSendMessagesRequest). This is send-plumbing DATA
  // (like chatIdRef/roleIdRef), the single replacement for the three REMOVED
  // one-shot flags flushOnAbortRef/interruptNextSendRef/supersedeRetryRef.
  const pendingSupersedeRef = useRef<string | null>(null);
  // #488 F1: the interrupt-and-send text, held until the superseded stream A has
  // FULLY finalized (its SDK `finally` cleared `activeResponse`) — only THEN is
  // stream B started, so A cannot corrupt B (ai@6 AbstractChat.makeRequest reads
  // `this.activeResponse.state.message` in its finally and then nulls it, so an
  // overlapping B is clobbered). Send-plumbing DATA, not a lifecycle flag.
  const pendingSupersedeTextRef = useRef<string | null>(null);
  // #488 F1: the epoch under which the CURRENTLY-OWNED stream started, used to
  // STAMP its onFinish (I1). A superseded/dead stream's late finish carries an OLD
  // generation and is dropped by the reducer, so it cannot drive the live machine
  // into a false reconnect or reset its run-fact. Set at each honored stream start
  // (local send, resume/reconnect attach, the supersede B-send).
  // LOAD-BEARING (I1): this stamp is what ENFORCES the "two owned streams never
  // overlap" invariant — the superseded stream A's late onFinish is stamped with
  // A's now-stale generation and dropped, so only the live stream B drives the
  // machine. Do NOT remove it, and do NOT move any stream-start assignment of it
  // to AFTER that stream's onFinish can fire, or a late/overlapping finish leaks
  // past the epoch filter.
  const turnEpochRef = useRef(0);
  // #555 F1: a ONE-SHOT set by the transport `fetch` path when the server returns a
  // gate/CAS 409 whose FSM event ADOPTS (or preserves) a run-fact on the `error`
  // phase — A_RUN_ALREADY_ACTIVE (-> RUN_ALREADY_ACTIVE, adopts activeRunId) and the
  // supersede-* 409s SUPERSEDE_TARGET_MISMATCH / SUPERSEDE_TIMEOUT / SUPERSEDE_INVALID
  // (all leave runFact set — see the run-fsm reducer and the S4 sendNow branch). The
  // SAME failed turn's stream then fires `onFinish({isError:true})`, whose default
  // FINISH_ERROR would CLOBBER that adopted run-fact to null — killing the S4 "Send
  // now" CAS-supersede (the guard `runId && runId!=="pending"` would go false). The
  // FSM has ALREADY absorbed this turn's outcome via the 409 -> `error(kind)`
  // transition, so the stream's own error finish is REDUNDANT: onFinish reads-and-
  // clears this ref at the top and SKIPS FINISH_ERROR when it is set. MIRRORS the
  // superseding-pending special case (pendingSupersedeTextRef) that likewise special-
  // cases onFinish. Scoped STRICTLY to those 409s: a NORMAL stream error (one that did
  // NOT adopt a run-fact via a gate/CAS 409) leaves this false and still dispatches
  // FINISH_ERROR (clearing runFact). Send-plumbing DATA, not a lifecycle flag.
  const runFactAdopted409Ref = useRef(false);

  // --- Effect runner: executes the reducer's command effects ---------------
  const runEffect = useCallback(
    (eff: RunEffect, epoch: number) => {
      switch (eff.type) {
        case "resumeStream": {
          // The attach GET. Stamp the outcome's generation (I1). #491 tail-only: the
          // store already holds EXACTLY the persisted steps 0..N-1 (the mount seed IS
          // persist; a reconnect was re-seeded from persist BEFORE FINISH_DISCONNECT
          // scheduled it — see the onFinish disconnect handler), so there is nothing
          // to filter here: the SDK continues that seeded message, appending the tail
          // (steps >= N) without duplicating the pre-drop partial step.
          pendingAttachEpochRef.current = epoch;
          // The resumed stream's onFinish is stamped with THIS attach generation
          // (F1), so a superseded attempt's late finish is dropped.
          turnEpochRef.current = epoch;
          void resumeStreamRef.current?.();
          break;
        }
        case "scheduleReconnect": {
          if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
          const attempt = eff.attempt;
          const scheduledEpoch = epoch;
          reconnectTimerRef.current = setTimeout(() => {
            dispatchRef.current({
              type: "RECONNECT_ATTEMPT",
              attempt,
              epoch: scheduledEpoch,
            });
          }, eff.delayMs);
          break;
        }
        case "cancelReconnect":
          if (reconnectTimerRef.current) {
            clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = null;
          }
          break;
        case "armPoll":
          onResumeFallbackRef.current?.(true);
          break;
        case "disarmPoll":
          onResumeFallbackRef.current?.(false);
          break;
        case "abortAttach":
          attachAbortRef.current?.abort();
          break;
        case "stopRun":
          // Authoritative stop. When the chat id is not known yet (brand-new chat's
          // first moment), it is deferred: the chat-id adoption effect fires
          // onServerStop the moment the id lands while still in `stopping`.
          if (chatIdRef.current)
            onServerStopRef.current?.(chatIdRef.current);
          break;
        case "postRun": {
          // (Re)establish / verify the run-fact from POST /ai-chat/run. Stamp the
          // RUN_FACT outcome with the issuing generation so a superseded verify is
          // dropped (I1).
          const cid = chatIdRef.current;
          if (!cid) break;
          const ep = epoch;
          void getRun(cid)
            .then((res) => {
              const active =
                res.run && isActiveRunStatus(res.run.status)
                  ? { runId: res.run.id }
                  : null;
              dispatchRef.current({ type: "RUN_FACT", runFact: active, epoch: ep });
            })
            .catch(() => undefined);
          break;
        }
        case "supersede":
          // Arm the next POST to carry `supersede:{runId}`; the send itself is
          // triggered by the caller (sendNow) via sendMessage.
          pendingSupersedeRef.current = eff.targetRunId;
          break;
      }
    },
    // Reads only refs + the stable queryClient — safe as an empty-dep callback.
    [],
  );

  // Dispatch: reduce, run effects, re-render on a real state change.
  const dispatch = useCallback(
    (event: RunEvent) => {
      const prev = machineRef.current;
      const next = reduce(prev, event);
      machineRef.current = next;
      epochRef.current = next.ctx.epoch;
      if (next.phase !== prev.phase || next.ctx !== prev.ctx) setMachine(next);
      for (const eff of next.effects) runEffect(eff, next.ctx.epoch);
    },
    [runEffect],
  );
  dispatchRef.current = dispatch;

  // FIFO dequeue + local send of the next queued message (no-op when empty).
  // #665: async because the FIRST send of a fresh thread must sequence AFTER a
  // pending "New chat" unbind (DELETE /bind-page), so a poll/starvation timer can't
  // arm against a phantom turn. Ordering matters: await the gate BEFORE dispatch,
  // so the FSM never sits in `sending` with no request in flight.
  const localSend = useCallback(async (text: string) => {
    // Read-and-CLEAR the window's last unbind promise. Read-and-clear so localSend
    // does not stay async-waiting on a long-settled promise on every later send.
    const unbindRef = pendingUnbindRefRef.current;
    const pendingUnbind = unbindRef?.current ?? null;
    if (unbindRef) unbindRef.current = null;
    if (pendingUnbind) {
      // Wait for the DELETE, but no longer than the gate timeout (a wedged DELETE
      // must not block the send indefinitely — fall back to the benign race). Never
      // let a rejected/500 unbind throw here: that would eat the user's message.
      // Capture the timer id and clear it once the race settles, so an unbind that
      // WINS does not leave a dangling <=1.5s timer alive.
      let gateTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          pendingUnbind.catch(() => undefined),
          new Promise((resolve) => {
            gateTimer = setTimeout(resolve, AI_CHAT_UNBIND_GATE_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (gateTimer !== undefined) clearTimeout(gateTimer);
      }
      // A second "New chat" during the wait remounted this component; its dispatch/
      // sendMessage refs belong to a dead store. Bail (precedent: the async paths
      // below all guard on mountedRef after an await).
      if (!mountedRef.current) return;
    }
    dispatchRef.current({ type: "SEND_LOCAL" });
    // F1: this local stream's onFinish is stamped with the just-bumped generation.
    turnEpochRef.current = epochRef.current;
    sendMessageRef.current?.({ text });
  }, []);
  const flushNext = useCallback(() => {
    const { head, rest } = dequeue(queuedRef.current);
    if (!head) return false;
    setQueue(rest);
    // localSend is async now (the #665 unbind gate); the dequeue decision is still
    // synchronous, so flushNext stays a synchronous boolean.
    void localSend(head.text);
    return true;
  }, [setQueue, localSend]);

  const enqueue = useCallback(
    (text: string) => {
      setQueue(enqueueMessage(queuedRef.current, { id: generateId(), text }));
    },
    [setQueue],
  );
  const removeQueued = useCallback(
    (id: string) => {
      setQueue(removeQueuedById(queuedRef.current, id));
    },
    [setQueue],
  );

  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: "/api/ai-chat/stream",
        credentials: "include",
        prepareReconnectToStreamRequest: () => {
          // #491 tail-only attach URL. When there is an anchor (a streaming/active
          // tail to resume) build `?anchor=<assistantRowId>&n=<stepsPersisted>`: the
          // server returns the TAIL — a synthetic `start` frame + frames for steps
          // >= n, then live — which the SDK continuation appends to the seeded row.
          // The server 204s (-> restore-noop + poll) when it cannot cover the
          // frontier (overflow/rotation gap) or the anchor mismatches (a newer run).
          // No anchor (a user tail / pre-first-frame break) => no params.
          const anchor = anchorRef.current;
          return {
            api: `/api/ai-chat/runs/${chatIdRef.current}/stream${
              anchor
                ? `?anchor=${anchor.id}&n=${anchor.stepsPersisted}`
                : ""
            }`,
          };
        },
        fetch: async (input: RequestInfo | URL, init: RequestInit = {}) => {
          if ((init.method ?? "GET") !== "GET") {
            // Send path (POST). #488 commit 5: NO client 409 retry ladder anymore
            // (the CAS supersede replaces it). We DO peek 409/CAS outcomes to drive
            // the FSM, then return the Response untouched to the SDK (a 409 body is
            // surfaced by the classified error banner via error-message.ts).
            const wasSupersede =
              machineRef.current.phase.name === "superseding";
            const ep = epochRef.current;
            const response = await fetch(input, init);
            if (wasSupersede) {
              if (response.ok) {
                dispatchRef.current({ type: "SUPERSEDE_READY", epoch: ep });
              } else if (response.status === 409) {
                const { code, activeRunId } = await read409(response);
                if (code === "SUPERSEDE_TARGET_MISMATCH") {
                  // #555 F1: this CAS 409 leaves the FSM in error(supersede-mismatch)
                  // with the moved run absorbed into runFact — arm the one-shot so the
                  // failed turn's own onFinish does not clobber it (see the ref decl).
                  runFactAdopted409Ref.current = true;
                  dispatchRef.current({
                    type: "SUPERSEDE_MISMATCH",
                    currentRunId: activeRunId,
                    epoch: ep,
                  });
                } else if (code === "SUPERSEDE_TIMEOUT") {
                  // #555 F1: error(supersede-timeout) PRESERVES the prior runFact.
                  runFactAdopted409Ref.current = true;
                  dispatchRef.current({ type: "SUPERSEDE_TIMEOUT", epoch: ep });
                } else if (code === "SUPERSEDE_INVALID") {
                  // #555 F1: error(supersede-invalid) PRESERVES the prior runFact.
                  runFactAdopted409Ref.current = true;
                  dispatchRef.current({ type: "SUPERSEDE_INVALID", epoch: ep });
                }
              }
            } else if (response.status === 409) {
              const { code, activeRunId } = await read409(response);
              if (code === "A_RUN_ALREADY_ACTIVE") {
                // S4: thread the server's activeRunId into the event so the FSM can
                // adopt it as the run-fact — a later "Send now" then CAS-supersedes
                // that (possibly foreign-tab) run instead of a blind promote+abort.
                // #555 F1: arm the one-shot so the SAME failed turn's onFinish does
                // NOT clobber that just-adopted run-fact to null (see the ref decl) —
                // this is THE fix for the dead run-already-active S4 case.
                runFactAdopted409Ref.current = true;
                dispatchRef.current({ type: "RUN_ALREADY_ACTIVE", activeRunId });
              }
            }
            return response;
          }
          // Reconnect/attach GET: the SDK passes no AbortSignal, so wire our own
          // controller for observer Stop / unmount abort (effect-owned, I5).
          const controller = new AbortController();
          attachAbortRef.current = controller;
          const ep = pendingAttachEpochRef.current;
          const wasReconnecting =
            machineRef.current.phase.name === "reconnecting";
          try {
            const response = await fetch(input, {
              ...init,
              signal: controller.signal,
            });
            if (response.status === 204 || !response.ok)
              handleAttachOutcome(ep, wasReconnecting, false);
            else handleAttachOutcome(ep, wasReconnecting, true);
            return response;
          } catch (err) {
            handleAttachOutcome(ep, wasReconnecting, false);
            throw err;
          }
        },
        prepareSendMessagesRequest: ({ messages, body }) => {
          // #488 commit 5: read-and-clear the supersede runId so `supersede:{runId}`
          // is carried by ONLY this request (the CAS "interrupt and send now").
          const supersedeRunId = pendingSupersedeRef.current;
          pendingSupersedeRef.current = null;
          return {
            body: {
              ...body,
              chatId: chatIdRef.current,
              openPage: openPageRef.current
                ? {
                    ...openPageRef.current,
                    selection: getEditorSelectionRef.current?.() ?? null,
                  }
                : null,
              roleId: roleIdRef.current,
              ...(supersedeRunId
                ? { supersede: { runId: supersedeRunId } }
                : {}),
              messages,
            },
          };
        },
      }),
    [],
  );

  // Attach GET outcome -> FSM event. The epoch guard replaces BOTH the one-shot
  // 204 guard (noStreamHandledRef) and the unmount gate: a stale/superseded or
  // post-DISPOSE outcome is dropped (I1). #491 tail-only: on a NONE outcome there is
  // NOTHING to restore — the anchor row was never stripped from the view (the seed
  // keeps it) — so we only invalidate for a fresh poll + dispatch the FSM event.
  const handleAttachOutcome = useCallback(
    (ep: number, wasReconnecting: boolean, live: boolean) => {
      if (ep !== epochRef.current) return; // stale generation — drop
      if (live) {
        dispatchRef.current(
          wasReconnecting
            ? { type: "RECONNECT_ATTACHED", epoch: ep }
            : { type: "ATTACH_LIVE", epoch: ep },
        );
        return;
      }
      queryClient.invalidateQueries({
        queryKey: AI_CHAT_MESSAGES_RQ_KEY(chatIdRef.current),
      });
      dispatchRef.current(
        wasReconnecting
          ? { type: "RECONNECT_NONE", epoch: ep }
          : { type: "ATTACH_NONE", epoch: ep },
      );
    },
    [queryClient],
  );

  const {
    messages,
    sendMessage,
    status,
    stop,
    error,
    setMessages,
    resumeStream,
  } = useChat({
    id: chatStoreId,
    messages: initialMessages,
    transport,
    experimental_throttle: STREAM_THROTTLE_MS,
    onFinish: ({ message, isAbort, isDisconnect, isError }) => {
      // #488 F1: STAMP this finish with the generation the stream STARTED under
      // (I1). A superseded/dead stream's late finish carries an OLD generation and
      // is dropped by the reducer, so it cannot drive the live machine.
      const stampEpoch = turnEpochRef.current;
      // Ownership (I2) is the FSM ctx: a resumed/attached/reconnected turn is an
      // OBSERVER; a local send is the owner. The queue flushes ONLY under local
      // ownership; an observer never flushes (invariant 7).
      const wasObserver = machineRef.current.ctx.ownership === "observer";
      // Notify the parent on EVERY terminal outcome (threadKey-guarded downstream
      // for #161); fires even while unmounting.
      onTurnFinished(extractServerChatId(message), threadKey);

      // #555 F1: read-and-CLEAR the runFact-adopting-409 one-shot BEFORE any finish
      // routing. When set, the FSM already absorbed THIS turn's outcome via a gate/CAS
      // 409 -> `error(kind)` with the foreign/moved run in runFact; the isError branch
      // below SKIPS its FINISH_ERROR so it does not clobber that run-fact to null
      // (which kills the S4 Send-now supersede). Cleared unconditionally here so it can
      // never leak into a later turn's finish (true one-shot). A normal stream error
      // leaves it false -> FINISH_ERROR still fires and clears runFact. See the decl.
      const adopted409 = runFactAdopted409Ref.current;
      runFactAdopted409Ref.current = false;

      // A missing message (a pre-first-frame break) has no visible content.
      const msgHasVisible = message
        ? assistantMessageHasVisibleContent(message)
        : false;

      // #488 F1: the SUPERSEDED stream A just finalized (we are still `superseding`
      // and stream B has not been sent yet). Record A's terminal outcome STAMPED —
      // I1 drops it (superseding bumped the epoch), so A cannot drive a false
      // reconnect / reset the run-fact — then start B NOW that A is fully done. B is
      // deferred to a microtask so A's SDK `finally` (`activeResponse = void 0`)
      // runs BEFORE B's makeRequest sets `activeResponse`, else the dying A clobbers
      // B (ai@6). This is the no-overlap guarantee the CAS supersede needs.
      if (
        machineRef.current.phase.name === "superseding" &&
        pendingSupersedeTextRef.current !== null
      ) {
        // Disconnect-first (see the routing note below): a real drop is
        // { isError:true, isDisconnect:true }. All of these are dropped by I1 here
        // (superseding bumped the epoch) — the order only mirrors the main routing.
        if (isDisconnect)
          dispatch({ type: "FINISH_DISCONNECT", hasVisibleContent: msgHasVisible, epoch: stampEpoch });
        else if (isError) dispatch({ type: "FINISH_ERROR", kind: "stream", epoch: stampEpoch });
        else if (isAbort) dispatch({ type: "FINISH_ABORT", epoch: stampEpoch });
        else dispatch({ type: "FINISH_CLEAN", epoch: stampEpoch });
        const text = pendingSupersedeTextRef.current;
        pendingSupersedeTextRef.current = null;
        setStopNotice(null);
        queueMicrotask(() => {
          if (!mountedRef.current) return;
          turnEpochRef.current = epochRef.current; // B's (superseding) generation
          sendMessageRef.current?.({ text });
        });
        return;
      }

      // #488 (browser QA): route DISCONNECT FIRST. In ai@6.0.207 a real network drop
      // yields BOTH `{ isError:true, isDisconnect:true }` — the SDK sets `isError`
      // unconditionally in its catch and `isDisconnect` only ALONGSIDE it (for a
      // fetch/network TypeError). Checking `isError` first therefore sent EVERY real
      // drop to the terminal error banner and NEVER entered the reconnect ladder
      // (`FINISH_DISCONNECT` is its only entry). A disconnect — the detached run
      // keeps executing server-side — must win; only a NON-disconnect error (a
      // provider 500, `{ isError:true, isDisconnect:false }`) is terminal.
      if (isDisconnect) {
        if (!mountedRef.current) {
          setStopNotice(null);
          return;
        }
        // No detached run to recover (legacy, non-autonomous): a plain disconnect —
        // terminal notice, no reconnect. (An observer only exists in autonomous mode,
        // so this is always a local turn.)
        if (autonomousRunsEnabled !== true) {
          dispatch({
            type: "FINISH_DISCONNECT",
            hasVisibleContent: false,
            epoch: stampEpoch,
          });
          setStopNotice("disconnect");
          return;
        }
        // A mount-resume OBSERVER (one-shot resume, NOT live-follow) drop falls to
        // the degraded POLL, which merges by id — it does NOT attach, so there is
        // nothing to re-seed. #491 tail-only: the anchor row was never removed from
        // the view (the seed keeps it; the continuation only APPENDED), so nothing to
        // restore either. The FSM routes this to `polling` (ownership observer,
        // !liveFollow).
        if (wasObserver && !machineRef.current.ctx.liveFollow) {
          queryClient.invalidateQueries({
            queryKey: AI_CHAT_MESSAGES_RQ_KEY(chatIdRef.current),
          });
          dispatch({
            type: "FINISH_DISCONNECT",
            hasVisibleContent: msgHasVisible,
            epoch: stampEpoch,
          });
          setStopNotice(null);
          return;
        }
        // We will (re-)ENTER THE RECONNECT LADDER (an attach): a LOCAL live turn's
        // first drop, OR a live-follow observer's SUBSEQUENT drop (#488 commit 3).
        // #488 commit 2: recover by the RUN-FACT, not by the presence of an assistant
        // message — a setup-phase break still leaves a detached run writing to pages.
        //
        // #491 tail-only (THE crux): the live store holds a PARTIAL step that is AHEAD
        // of the persisted boundary; tail-applying the reconnect's step frames over it
        // would DUPLICATE that partial step. So entering reconnecting is ALWAYS via a
        // RE-SEED FROM PERSIST — never the live store. Fetch the authoritative
        // persisted assistant row (`getRun` returns the projected `message`), replace
        // the live partial by id (mergeById -> the store now holds EXACTLY steps
        // 0..N-1), and set the anchor to `{ id, n = stepsPersisted }`. Only AFTER the
        // re-seed is applied do we enter the ladder (FINISH_DISCONNECT schedules the
        // backoff) — so the attach can never tail-apply over the live partial.
        const cid = chatIdRef.current;
        // The live-message runId is the run-fact source (the attach GET keys on
        // chatId, so a sentinel still recovers a setup-phase break).
        const runId = extractRunId(message ?? undefined) ?? "pending";
        const enterReconnect = (fact: string): void => {
          if (!mountedRef.current) return;
          // Epoch-stamp the run-fact too (I1): the getRun rtt widens the
          // onFinish->dispatch window, so a concurrent SEND_LOCAL during it must be
          // able to drop this stale RUN_FACT (else it clobbers the new turn's
          // runFact.runId). Consistent with the postRun RUN_FACT stamp.
          dispatch({ type: "RUN_FACT", runFact: { runId: fact }, epoch: stampEpoch });
          dispatch({
            type: "FINISH_DISCONNECT",
            hasVisibleContent: msgHasVisible,
            epoch: stampEpoch,
          });
        };
        // Restore the STRUCTURAL guarantee that the live partial is never the
        // tail-apply base: drop the live partial from the store by id and null the
        // anchor, so the reconnect replays from step 0 into a CLEAN store (a full
        // rebuild) or, past any rotation, 204s -> degraded poll. Used on BOTH the
        // no-persisted-row and getRun-FAILURE paths — after this there is no path
        // where the attach tail-applies frames onto a row that already has them
        // (the #137/#161 duplication class).
        const dropLivePartialAndReplayFromStart = (): void => {
          if (message?.role === "assistant" && typeof message.id === "string") {
            const liveId = message.id;
            setMessagesRef.current?.((prev) =>
              prev.filter((m) => m.id !== liveId),
            );
          }
          anchorRef.current = null;
        };
        if (cid) {
          // #541: bound the persist re-seed wait with a timeout race. getRun goes
          // through the axios client, which has NO request timeout; a HUNG getRun
          // (connection open, no response) — distinct from a REJECT, which the
          // `.catch` already handles — would otherwise never let us enter the ladder,
          // leaving the FSM stuck in `streaming` with no banner and no poll until the
          // browser socket timeout. `settled` makes the three branches (resolve /
          // reject / timeout) mutually exclusive: whichever fires FIRST wins and the
          // others become no-ops. So a LATE getRun resolve AFTER the timeout is fully
          // ignored — it cannot (i) re-enter reconnect a second time, (ii) overwrite
          // the timeout's replay-from-start with a stale re-seed, or (iii) re-arm any
          // timer. On timeout we take the SAME fallback as the reject path (drop the
          // live partial + enter the ladder, so the poll and the stalled-idle cap arm).
          let settled = false;
          const finishReseed = (apply: () => void): void => {
            if (settled) return;
            settled = true;
            if (reseedTimerRef.current) {
              clearTimeout(reseedTimerRef.current);
              reseedTimerRef.current = null;
            }
            if (!mountedRef.current) return;
            apply();
          };
          reseedTimerRef.current = setTimeout(() => {
            finishReseed(() => {
              dropLivePartialAndReplayFromStart();
              enterReconnect(runId);
            });
          }, RECONNECT_RESEED_TIMEOUT_MS);
          void getRun(cid)
            .then((res) => {
              finishReseed(() => {
                const persisted = res.message;
                if (persisted && persisted.role === "assistant") {
                  anchorRef.current = {
                    id: persisted.id,
                    stepsPersisted: stepsPersistedOf(persisted),
                  };
                  // Replace the live partial with the persisted row IN PLACE by id —
                  // the re-seed from persist. The attach's tail (steps >= N) then
                  // appends to a store holding EXACTLY steps 0..N-1: no duplication.
                  setMessages((prev) => mergeById(prev, rowToUiMessage(persisted)));
                } else {
                  // No persisted assistant row (pre-first-frame break): drop the live
                  // partial + replay from start (no anchor/n) so nothing is duplicated.
                  dropLivePartialAndReplayFromStart();
                }
                enterReconnect(res.run?.id ?? runId);
              });
            })
            .catch(() => {
              finishReseed(() => {
                // Persist read FAILED: we cannot re-seed from fresh persist, and a
                // stale mount-time anchor over the live partial would tail-apply
                // already-present steps -> duplication (a flaky-network blip:
                // SSE + getRun both fail, network recovers in ~1s, the registry still
                // covers from the mount frontier). Restore the removed-filter guarantee
                // instead: drop the live partial + replay from start / 204 -> poll.
                dropLivePartialAndReplayFromStart();
                enterReconnect(runId);
              });
            });
        } else {
          dropLivePartialAndReplayFromStart();
          enterReconnect(runId);
        }
        setStopNotice(null);
        return;
      }
      // A NON-disconnect stream error (a provider 500 etc.) -> terminal error banner.
      if (isError) {
        // #555 F1: if a gate/CAS 409 already absorbed this turn's outcome (the FSM is
        // already in error(kind) with the foreign/moved run in runFact), the stream's
        // own error finish is redundant — dispatching FINISH_ERROR would clobber that
        // run-fact to null and kill the S4 Send-now supersede. Skip it (the classified
        // 409 banner + the adopted run-fact both survive). adopted409 is false for a
        // normal stream error, which still dispatches FINISH_ERROR and clears runFact.
        if (!adopted409) {
          dispatch({ type: "FINISH_ERROR", kind: "stream", epoch: stampEpoch });
        }
        setStopNotice(null);
        return;
      }
      if (isAbort) {
        // A user Stop / an interrupt abort finished. The FSM stopping/idle exit is
        // by DATA (this terminal outcome, I4 — honored in `stopping` by the reducer).
        dispatch({ type: "FINISH_ABORT", epoch: stampEpoch });
        setStopNotice("manual");
        return;
      }
      // Clean finish.
      if (wasObserver) {
        if (mountedRef.current) {
          const hasVisible = msgHasVisible;
          if (!hasVisible) {
            // Starved replay (the tail carried no new steps). #491 tail-only: the
            // seeded steps 0..N-1 are still on screen (the SDK continuation never
            // wiped them — `start` does not reset parts), so there is nothing to
            // restore; just poll to the real terminal.
            queryClient.invalidateQueries({
              queryKey: AI_CHAT_MESSAGES_RQ_KEY(chatIdRef.current),
            });
            dispatch({ type: "STREAM_INCOMPLETE", reason: "starved", epoch: stampEpoch });
          } else {
            // Healthy resumed finish — nothing to restore/arm, just settle.
            dispatch({ type: "FINISH_CLEAN", epoch: stampEpoch });
          }
        }
        setStopNotice(null);
        return;
      }
      // Local clean finish: settle + flush the queue (gated on liveness, #486).
      dispatch({ type: "FINISH_CLEAN", epoch: stampEpoch });
      setStopNotice(null);
      if (mountedRef.current) flushNext();
    },
    onError: (streamError) => {
      console.error("AI chat stream error:", streamError);
      onTurnFinished(undefined, threadKey);
    },
  });

  // Publish the live useChat handles to the effect-runner refs.
  resumeStreamRef.current = resumeStream;
  setMessagesRef.current = setMessages as unknown as (
    updater: (prev: UIMessage[]) => UIMessage[],
  ) => void;
  sendMessageRef.current = sendMessage;
  stopFnRef.current = stop;

  // EARLY chat-id (#174) + runId (#488) adoption from the streaming assistant
  // message's start metadata. Forward the chat id once; adopt the runId into the
  // FSM run-fact; and (#234 F5) fire a DEFERRED server stop the moment the id lands
  // while still `stopping` — no stopPendingRef needed (the FSM phase is the latch).
  const lastForwardedChatIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const tail = messages[messages.length - 1];
    if (tail?.role !== "assistant") return;
    const serverChatId = extractServerChatId(tail);
    if (
      onServerChatId &&
      serverChatId &&
      serverChatId !== lastForwardedChatIdRef.current
    ) {
      lastForwardedChatIdRef.current = serverChatId;
      onServerChatId(serverChatId);
      if (machineRef.current.phase.name === "stopping")
        onServerStopRef.current?.(serverChatId);
    }
    // #488 F4: the FIRST assistant frame of a LOCAL turn moves the FSM
    // `sending -> streaming` (and adopts the runId), matching the spec's
    // STREAM_START transition. Later frames / observer turns (already streaming)
    // just refresh the run-fact.
    const runId = extractRunId(tail);
    if (machineRef.current.phase.name === "sending") {
      dispatch({ type: "STREAM_START", runId, epoch: epochRef.current });
    } else if (runId && machineRef.current.ctx.runFact?.runId !== runId) {
      dispatch({ type: "RUN_FACT", runFact: { runId } });
    }
  }, [messages, onServerChatId, dispatch]);

  // Live "turn was interrupted" marker (a manual Stop vs a dropped connection — a
  // distinction only available live). Cleared when the next turn starts.
  const [stopNotice, setStopNotice] = useState<null | "manual" | "disconnect">(
    null,
  );

  const isStreaming = status === "submitted" || status === "streaming";
  const phase = machine.phase;
  const isObserver = machine.ctx.ownership === "observer";

  // Mount effect: arm the resume attempt — ONLY on a server-confirmed active run
  // (#488 commit 4b). A STREAMING tail IS the run-fact (status streaming) -> attach
  // now. A USER tail (ended on a user message) may have NO active run, so confirm
  // via POST /run first: a chat with no active run must NOT arm a poll (the old code
  // attached -> 204 -> ~240 req/10min storm). A SETTLED assistant tail never resumes.
  useEffect(() => {
    mountedRef.current = true;
    if (autonomousRunsEnabled === true && chatId !== null) {
      const rows = initialRows ?? [];
      if (isStreamingTail(rows)) {
        dispatch({ type: "ATTACH_START" });
      } else if (!isSettledAssistantTail(rows)) {
        void getRun(chatId)
          .then((res) => {
            if (!mountedRef.current) return;
            if (res.run && isActiveRunStatus(res.run.status))
              dispatch({ type: "ATTACH_START", runId: res.run.id });
          })
          .catch(() => undefined);
      }
    }
    return () => {
      mountedRef.current = false;
      // #541: clear the in-flight persist re-seed timeout (not an FSM effect timer,
      // so DISPOSE does not touch it) — no dangling setTimeout after unmount.
      if (reseedTimerRef.current) {
        clearTimeout(reseedTimerRef.current);
        reseedTimerRef.current = null;
      }
      dispatch({ type: "DISPOSE" }); // aborts attach + timers, bumps epoch (I5)
    };
    // Mount-only by design; the parent remounts per chat via `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconciliation + degraded-merge (invariant 8): while a poll-bearing recovery is
  // active (polling / reconnecting / stopping), merge the polled assistant tail on
  // every initialRows update and settle to terminal via POLL_TERMINAL.
  useEffect(() => {
    if (isStreaming) return; // a local stream owns the view
    const p = machineRef.current.phase.name;
    if (p !== "polling" && p !== "reconnecting" && p !== "stopping") return;
    const rows = initialRows ?? [];
    const tail = rows[rows.length - 1];
    if (!tail || tail.role !== "assistant") return;
    setMessages((prev) => mergeById(prev, rowToUiMessage(tail)));
    // Anchor-mismatch coherence: if a DIFFERENT run's row B has replaced our anchor
    // row A as the tail, A would linger as an orphan — reconcile A by id from FRESH
    // PERSISTED history (not the pinned live row) so no phantom row survives.
    const anchor = anchorRef.current;
    if (anchor && anchor.id !== tail.id) {
      const historical = rows.find((r) => r.id === anchor.id);
      if (historical)
        setMessages((prev) => mergeById(prev, rowToUiMessage(historical)));
    }
    if (tail.status !== "streaming") dispatch({ type: "POLL_TERMINAL" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRows, isStreaming, setMessages]);

  // #488 commit 4a: the stalled inactivity cap. While polling/reconnecting, if no
  // new run activity (initialRows unchanged) for DEGRADED_POLL_IDLE_MAX_MS, fire
  // POLL_IDLE_CAP -> the FSM goes `stalled` (banner + Retry) instead of silent.
  // Reset on every activity (initialRows change) and on phase change.
  useEffect(() => {
    if (idleCapTimerRef.current) {
      clearTimeout(idleCapTimerRef.current);
      idleCapTimerRef.current = null;
    }
    // Review #4: `stopping` also arms the poll and needs a bounded exit (the FSM
    // maps POLL_IDLE_CAP from `stopping` -> idle, not stalled).
    const p = phase.name;
    if (p !== "polling" && p !== "reconnecting" && p !== "stopping") return;
    idleCapTimerRef.current = setTimeout(() => {
      dispatchRef.current({ type: "POLL_IDLE_CAP" });
    }, DEGRADED_POLL_IDLE_MAX_MS);
    return () => {
      if (idleCapTimerRef.current) clearTimeout(idleCapTimerRef.current);
    };
  }, [phase, initialRows]);

  // #555 S3: consume the degraded delta poll's `run` field. Until now the delta
  // endpoint's authoritative run fact rode the wire UNCONSUMED (run-fsm.spec.md §3.4)
  // — a 204 reconnect went through RECONNECT_NONE and the run field of the DELTA
  // response was ignored, so a stale `reconnecting` only cleared once the terminal
  // ROW merged or the ladder exhausted. Wire it into the RUN_FACT dispatch path: a
  // fresh NEGATIVE fact quenches recovery IMMEDIATELY (I3 fresh-negative gate),
  // a positive fact refreshes ctx.runFact. No epoch — this is AMBIENT server truth (a
  // trigger event that is never dropped), not a per-generation command outcome; the
  // poll only runs while armed (a poll-bearing recovery), so it never races a live
  // local stream. Deduped by the derived active run id, and the dedupe ref is reset
  // when the poll disarms (`polledRunFact` returns to `undefined`) so the NEXT
  // recovery's negative fact re-quenches.
  const lastPolledRunKeyRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (polledRunFact === undefined) {
      lastPolledRunKeyRef.current = undefined; // poll disarmed — reset the dedupe
      return;
    }
    const activeRunId =
      polledRunFact && isActiveRunStatus(polledRunFact.status)
        ? polledRunFact.id
        : null;
    if (activeRunId === lastPolledRunKeyRef.current) return; // unchanged — no re-dispatch
    lastPolledRunKeyRef.current = activeRunId;
    dispatch({
      type: "RUN_FACT",
      runFact: activeRunId ? { runId: activeRunId } : null,
    });
  }, [polledRunFact, dispatch]);

  // Clear the stopped marker as soon as a new turn begins streaming.
  useEffect(() => {
    if (isStreaming) setStopNotice(null);
  }, [isStreaming]);

  // "Send now" on a queued message: #488 commit 5 — interrupt the active run and
  // send THIS message via the server CAS supersede (POST /stream {supersede:{runId}})
  // when the run id is known. No local stop/re-POST dance, no client retry ladder.
  const sendNow = useCallback(
    (id: string) => {
      const msg = queuedRef.current.find((m) => m.id === id);
      if (!msg) return;
      // #488 LOW-2: a supersede is already in flight (stream A aborted, B not sent
      // yet). A second "Send now" must NOT clobber the pending message nor start a
      // competing send. Least-surprising choice: this click is a NO-OP and the
      // message stays queued — the user can send it once B has started (nothing is
      // lost). (Guarding on both the pending text and the FSM phase.)
      if (
        pendingSupersedeTextRef.current !== null ||
        machineRef.current.phase.name === "superseding"
      ) {
        return;
      }
      // #488 LOW-1: decide "is stream A still live" from the FSM phase (machineRef),
      // which onFinish updates SYNCHRONOUSLY — NOT the render-lagged statusRef. In
      // the sub-frame window where A has already fired onFinish (FSM -> idle) but
      // statusRef still reads "streaming", treating A as live would abort a dead
      // stream (no second onFinish -> B never sent, message lost). The FSM phase
      // closes that window: a settled A reads as not-live -> B is sent immediately.
      const p = machineRef.current.phase.name;
      const aLiveLocal =
        (p === "sending" || p === "streaming") &&
        machineRef.current.ctx.ownership === "local";
      const runId = machineRef.current.ctx.runFact?.runId;
      if (aLiveLocal && autonomousRunsEnabled === true && runId && runId !== "pending") {
        // CAS supersede: the server stops the old run + starts this one atomically.
        // #488 F1: do NOT start stream B synchronously — the local stream A is still
        // live, and overlapping streams corrupt each other in ai@6 (A's `finally`
        // reads then nulls the shared `activeResponse`). ABORT A now and stash the
        // text; A's onFinish (dropped by the epoch stamp) starts B in a microtask,
        // AFTER A is fully finalized (no overlap). The POST then carries the
        // supersede body (pendingSupersedeRef, armed by the effect).
        setQueue(removeQueuedById(queuedRef.current, id));
        pendingSupersedeTextRef.current = msg.text;
        dispatch({ type: "SUPERSEDE_REQUESTED", targetRunId: runId });
        stopFnRef.current?.(); // abort A -> its onFinish sends B
        return;
      }
      // #555 S4-full: supersede a run belonging to ANOTHER TAB from the ERROR phase.
      // A plain POST that hit the one-active-run gate (A_RUN_ALREADY_ACTIVE), or a
      // supersede that lost a CAS (SUPERSEDE_MISMATCH), leaves the FSM in `error`
      // with the foreign/moved run absorbed into runFact (W1 groundwork). Unlike the
      // live-local branch there is NO owned stream A in flight here (error is entered
      // by a terminal finish or a pre-stream 409), so I1 is not at risk: we send B
      // DIRECTLY (no stop()/onFinish deferral — there is nothing to abort or wait
      // for). SUPERSEDE_REQUESTED bumps the epoch, so even a late finish of the failed
      // A (stamped with its pre-error generation) is dropped and cannot overlap B.
      // The `runId && runId !== "pending"` guard scopes this to EVERY error kind that
      // LEFT a run-fact — run-already-active and supersede-mismatch, and also
      // supersede-timeout / supersede-invalid (all of which keep runFact set). None
      // of them has an owned stream A in flight, so a direct send is safe for all;
      // for the supersede-* kinds this is a user-initiated re-supersede (they hit
      // Send), not an auto-retry. A plain stream error cleared runFact to null and
      // correctly falls through to a plain send. The reducer already permits
      // SUPERSEDE_REQUESTED from `error` (spec §1).
      if (
        p === "error" &&
        autonomousRunsEnabled === true &&
        runId &&
        runId !== "pending"
      ) {
        setQueue(removeQueuedById(queuedRef.current, id));
        // dispatch first: the `supersede` effect arms pendingSupersedeRef, which
        // prepareSendMessagesRequest reads-and-clears on the POST below (order-
        // dependent — the dispatch is synchronous, so the ref is set before send).
        dispatch({ type: "SUPERSEDE_REQUESTED", targetRunId: runId });
        // B's onFinish is stamped with the just-bumped (superseding) generation (I1).
        turnEpochRef.current = epochRef.current;
        sendMessageRef.current?.({ text: msg.text });
        return;
      }
      if (aLiveLocal) {
        // No CAS possible (legacy without a run, or the runId not adopted yet):
        // promote to head and abort; the local turn's abort finishes and the queue
        // holds the promoted head for the user (a blind re-POST would 409 -> the
        // classified "already answering — interrupt and send" banner guides them).
        setQueue(promoteToHead(queuedRef.current, id));
        stopFnRef.current?.();
        return;
      }
      // Nothing live to interrupt (idle, or A already settled): send it now.
      setQueue(removeQueuedById(queuedRef.current, id));
      void localSend(msg.text);
    },
    [setQueue, autonomousRunsEnabled, dispatch, localSend],
  );

  // Stop the current turn. Abort the local SSE + the attach GET; in AUTONOMOUS mode
  // additionally request the AUTHORITATIVE server stop (a local abort is only a
  // client disconnect the server ignores). The FSM `stopping` exits by DATA (I4):
  // the local turn's onFinish (FINISH_ABORT) or the poll reaching terminal.
  const handleStop = useCallback(() => {
    stopFnRef.current?.();
    if (autonomousRunsEnabled) {
      dispatch({ type: "STOP_REQUESTED" });
    } else {
      // Legacy: no server run to stop from the client (the server's onClose issues
      // requestStop on disconnect). Just reset the FSM recovery.
      attachAbortRef.current?.abort();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      dispatch({ type: "FINISH_ABORT" });
    }
  }, [autonomousRunsEnabled, dispatch]);

  // Manual Retry from the reconnect-failed OR stalled banner.
  const onRetry = useCallback(() => {
    dispatch({ type: "RETRY" });
  }, [dispatch]);

  // Classify the turn error into a heading + detail (connection reset, timeout, the
  // #487 409 codes, ...). Computed here so the SAME text can mirror into the export.
  const errorView = error ? describeChatError(error.message ?? "", t) : null;

  // #488 (browser QA): the FSM PHASE is the source of truth for WHICH banner to
  // show. A real network drop leaves useChat `error` SET even after the FSM has
  // moved to `reconnecting` — in ai@6 a drop is always `{isError:true,
  // isDisconnect:true}` and the SDK sets `error` alongside `isError`. So the
  // terminal error banner must show ONLY when the FSM is actually TERMINAL
  // (`error(kind)`); during recovery (reconnecting / polling / stalled /
  // superseding / stopping) the recovery banner — or the streaming content — wins
  // over the residual `error`, otherwise the terminal "Lost connection… reload"
  // banner masks "reconnecting… (N/5)". This still surfaces the classified #487 409
  // errors: a supersede/gate 409 lands the FSM in `error(kind)`, so it shows then.
  const showError = errorView !== null && phase.name === "error";

  // Role-picker empty state (unchanged from #149).
  const [rolePickedNoSend, setRolePickedNoSend] = useState(false);
  const handleRolePick = (role: IAiRole): void => {
    roleIdRef.current = role.id;
    onRolePicked?.(role);
    const launch = roleLaunchMessage(
      role,
      t("Take a look at the current document"),
    );
    if (launch !== null) {
      void localSend(launch);
    } else {
      setRolePickedNoSend(true);
    }
  };
  if (shouldResetRolePicked(chatId, roleId, rolePickedNoSend)) {
    setRolePickedNoSend(false);
  }
  const showRoleCards =
    chatId === null && (roles?.length ?? 0) > 0 && !rolePickedNoSend;
  const roleCardsEmptyState = showRoleCards ? (
    <RoleCards roles={roles ?? []} onPick={handleRolePick} />
  ) : undefined;

  return (
    <Box className={classes.panel}>
      <MessageList
        messages={messages}
        isStreaming={isStreaming}
        emptyState={roleCardsEmptyState}
        assistantName={assistantName}
      />

      {showError && errorView ? (
        <ChatErrorAlert title={errorView.title} detail={errorView.detail} mb="xs" />
      ) : phase.name === "reconnecting" ? (
        // #430/#488: while auto-reconnecting to a detached run's live tail, show
        // progress; once attempts are exhausted, offer a manual Retry (the degraded
        // poll keeps catching up underneath).
        <Alert variant="light" color="gray" p="xs" mb="xs" style={{ flexShrink: 0 }}>
          <Group gap={8} wrap="nowrap" align="center">
            {!phase.failed ? (
              <>
                <Loader size={14} color="gray" style={{ flex: "none" }} />
                <Text size="sm" lh={1.3} c="dimmed">
                  {t("Connection lost — reconnecting…")}
                  {` (${phase.attempt}/${RECONNECT_MAX_ATTEMPTS})`}
                </Text>
              </>
            ) : (
              <>
                <Text size="sm" lh={1.3} c="dimmed" style={{ flex: 1 }}>
                  {t("Couldn't reconnect to the answer.")}
                </Text>
                <Button
                  size="compact-xs"
                  variant="light"
                  color="gray"
                  onClick={onRetry}
                >
                  {t("Retry")}
                </Button>
              </>
            )}
          </Group>
        </Alert>
      ) : phase.name === "stalled" ? (
        // #488 commit 4a: the degraded poll hit the inactivity cap — instead of a
        // silent "forever half-done answer", tell the user and offer Retry.
        <Alert variant="light" color="gray" p="xs" mb="xs" style={{ flexShrink: 0 }}>
          <Group gap={8} wrap="nowrap" align="center">
            <Text size="sm" lh={1.3} c="dimmed" style={{ flex: 1 }}>
              {t("The answer may be incomplete — the run stopped responding.")}
            </Text>
            <Button
              size="compact-xs"
              variant="light"
              color="gray"
              onClick={onRetry}
            >
              {t("Retry")}
            </Button>
          </Group>
        </Alert>
      ) : stopNotice ? (
        <ChatStoppedNotice
          text={
            stopNotice === "manual"
              ? t("Response stopped.")
              : t("Connection lost — the answer was interrupted.")
          }
          mb="xs"
        />
      ) : null}

      <Stack gap={0} className={classes.inputWrapper}>
        {queued.length > 0 && (
          <Stack gap={4} className={classes.queuedList}>
            {queued.map((m) => (
              <Group
                key={m.id}
                gap={6}
                wrap="nowrap"
                className={classes.queuedItem}
              >
                <IconClockHour4 size={14} className={classes.queuedIcon} />
                <Text size="xs" lineClamp={2} className={classes.queuedText}>
                  {m.text}
                </Text>
                {/* "Send now" (interrupt) is hidden while OBSERVING a detached run
                    (ownership observer): a local stop() does not abort the attach
                    fetch, so the interrupt would be swallowed. Only the remove
                    affordance stays. */}
                {!isObserver && (
                  <Tooltip label={t("Interrupt and send now")} withArrow>
                    <ActionIcon
                      size="xs"
                      variant="subtle"
                      color="blue"
                      onClick={() => sendNow(m.id)}
                      aria-label={t("Send now")}
                    >
                      <IconPlayerPlayFilled size={12} />
                    </ActionIcon>
                  </Tooltip>
                )}
                <ActionIcon
                  size="xs"
                  variant="subtle"
                  color="gray"
                  onClick={() => removeQueued(m.id)}
                  aria-label={t("Remove queued message")}
                >
                  <IconX size={12} />
                </ActionIcon>
              </Group>
            ))}
          </Stack>
        )}
        <ChatInput
          onSend={(text) => void localSend(text)}
          onQueue={enqueue}
          onStop={handleStop}
          isStreaming={isStreaming}
        />
      </Stack>
    </Box>
  );
}
