/**
 * Run-lifecycle finite state machine for a single AI-chat thread (#488).
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ----------------------------------------------------------------------------
 * The resume/reconnect/poll/stop/supersede lifecycle used to be spread across
 * ~26 `useRef` one-shot flags in `chat-thread.tsx`, each disarmed "on every
 * path". Ownerless flag combinations produced silent UI freezes, and every fix
 * added another ref (the #381 -> #432 -> #456 spiral). This module replaces that
 * ref-zoo with ONE pure reducer whose transitions are enumerable and unit-
 * testable in isolation (event x state -> next state is the observable property).
 *
 * The reducer is PURE: it owns no timers, no fetches, no React state. It maps
 * `(machine, event) -> machine`, where the returned machine carries the list of
 * COMMAND EFFECTS to run for that transition. A thin runtime in `chat-thread.tsx`
 * dispatches events (from SDK callbacks / HTTP outcomes) and executes the
 * effects (attach GET, POST /stream, POST /run, POST /stop, backoff timers,
 * poll arm/disarm). The runtime lives in a THREAD, not the window, so a late SDK
 * callback dies with the owner (kills the "event from a dead view" class, #161).
 *
 * ============================================================================
 * INVARIANTS (see run-fsm.spec.md for the full spec + tables)
 * ----------------------------------------------------------------------------
 *  I1  EPOCH (generation counter). Commands (`resumeStream`, `postRun`, `stop`,
 *      `supersede`, `scheduleReconnect`) are async; their outcomes arrive on the
 *      SAME SDK/HTTP callbacks. Every command-emitting transition increments
 *      `ctx.epoch`; every OUTCOME event carries the epoch it was issued under;
 *      the reducer DROPS an outcome whose epoch != the current epoch. This is
 *      what the one-shot-ref zoo used to approximate by hand.
 *  I2  OWNERSHIP is a CONTEXT FIELD (`'local' | 'observer'`), not a state —
 *      orthogonal to the transport phase. The queue is flushed ONLY by a local
 *      owner (an observer following a detached run never flushes).
 *  I3  RUN-FACT ("a run is active") is first-class from the server: `runFact`
 *      holds the server-confirmed active run id (POST /run on mount, the `start`
 *      metadata runId, attach outcomes). Reconnect is entered by the RUN-FACT,
 *      not by the presence of an assistant message (#488 commit 2). A fresh
 *      negative fact (null) cancels reconnect immediately.
 *  I4  Exit `stopping` by DATA (a terminal row / negative run-fact), NEVER by the
 *      stopRun HTTP response (which returns after abort, before finalization).
 *  I5  Command controllers are effect-owned (abort in cleanup), NOT render-phase
 *      refs — expressed here as the `abortAttach` effect on disposing transitions.
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// Phases (the transport lifecycle). Ownership / runFact are CONTEXT, not here.
// ---------------------------------------------------------------------------

/** Why the degraded poll is the active recovery. */
export type PollReason =
  | "attach-none" // mount attach returned 204 / error — nothing live to attach
  | "starved" // a resumed finish carried no visible content
  | "disconnect-visible" // a live disconnect WITH on-screen content — poll to terminal
  | "reconnect-exhausted"; // the live re-attach ladder gave up

/** The classified error kind (drives the banner text + composer behavior). */
export type ErrorKind =
  | "stream" // a generic provider/network stream error (useChat error)
  | "run-already-active" // 409 A_RUN_ALREADY_ACTIVE (a plain POST hit the gate)
  | "supersede-mismatch" // 409 SUPERSEDE_TARGET_MISMATCH (CAS target moved)
  | "supersede-timeout" // 409 SUPERSEDE_TIMEOUT (old run did not settle in W)
  | "supersede-invalid" // 409 SUPERSEDE_INVALID (bad supersede target)
  | "begin-failed"; // 503 A_RUN_BEGIN_FAILED (could not start the run)

