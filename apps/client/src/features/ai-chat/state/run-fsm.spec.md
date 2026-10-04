# AI-chat run-lifecycle FSM — design spec (#488)

This is the written design that `run-fsm.ts` implements. It ships in the PR (issue
#488 commit 1: "the spec is written FIRST and enters the PR"). It has four parts:
(1) the event × state transition table, (2) the map of every `chat-thread.tsx` ref
to {FSM state | FSM context | stays data}, (3) the run-fact protocol, (4) the
invariants.

The reducer is a **pure function** `reduce(machine, event) → machine`. The returned
machine carries the **command effects** for that transition; a thin runtime in
`chat-thread.tsx` dispatches events and executes effects. Because it is pure, the
whole machine is enumerable and unit-tested directly (event × state → next state is
the observable property) — see `run-fsm.test.ts`.

---

## 1. Event × state transition table

Phases: `idle | sending | streaming | attaching | polling(reason) | stalled |
stopping | superseding | error(kind)`.
Context (orthogonal): `epoch`, `ownership: local|observer`, `runFact: {runId}|null`.

Legend: **†** = command-transition (bumps `epoch`, I1). Effects in `[…]`.

| Event (source) | From phase(s) | → To phase | Effects / ctx |
|---|---|---|---|
| `SEND_LOCAL` (user send) | idle, error, polling, stalled | sending **†** | `[disarmPoll]`, ownership=local |
| `STREAM_START{runId}` (SDK `start` metadata) | sending, attaching, superseding | streaming | `[disarmPoll]`, runFact←runId |
| `FINISH_CLEAN` (onFinish clean) | streaming, … | idle | `[disarmPoll]`, runFact←null |
| `FINISH_ABORT` (onFinish isAbort) | streaming, stopping | idle | `[disarmPoll]`, runFact←null (I4 exits stopping by this DATA) |
| `FINISH_DISCONNECT` (observer, OR local with a runFact) | streaming | polling(disconnect) | `[armPoll(disconnect)]`, ownership=observer — NO re-attach attempts. For a local drop the runtime first invalidates the messages query and dispatches `RUN_FACT{extractRunId ?? "pending"}` (commit 2: recover by run-fact, not by an assistant message). Settles ONLY on the negative polled run fact, after merging the persisted reply via `getRun` (§3.4) — no row-driven `POLL_TERMINAL` |
| `FINISH_DISCONNECT` (local, no runFact) | streaming | idle | runFact←null, ownership=local (plain terminal "connection lost"; also a new chat with no chat id yet — no run-fact, no refetch) |
| `STREAM_INCOMPLETE{reason}` (observer starved/torn clean finish) | streaming(observer) | polling(reason) | `[armPoll(reason)]` |
| `FINISH_ERROR{kind}` (onFinish isError) | any | error(kind) | `[disarmPoll]`, runFact←null |
| `STREAM_START{runId}` (first assistant frame of a local turn) | sending | streaming | runFact←runId, `[disarmPoll]` |
| `ATTACH_START{runId}` (mount resume) | **idle only** (F2) | attaching **†** | `[resumeStream]`, ownership=observer, runFact←runId; ignored from any non-idle phase |
| `ATTACH_LIVE` (attach GET 2xx) | attaching | streaming | — |
| `ATTACH_NONE` (attach GET 204/err/throw) | attaching | polling(attach-none) | `[armPoll(attach-none)]` |
| `RETRY` (manual, stalled banner) | stalled | polling(attach-none) **†** | `[armPoll]` |
| `POLL_TERMINAL` (settled tail merged) | polling(attach-none\|starved), stopping | idle | `[disarmPoll]`, runFact←null (I4). Not dispatched in `polling(disconnect)` — that one settles on the negative run fact (§3.4) |
| `POLL_IDLE_CAP` (inactivity cap) | polling | stalled | `[disarmPoll]` (commit 4a — no more silent) |
| `POLL_IDLE_CAP` (inactivity cap) | stopping | idle | `[disarmPoll]`, runFact←null (Review #4: a Stop-armed poll with no SDK/terminal backstop gets a bounded exit — NOT `stalled`, Stop was already pressed so nothing to retry) |
| `RUN_FACT{null}` (POST /run → null/terminal, 204; the polled fact — in `polling` only after merging the persisted reply, phase-guarded, no epoch — §3.4) | attaching/polling/stopping | idle | `[disarmPoll]`, runFact←null (I3 fresh-negative gate) |
| `RUN_FACT{runId}` | any | (same) | runFact←runId (pessimism toward an attempt) |
| `STOP_REQUESTED` (user Stop) | streaming, polling | stopping **†** | `[stopRun, abortAttach, armPoll]` (poll drives the terminal — I4 exit by data) |
| `SUPERSEDE_REQUESTED{targetRunId}` (interrupt+send) | streaming, polling, error | superseding **†** | `[supersede(target), disarmPoll]` (#555 S4: `error` includes ANOTHER TAB's run — `run-already-active`/`supersede-mismatch` left its id in `runFact`; `sendNow` CAS-targets it) |
| `SUPERSEDE_READY{runId}` (CAS ok) | superseding | streaming | ownership=local, runFact←runId |
| `SUPERSEDE_MISMATCH{currentRunId}` (409 SUPERSEDE_TARGET_MISMATCH) | superseding | error(supersede-mismatch) | `[postRun(verify)]`, runFact←currentRunId |
| `SUPERSEDE_TIMEOUT` (409 SUPERSEDE_TIMEOUT) | superseding | error(supersede-timeout) | — (composer keeps text; no auto-retry) |
| `SUPERSEDE_INVALID` (409 SUPERSEDE_INVALID) | superseding | error(supersede-invalid) | — |
| `RUN_ALREADY_ACTIVE{activeRunId}` (409 A_RUN_ALREADY_ACTIVE, plain POST) | sending | error(run-already-active) | runFact←activeRunId (composer offers supersede; NO auto-retry) |
| `DISPOSE` (unmount) | any | idle **†** | `[abortAttach, disarmPoll]` (I1/I5 — epoch++ kills late callbacks) |

**`stopping` honors any finish (re-review MEDIUM):** BEFORE the epoch filter, a
stream finish (`FINISH_*`/`STREAM_INCOMPLETE`) arriving in phase `stopping` exits
`stopping -> idle` regardless of generation. A plain Stop has no successor stream,
so the aborted stream's finish IS the expected end (I4 exit by data) — and it
carries the PRE-stop generation (STOP_REQUESTED bumped the epoch), so the filter
would otherwise strand the machine in `stopping` (no idle-cap covers it). The filter
stays in force for `superseding` (that is the F1 supersede drop).

**Epoch filter (I1):** the reducer then drops any event carrying an `epoch` that
does not equal the current `ctx.epoch`. Outcome events (`STREAM_START`, `ATTACH_*`,
`SUPERSEDE_*`, **`FINISH_*`/`STREAM_INCOMPLETE`**, `RUN_FACT`) are
stamped with the generation the corresponding STREAM started under (the runtime
holds a per-owned-stream `turnEpoch`); trigger events (user actions, fresh
disconnects) carry no epoch. **F1:** this is what makes a SUPERSEDED stream's late
`onFinish` (a dead stream A closing after the CAS started stream B) get dropped, so
A cannot drive the live new run into a false disconnect recovery or reset its run-fact. The
supersede path additionally ABORTS A and starts B only from A's onFinish (a
microtask), because ai@6 `AbstractChat.makeRequest` corrupts overlapping streams
(A's `finally` reads then nulls the shared `activeResponse`).

**Removed events (scope-cut, internal review):** `RUN_SUPERSEDED` (a ghost feature —
never dispatched; the observer-superseded case is handled by the degraded poll,
which follows the latest rows regardless of runId), `RECONNECT_BEGIN` /
`RECONNECT_ATTEMPT` / `RECONNECT_ATTACHED` / `RECONNECT_NONE` (the live re-attach
ladder was removed — a live drop goes straight to the degraded poll via
`FINISH_DISCONNECT`), and `POLL_ACTIVITY` (the window's activity clock was
removed when the idle-cap moved into the thread). The reducer and this table now
share exactly the dispatched event set.

### 409-code → event map (the real #487 contract consumed here)

| Server response | Event dispatched | error kind → banner |
|---|---|---|
| 409 `A_RUN_ALREADY_ACTIVE` (+ body.activeRunId) | `RUN_ALREADY_ACTIVE{activeRunId}` | run-already-active → "already answering / interrupt & send" |
| 409 `SUPERSEDE_TARGET_MISMATCH` (+ body.activeRunId) | `SUPERSEDE_MISMATCH{currentRunId}` | supersede-mismatch → verify via /run |
| 409 `SUPERSEDE_TIMEOUT` | `SUPERSEDE_TIMEOUT` | supersede-timeout → "couldn't interrupt in time, resend" |
| 409 `SUPERSEDE_INVALID` | `SUPERSEDE_INVALID` | supersede-invalid → "couldn't interrupt this run" |
| 503 `A_RUN_BEGIN_FAILED` | `FINISH_ERROR{begin-failed}` | begin-failed → "could not start, temporary" |

---

## 2. Ref-map — every `chat-thread.tsx` ref → its new home  (MIGRATION RESOLVED)

The migration is COMPLETE: the 13 run-lifecycle FLAGS below are GONE from
`chat-thread.tsx` (collapsed into FSM phase/ctx/effects, or deleted). What remains
are identity/data mirrors, effect-owned controllers/timers, and ONE React-liveness
bit — none of which is a run-lifecycle flag, so the post-merge "no new flags" rule
holds. **Pending column: empty.**

| # | Old ref | Resolved to | Where now |
|---|---|---|---|
| 1 | `reconcileTailRef` | **FSM phase** | reconcile-merge gated on `phase ∈ {polling, stopping}` |
| 2 | `noStreamHandledRef` | **FSM epoch (I1)** | the attach outcome's epoch guard drops the stale/second outcome |
| 3 | `onNoActiveStreamRef` | **FSM event** | transport → `handleAttachOutcome` dispatches `ATTACH_NONE` |
| 4 | `onReconnectAttachedRef` | **FSM event** | transport dispatches `ATTACH_LIVE` |
| 5 | `resumedTurnRef` + `resumedTurn` state | **FSM ctx `ownership`** | `ownership==='observer'` ⇒ never flush; hides "Send now" |
| 6 | `reconnectStateRef` + `reconnectState` state | **DELETED** | the live re-attach ladder was removed; a live drop renders the `polling(disconnect)` banner |
| 7 | `reconnectTimerRef` | **DELETED** | the ladder's backoff timer went with it |
| 8 | `flushOnAbortRef` | **DELETED** | the stop→flush dance is replaced by the CAS supersede (commit 5) |
| 9 | `interruptNextSendRef` | **DELETED** | the server injects the interrupt note from the supersede itself |
| 10 | `supersedeRetryRef` | **DELETED** (commit 5) | the client 409 retry ladder is gone; CAS supersede replaces it |
| 11 | `stopPendingRef` | **FSM phase `stopping`** | the deferred stop fires from the chat-id adoption effect while `stopping` |
| 12 | `mountedRef` | **retained (React liveness)** | orthogonal to run-lifecycle; gates imperative onFinish side-effects post-unmount. Epoch (I1) handles stale COMMAND-outcomes; DISPOSE bumps it |
| 13 | `attemptResumeRef` | **FSM `ATTACH_START` + run-fact** | mount arms attach ONLY on a confirmed active run (commit 4b: streaming-tail status, or POST /run for a user tail) |
| 14–15 | `anchorRef {id, stepsPersisted}` | **data** (attachStrategy) | #491 tail-only: replaced `stripRef`/`strippedRowRef`. The PERSISTED assistant row that pins the run (server invariant 6) + its step frontier N; feeds `?anchor=<id>&n=<stepsPersisted>`. No strip — the seed keeps every row |
| 16 | `attachAbortRef` | **effect-owned controller** | aborted by the `abortAttach` effect in cleanup (I5) |
| 17–25 | `chatIdRef`, `openPageRef`, `getEditorSelectionRef`, `roleIdRef`, `stableIdRef`, `queuedRef`, `sendMessageRef`, `statusRef`, `lastForwardedChatIdRef` | **data** (identity/send mirrors) | unchanged — not lifecycle flags |
| NEW | `pendingSupersedeRef` | **data** (send-plumbing) | the runId injected into the next `POST /stream {supersede}`; the single replacement for the 3 DELETED one-shots (#8/#9/#10) — net −2 refs |
| NEW | `idleCapTimerRef` | **effect-owned timer** | the stalled inactivity cap → `POLL_IDLE_CAP` (commit 4a); not a flag |
| NEW | `turnEpochRef` | **runtime carrier of the epoch (I1)** | holds the generation the CURRENTLY-owned stream started under; STAMPS that stream's async outcomes (chiefly its `onFinish`) so the reducer's epoch filter drops a superseded/dead stream's late finish and it cannot drive the live machine (F1 — the per-owned-stream `turnEpoch` §1 names). Re-set at every honored stream start (local send, mount attach, the supersede B-send). Not a flag |
| NEW | `pendingSupersedeTextRef` | **data** (send-plumbing) + presence-guard | the interrupt-and-send ("Send now") text, stashed when a CAS supersede aborts live stream A, held until A's `onFinish` starts stream B in a microtask (no ai@6 overlap — F1). Non-null is ALSO a presence-guard: it makes a second "Send now" in `sendNow` a no-op while a supersede is in flight, and gates the onFinish B-send branch. Not a lifecycle flag |

Net: the 13 lifecycle flags (#1–#13) are eliminated: **7** → FSM phase/ctx/epoch/event
(#1–#5, #11, #13), **5** deleted (#6/#7 with the reconnect ladder, #8/#9/#10), and
**`mountedRef` (#12)** is retained as React liveness (7 + 5 + 1 = 13).
(`attachAbortRef` (#16) is outside the #1–#13 set — it was already an effect-owned
controller.) One effect-owned timer + one send-plumbing data ref are added — none is
a boolean lifecycle latch.

---

## 3. Run-fact protocol (`runFact: {runId} | null`) — I3

"A run is active" is first-class from the SERVER, not inferred from an assistant
message. Sources, in the order they update `ctx.runFact`:

1. **Init (mount):** `POST /ai-chat/run { chatId }` → `{ run, message }`. A `run`
   with a non-terminal `status` seeds `runFact = { runId: run.id }`; a null/terminal
   run seeds `null`. This is what arms the resume attempt (`ATTACH_START`) — the
   attempt is armed ONLY on a positive fact (commit 4b: a user-tail with no active
   run no longer arms a pointless poll on every open).
2. **Live update:** the `start` stream metadata carries `runId` → `STREAM_START{runId}`.
3. **Attach outcomes:** `ATTACH_LIVE` (2xx) confirms active; a 204 on a non-stripped
   path is an authoritative NEGATIVE fact → the runtime dispatches `RUN_FACT{null}`,
   which cancels recovery (I3 fresh-negative gate).
4. **Poll (#491 transport, #555 S3 consumed):** the degraded poll hits the delta
   endpoint (`POST /ai-chat/messages/delta`), which carries the run fact
   (`run: {id, status} | null`) alongside the changed rows. The client NOW consumes
   that run field (#555 S3, was the review #518 gap): the delta transport
   (`useAiChatDeltaPoll`, in the WINDOW — see the S1 note below) surfaces the fact to
   the thread as the `polledRunFact` prop, and the thread dispatches it as a
   `RUN_FACT` — so a fresh NEGATIVE fact (`run == null` / a terminal status) quenches
   a stale `stopping` immediately and a stale `polling` after merging the persisted
   reply (the fresh-negative gate below), instead of waiting for the terminal ROW to
   merge (`POLL_TERMINAL`). For a NEGATIVE fact while `polling` the thread first reads
   `POST /ai-chat/run` (`getRun`, 10 s deadline) and merges its assistant `message` by
   id — the first delta tick carries the fact but no rows, so a run that finished
   during a drop would otherwise stay truncated — and only then dispatches
   `RUN_FACT{null}`. That dispatch is PHASE-guarded (only while still `polling` or
   `stopping`; the reducer exits both to idle), not epoch-stamped: a Stop pressed
   during the read bumps the epoch yet must still exit `stopping`, and a local send in
   between leaves those phases and drops it. A failed read still settles, with the
   "answer was interrupted" notice; a message queued during `polling(disconnect)` is
   flushed once it settles to idle. For `polling(attach-none|starved)` and `stopping`
   the row-driven `POLL_TERMINAL` settle stays in force as the belt-and-suspenders
   backstop; `polling(disconnect)` settles ONLY on this negative fact (right after a
   drop `initialRows` still ends on the previous turn's settled row, so a row-driven
   settle would kill the poll instantly). The `RUN_FACT` here carries NO epoch: it is
   ambient server truth (a trigger event, never dropped), not a per-generation command
   outcome, and the poll only runs while armed (a poll-bearing recovery) so it never
   races a live local stream.

   **S1 (where the poll transport lives).** An earlier iteration required MOVING the
   poll-query into the thread. It stays in the WINDOW (the `useAiChatDeltaPoll` hook),
   and this is deliberately CORRECT, not drift: the thread's FSM already owns every
   run-lifecycle DECISION — it arms/disarms the poll (`onResumeFallback`) and now
   consumes the run fact (`RUN_FACT`) — while the window/hook is a dumb TRANSPORT
   (cursor + 2.5s timer + idempotent cache merge), symmetric with `initialRows`, which
   the window also fetches and feeds the thread to drive `POLL_TERMINAL`. Keeping the
   transport window-side preserves the clean, unit-tested `onResumeFallback` arm/disarm
   boundary; relocating it would either churn that boundary's tests or leave the prop
   vestigial, for no functional gain — the S3 gap is closed by consuming the fact, not
   by moving the fetch.

Pessimism rule: a stale-but-positive fact PERMITS entering recovery (attach); the
204 then cuts it. A fresh negative fact gates recovery OUT immediately.

---

## 4. Invariants

- **I1 — Epoch (generation counter).** Every command-emitting transition bumps
  `ctx.epoch`; every async outcome event carries its issuing epoch; the reducer
  drops stale-epoch outcomes. Replaces the one-shot-ref zoo (`noStreamHandledRef`,
  the flush/interrupt/supersede one-shots, the `mountedRef` late-callback gate).
- **I2 — Ownership is context, not state.** `local | observer` is orthogonal to the
  transport phase. The queue flushes ONLY under local ownership; an observer
  following a detached run never flushes (was `resumedTurnRef`) — except a follow
  that settles out of `polling(disconnect)`: its queue is flushed on the settle to
  idle (§3.4).
- **I3 — Run-fact is first-class from the server.** A live disconnect recovers (to
  the degraded poll) by the run-fact, not by an assistant message (commit 2). A
  fresh negative fact cancels recovery.
- **I4 — Exit `stopping` by DATA.** A terminal row / negative run-fact / terminal
  finish exits `stopping`, never the stopRun HTTP response (which returns after the
  abort but before finalization — keying off it would unlock the composer on a 409).
- **I5 — Dispose protocol.** Command controllers (attach GET, POST /stream, POST
  /run) are effect-owned and aborted in cleanup (`abortAttach` on `DISPOSE`), not
  render-phase refs. A client abort of an already-sent POST does not cancel the
  server action, so disarming on unmount is safe.
- **attachStrategy** is behind the `resumeStream` effect; #491 swapped it to
  tail-only (`?anchor=&n=`, `anchorRef` data) WITHOUT touching the FSM. It serves
  only the mount-time attach; a live drop never re-attaches.
- **Queue** stays a data structure; flush/interrupt decisions are transitions.