export type Phase =
  | { name: "idle" }
  | { name: "sending" } // local POST in flight, before the first frame
  | { name: "streaming" } // receiving frames
  | { name: "attaching" } // mount-time attach GET in flight
  | { name: "reconnecting"; attempt: number; failed: boolean }
  | { name: "polling"; reason: PollReason }
  | { name: "stalled" } // poll hit the inactivity cap — banner + Retry
  | { name: "stopping" }
  | { name: "superseding" }
  | { name: "error"; kind: ErrorKind };

export type Ownership = "local" | "observer";

/** The server-confirmed active run, or null when no run is active. */
export type RunFact = { runId: string } | null;

export interface Ctx {
  /** I1: generation counter — every command-transition increments it. */
  epoch: number;
  /** I2: does THIS client own the turn's writes (local streamer) or observe? */
  ownership: Ownership;
  /** I3: the server-confirmed active run. */
  runFact: RunFact;
  /**
   * Are we FOLLOWING a live run we were locally streaming (the reconnect ladder),
   * as opposed to a one-shot mount-attach resume? Both are `ownership: 'observer'`,
   * but they recover DIFFERENTLY on a drop: a live-follow drop RE-ENTERS the
   * reconnect ladder (#488 commit 3 — the second break after a successful re-attach
   * must reconnect again, not fall to silent poll), while a mount-resume drop falls
   * to the degraded poll. This is the ctx bit that separates the two WITHOUT a new
   * component ref (it is why commit 3 needs the FSM, not a surgical patch).
   */
  liveFollow: boolean;
}

export interface Machine {
  phase: Phase;
  ctx: Ctx;
  /** Command effects to run for the transition that produced THIS machine.
   *  The runtime executes them and does not read them again. */
  effects: Effect[];
}

// ---------------------------------------------------------------------------
// Command effects (the reducer's only side-channel — executed by the runtime).
// ---------------------------------------------------------------------------

export type Effect =
  /** POST /run to (re)establish or verify the run-fact. `reason` is diagnostic. */
  | { type: "postRun"; reason: "mount" | "verify" }
  /** Trigger the SDK `resumeStream()` (attach GET via prepareReconnectToStream). */
  | { type: "resumeStream" }
  /** Schedule a reconnect attempt after a backoff, then dispatch RECONNECT_ATTEMPT. */
  | { type: "scheduleReconnect"; attempt: number; delayMs: number }
  /** Cancel any pending reconnect backoff timer. */
  | { type: "cancelReconnect" }
  /** Arm the degraded poll (the window's dumb timer follows the run in the DB). */
  | { type: "armPoll"; reason: PollReason }
  /** Disarm the degraded poll. */
  | { type: "disarmPoll" }
  /** POST /stop the chat's active run (authoritative detached-run stop). */
  | { type: "stopRun" }
  /** POST /stream { supersede: { runId } } — the CAS "interrupt and send now". */
  | { type: "supersede"; targetRunId: string }
  /** Abort the in-flight attach/reconnect GET controller (dispose / observer stop). */
  | { type: "abortAttach" };

// ---------------------------------------------------------------------------
// Events. An OUTCOME event MAY carry `epoch`; if it does and it does not equal
// the current epoch, the reducer drops it (I1). Trigger events (user actions,
// fresh disconnects) carry no epoch and are never dropped.
// ---------------------------------------------------------------------------

export type Event =
  // -- local turn --
  | { type: "SEND_LOCAL" }
  | { type: "STREAM_START"; runId?: string; epoch?: number }
  /** An OBSERVER's attached stream ended WITHOUT reaching terminal (a starved
   *  clean replay, or a torn resume) — fall to the degraded poll to drive the row
   *  to its real terminal state. (A live-follow drop uses FINISH_DISCONNECT.) */
  | { type: "STREAM_INCOMPLETE"; reason: PollReason; epoch?: number }
  | { type: "FINISH_CLEAN"; epoch?: number }
  | { type: "FINISH_ABORT"; epoch?: number }
  | { type: "FINISH_DISCONNECT"; hasVisibleContent: boolean; epoch?: number }
  | { type: "FINISH_ERROR"; kind: ErrorKind; epoch?: number }
  // -- mount attach (resume) --
  | { type: "ATTACH_START"; runId?: string }
  | { type: "ATTACH_LIVE"; epoch?: number }
  | { type: "ATTACH_NONE"; epoch?: number }
  // -- reconnect after a live disconnect (entered by FINISH_DISCONNECT, #488 c2) --
  | { type: "RECONNECT_ATTEMPT"; attempt: number; epoch?: number }
  | { type: "RECONNECT_ATTACHED"; epoch?: number }
  | { type: "RECONNECT_NONE"; epoch?: number }
  | { type: "RETRY" }
  // -- degraded poll --
  | { type: "POLL_TERMINAL" }
  | { type: "POLL_IDLE_CAP" }
  // -- run-fact (server-confirmed active run) --
  | { type: "RUN_FACT"; runFact: RunFact; epoch?: number }
  // -- stop --
  | { type: "STOP_REQUESTED" }
  // -- supersede (CAS) --
  | { type: "SUPERSEDE_REQUESTED"; targetRunId: string }
  | { type: "SUPERSEDE_READY"; runId?: string; epoch?: number }
  | { type: "SUPERSEDE_MISMATCH"; currentRunId?: string; epoch?: number }
  | { type: "SUPERSEDE_TIMEOUT"; epoch?: number }
  | { type: "SUPERSEDE_INVALID"; epoch?: number }
  | { type: "RUN_ALREADY_ACTIVE"; activeRunId?: string }
  // -- lifecycle --
  | { type: "DISPOSE" };

export const RECONNECT_MAX_ATTEMPTS = 5;
export const RECONNECT_BASE_DELAY_MS = 1000;
/** Backoff before attempt N (1-based): 1s, 2s, 4s, 8s, 16s. */
export function reconnectDelayMs(attempt: number): number {
  return RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1);
}

// ---------------------------------------------------------------------------
// Constructors / helpers.
// ---------------------------------------------------------------------------

export function initialMachine(overrides?: Partial<Ctx>): Machine {
  return {
    phase: { name: "idle" },
    ctx: { epoch: 0, ownership: "local", runFact: null, liveFollow: false, ...overrides },
    effects: [],
  };
}

/** Build a machine result: a phase, optional ctx patch, and effects. Empty
 *  effects by default. Never mutates the input. */
function to(
  m: Machine,
  phase: Phase,
  opts?: { ctx?: Partial<Ctx>; effects?: Effect[] },
): Machine {
  return {
    phase,
    ctx: { ...m.ctx, ...(opts?.ctx ?? {}) },
    effects: opts?.effects ?? [],
  };
}

/** No transition: keep the phase, clear effects (so a re-run does not re-fire). */
function stay(m: Machine): Machine {
  return { phase: m.phase, ctx: m.ctx, effects: [] };
}

/** A command-transition: same as `to` but bumps the epoch (I1). Any outcome
 *  event issued under the old epoch is dropped once this lands. */
function command(
  m: Machine,
  phase: Phase,
  effects: Effect[],
  ctx?: Partial<Ctx>,
): Machine {
  return {
    phase,
    ctx: { ...m.ctx, ...(ctx ?? {}), epoch: m.ctx.epoch + 1 },
    effects,
  };
}

// ---------------------------------------------------------------------------
// The pure reducer.
// ---------------------------------------------------------------------------

/** The terminal stream-finish events (one turn's stream ended). */
function isFinishEvent(event: Event): boolean {
  return (
    event.type === "FINISH_ABORT" ||
    event.type === "FINISH_CLEAN" ||
    event.type === "FINISH_DISCONNECT" ||
    event.type === "FINISH_ERROR" ||
    event.type === "STREAM_INCOMPLETE"
  );
}

export function reduce(m: Machine, event: Event): Machine {
  // MEDIUM (#488 re-review): honor ANY stream finish in `stopping` regardless of
  // generation. A plain user Stop has NO successor stream — the aborted stream's
  // finish IS the expected end of the stop, so exit `stopping -> idle` by that DATA
  // (I4). The epoch filter below must NOT drop it: STOP_REQUESTED bumped the epoch,
  // but the finish carries the PRE-stop generation (the runtime stamps it with the
  // stream's start epoch), so I1 would otherwise strand the machine in `stopping`
  // forever (no idle-cap covers `stopping`). The epoch filter stays in force for
  // `superseding` (a successor B owns) — that is the F1 supersede drop.
  if (m.phase.name === "stopping" && isFinishEvent(event)) {
    return to(m, { name: "idle" }, {
      // Reset ownership to local on this terminal transition (review #2): otherwise
      // an observer-stop leaves ownership 'observer' and hides "Send now" forever.
      ctx: { runFact: null, liveFollow: false, ownership: "local" },
      effects: [{ type: "disarmPoll" }, { type: "cancelReconnect" }],
    });
  }

  // I1: drop a stale outcome (an event issued under a superseded epoch).
  if ("epoch" in event && event.epoch !== undefined && event.epoch !== m.ctx.epoch) {
    return stay(m);
  }

  switch (event.type) {
    // ---- local turn ----------------------------------------------------
    case "SEND_LOCAL":
      // A local send owns the view: leave any recovery, become the local
      // streamer, disarm poll/reconnect. epoch++ so a late recovery outcome
      // from the previous phase is dropped.
      return command(
        m,
        { name: "sending" },
        [{ type: "cancelReconnect" }, { type: "disarmPoll" }],
        { ownership: "local", liveFollow: false },
      );

    case "STREAM_INCOMPLETE":
      // An OBSERVER's attached stream ended incomplete (starved / torn) — follow
      // the run to terminal via the degraded poll.
      return to(m, { name: "polling", reason: event.reason }, {
        effects: [{ type: "armPoll", reason: event.reason }],
      });

    case "STREAM_START": {
      // First frame arrived. Adopt the run-fact runId if present. sending ->
      // streaming; a reconnect/attach that just went live also lands here.
      const runFact = event.runId ? { runId: event.runId } : m.ctx.runFact;
      return to(m, { name: "streaming" }, {
        ctx: { runFact },
        effects: [{ type: "cancelReconnect" }, { type: "disarmPoll" }],
      });
    }

    case "FINISH_CLEAN":
      // A clean terminal outcome. The run is done — clear the run-fact and go
      // idle. (The queue flush is a component concern gated by ownership; the
      // FSM only models the phase.) Review #2: reset ownership to local so a
      // just-finished observer-attach turn re-exposes "Send now" for the queue.
      return to(m, { name: "idle" }, {
        ctx: { runFact: null, liveFollow: false, ownership: "local" },
        effects: [{ type: "disarmPoll" }, { type: "cancelReconnect" }],
      });

    case "FINISH_ABORT":
      // A user Stop / intentional abort finished. If we were stopping, the
      // terminal data has now arrived (I4) — go idle. The run-fact is cleared.
      return to(m, { name: "idle" }, {
        ctx: { runFact: null, liveFollow: false, ownership: "local" },
        effects: [{ type: "disarmPoll" }, { type: "cancelReconnect" }],
      });

    case "FINISH_DISCONNECT":
      // A LIVE SSE drop. Recovery depends on WHO we are (I2 + liveFollow):
      //  - a mount-attach OBSERVER (a one-shot resume, NOT live-follow) that drops
      //    -> the degraded poll drives the row to terminal from the DB.
      if (m.ctx.ownership === "observer" && !m.ctx.liveFollow) {
        return to(m, { name: "polling", reason: "disconnect-visible" }, {
          effects: [{ type: "armPoll", reason: "disconnect-visible" }],
        });
      }
      //  - a LOCAL live turn (first drop) OR a live-follow re-attach (a SUBSEQUENT
      //    drop) -> (re-)enter the reconnect ladder. #488 commit 3: allowed
      //    REPEATEDLY — `liveFollow` is kept across a successful re-attach, so the
      //    second break reconnects again instead of falling to silent poll.
      // #488 commit 2: gated on the RUN-FACT (or an existing live-follow), NOT on
      // the presence of an assistant message — a setup-phase break still recovers.
      //  - visible content already on screen -> keep it, ALSO poll to terminal
      //    (a full replay could clobber the fuller live tail);
      //  - no visible content -> the reconnect ladder rebuilds it.
      if (m.ctx.runFact || m.ctx.liveFollow) {
        const effects: Effect[] = [
          { type: "scheduleReconnect", attempt: 1, delayMs: reconnectDelayMs(1) },
        ];
        if (event.hasVisibleContent) effects.push({ type: "armPoll", reason: "disconnect-visible" });
        return command(m, { name: "reconnecting", attempt: 1, failed: false }, effects, {
          ownership: "observer",
          liveFollow: true,
        });
      }
      // No run to recover: a plain disconnect. Surface the terminal notice.
      return to(m, { name: "idle" }, {
        ctx: { runFact: null, liveFollow: false, ownership: "local" },
      });

    case "FINISH_ERROR":
      return to(m, { name: "error", kind: event.kind }, {
        ctx: { runFact: null, liveFollow: false, ownership: "local" },
        effects: [{ type: "disarmPoll" }, { type: "cancelReconnect" }],
      });

    // ---- mount attach (resume) ----------------------------------------
    case "ATTACH_START":
      // A reopened tab attaches to a still-running run: observer ownership.
      // #488 F2: ONLY from idle. The mount `getRun` round-trip resolves async, and
      // a local send may have started meanwhile (phase `sending`, ownership local);
      // a late ATTACH_START must NOT hijack that local turn into an observer-attach
      // (queue would stop flushing, "Send now" would hide). Guarding in the reducer
      // covers every dispatch source.
      if (m.phase.name !== "idle") return stay(m);
      return command(m, { name: "attaching" }, [{ type: "resumeStream" }], {
        ownership: "observer",
        runFact: event.runId ? { runId: event.runId } : m.ctx.runFact,
      });

    case "ATTACH_LIVE":
      // The attach GET returned a live 2xx stream — follow it as an observer.
      // Review #1: guard by SOURCE phase. The epoch filter alone is not enough — a
      // POLL_TERMINAL uses to() (no epoch bump) and does not abort the in-flight
      // GET, so a slow 2xx landing after the machine already left `attaching` (e.g.
      // the armed poll saw the terminal row -> idle) would resurrect a settled run
      // into a phantom `streaming`. Only enter streaming FROM `attaching`.
      if (m.phase.name !== "attaching") return stay(m);
      return to(m, { name: "streaming" });

    case "ATTACH_NONE":
      // 204 / non-2xx / throw: nothing live to attach. Arm the degraded poll to
      // follow the run to terminal from the DB. This is a soft-negative run-fact
      // (204 on a non-stripped path is authoritative-negative; the runtime may
      // pass a RUN_FACT null separately). Keep the run-fact as-is here.
      // Review #1: guard by source phase for consistency (a late outcome after the
      // machine already left `attaching` must not re-arm a poll).
      if (m.phase.name !== "attaching") return stay(m);
      return to(m, { name: "polling", reason: "attach-none" }, {
        effects: [{ type: "armPoll", reason: "attach-none" }],
      });

    // ---- reconnect after a live disconnect ----------------------------
    case "RECONNECT_ATTEMPT":
      // A scheduled backoff fired — fire the attach GET. epoch++ so the previous
      // attempt's late outcome cannot drive this one.
      if (m.phase.name !== "reconnecting") return stay(m);
      return command(
        m,
        { name: "reconnecting", attempt: event.attempt, failed: false },
        [{ type: "resumeStream" }],
      );

    case "RECONNECT_ATTACHED":
      // #488 commit 3: a live re-attach succeeded. Reset to streaming — the
      // attempt counter is dropped, so a LATER disconnect can start a fresh
      // ladder from attempt 1 (the old one-shot `!wasResumed` gate forbade a
      // second cycle, sending the second break to silent poll).
      // Review #1: guard by SOURCE phase. The armed degraded poll can reach the
      // terminal row (POLL_TERMINAL -> idle, via to(), NO epoch bump, GET not
      // aborted) BEFORE a slow reconnect GET returns 2xx; without this guard that
      // late RECONNECT_ATTACHED (same epoch) would resurrect a settled run into a
      // phantom `streaming`. Only re-enter streaming FROM `reconnecting`.
      if (m.phase.name !== "reconnecting") return stay(m);
      return to(m, { name: "streaming" }, {
        effects: [{ type: "cancelReconnect" }, { type: "disarmPoll" }],
      });

    case "RECONNECT_NONE": {
      // 204 / error during a reconnect attempt. Arm the degraded poll as the
      // belt-and-suspenders fallback, then either back off to the next attempt
      // or, at the cap, surface the manual Retry ("failed").
      if (m.phase.name !== "reconnecting") return stay(m);
      const attempt = m.phase.attempt;
      if (attempt < RECONNECT_MAX_ATTEMPTS) {
        return command(
          m,
          { name: "reconnecting", attempt: attempt + 1, failed: false },
          [
            { type: "armPoll", reason: "attach-none" },
            { type: "scheduleReconnect", attempt: attempt + 1, delayMs: reconnectDelayMs(attempt + 1) },
          ],
        );
      }
      return to(m, { name: "reconnecting", attempt, failed: true }, {
        effects: [{ type: "armPoll", reason: "reconnect-exhausted" }],
      });
    }

    case "RETRY":
      // Manual Retry from the "failed" reconnect banner OR the stalled banner.
      if (m.phase.name === "reconnecting" && m.phase.failed) {
        return command(
          m,
          { name: "reconnecting", attempt: 1, failed: false },
          [{ type: "resumeStream" }],
        );
      }
      if (m.phase.name === "stalled") {
        // Re-arm the poll to try to catch the run up again.
        return command(m, { name: "polling", reason: "attach-none" }, [
          { type: "armPoll", reason: "attach-none" },
        ]);
      }
      return stay(m);

    // ---- degraded poll -------------------------------------------------
    case "POLL_TERMINAL":
      // The run reached a terminal row via the poll (or the reconcile merge). Go
      // idle and disarm everything (I4: this is a DATA-driven exit, incl. exit
      // from `stopping`). Review #2: reset ownership to local.
      return to(m, { name: "idle" }, {
        ctx: { runFact: null, liveFollow: false, ownership: "local" },
        effects: [{ type: "disarmPoll" }, { type: "cancelReconnect" }],
      });

    case "POLL_IDLE_CAP":
      // Review #4: `stopping` also arms the poll (STOP_REQUESTED) but has NO other
      // backstop — an observer-stop with no SDK stream to fire onFinish, whose
      // server stop never drives the run terminal, would poll the DB forever. Give
      // it a bounded exit: cap -> idle + disarm (NOT `stalled`; Stop was already
      // pressed, so there is nothing for the user to retry).
      if (m.phase.name === "stopping") {
        return to(m, { name: "idle" }, {
          ctx: { runFact: null, liveFollow: false, ownership: "local" },
          effects: [{ type: "disarmPoll" }, { type: "cancelReconnect" }],
        });
      }
      // #488 commit 4a: the poll hit the inactivity cap. Instead of going SILENT
      // (the old "forever half-done answer"), surface a stalled banner + Retry.
      if (m.phase.name !== "polling" && m.phase.name !== "reconnecting") return stay(m);
      return to(m, { name: "stalled" }, {
        effects: [{ type: "disarmPoll" }, { type: "cancelReconnect" }],
      });

    // ---- run-fact ------------------------------------------------------
    case "RUN_FACT": {
      const runFact = event.runFact;
      // A fresh NEGATIVE fact (no active run) cancels recovery immediately (I3):
      // there is nothing to reconnect to / poll for.
      if (!runFact) {
        if (
          m.phase.name === "reconnecting" ||
          m.phase.name === "attaching" ||
          m.phase.name === "polling" ||
          m.phase.name === "stopping"
        ) {
          return to(m, { name: "idle" }, {
            // Review #2: reset ownership to local on this terminal transition.
            ctx: { runFact: null, liveFollow: false, ownership: "local" },
            effects: [{ type: "cancelReconnect" }, { type: "disarmPoll" }],
          });
        }
        return to(m, m.phase, { ctx: { runFact: null } });
      }
      // A positive fact just updates the context (pessimism toward an attempt: a
      // stale-but-positive fact permits entering recovery; a 204 will cut it).
      return to(m, m.phase, { ctx: { runFact } });
    }

    // ---- stop ----------------------------------------------------------
    case "STOP_REQUESTED":
      // Authoritative stop of a detached run. Enter `stopping` and fire stopRun +
      // abort the local/attach reader. ALSO arm the poll so the terminal row is
      // observed — the exit is by DATA (I4: a terminal row / negative run-fact),
      // never by the stopRun HTTP response (which returns after abort, before
      // finalization). For a local turn the aborted stream's onFinish (ANY finish)
      // is HONORED in `stopping` at the top of reduce() — regardless of generation
      // — and exits to idle; the armed poll is the fallback for an observer stop
      // with no local onFinish.
      return command(
        m,
        { name: "stopping" },
        [
          { type: "stopRun" },
          { type: "abortAttach" },
          { type: "cancelReconnect" },
          { type: "armPoll", reason: "attach-none" },
        ],
      );

    // ---- supersede (CAS) ----------------------------------------------
    case "SUPERSEDE_REQUESTED":
      // "Interrupt and send now": CAS POST /stream { supersede }. epoch++ so a
      // late outcome of the interrupted run is dropped.
      return command(
        m,
        { name: "superseding" },
        [{ type: "supersede", targetRunId: event.targetRunId }, { type: "cancelReconnect" }, { type: "disarmPoll" }],
      );

    case "SUPERSEDE_READY": {
      // CAS succeeded (old run stopped/settled, slot taken, new run begun). We
      // are now the local streamer of the NEW run. Adopt its runId if provided.
      const runFact = event.runId ? { runId: event.runId } : m.ctx.runFact;
      return to(m, { name: "streaming" }, {
        ctx: { ownership: "local", runFact, liveFollow: false },
      });
    }

    case "SUPERSEDE_MISMATCH":
      // The active run moved between the click and the CAS. Per the spec: verify
      // via /run rather than blindly banner — the mismatch may be our own already-
      // superseded run. Surface a classified error AND fire a run-fact verify.
      return to(m, { name: "error", kind: "supersede-mismatch" }, {
        ctx: { runFact: event.currentRunId ? { runId: event.currentRunId } : m.ctx.runFact },
        effects: [{ type: "postRun", reason: "verify" }],
      });

    case "SUPERSEDE_TIMEOUT":
      // The old run did not settle within W. Nothing persisted; the composer keeps
      // its text. Classified error, NO auto-retry (the old client retry ladder is
      // removed in #488 commit 5).
      return to(m, { name: "error", kind: "supersede-timeout" });

    case "SUPERSEDE_INVALID":
      return to(m, { name: "error", kind: "supersede-invalid" });

    case "RUN_ALREADY_ACTIVE":
      // A plain POST hit the one-active-run gate. NO auto-retry — the composer
      // offers "interrupt and send" (supersede) instead. #497/S4: adopt the
      // server's activeRunId as the run-fact so that supersede can TARGET the
      // (possibly foreign-tab) active run via the CAS, rather than a blind
      // promote+abort that just 409s again. A stale/absent id keeps the prior fact.
      return to(m, { name: "error", kind: "run-already-active" }, {
        ctx: { runFact: event.activeRunId ? { runId: event.activeRunId } : m.ctx.runFact },
      });

    // ---- lifecycle -----------------------------------------------------
    case "DISPOSE":
      // Unmount: abort in-flight controllers, drop timers, and bump the epoch so
      // NO late callback can drive this (now dead) machine (I5).
      return command(
        m,
        { name: "idle" },
        [
          { type: "abortAttach" },
          { type: "cancelReconnect" },
          { type: "disarmPoll" },
        ],
        { liveFollow: false },
      );

    default: {
      // Exhaustiveness guard.
      const _never: never = event;
      void _never;
      return stay(m);
    }
  }
}
