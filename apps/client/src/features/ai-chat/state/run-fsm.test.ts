import { describe, it, expect } from "vitest";
import {
  reduce,
  initialMachine,
  type Machine,
  type Effect,
  type Event,
} from "./run-fsm";

// Drive a sequence of events through the reducer, returning the final machine.
function run(m: Machine, ...events: Event[]): Machine {
  return events.reduce(reduce, m);
}
function withRunFact(runId = "run-1"): Machine {
  return {
    ...initialMachine(),
    ctx: { epoch: 0, ownership: "local", runFact: { runId } },
  };
}
function effectTypes(m: Machine): string[] {
  return m.effects.map((e) => e.type);
}
function hasEffect(m: Machine, type: Effect["type"]): boolean {
  return m.effects.some((e) => e.type === type);
}

describe("run-fsm — epoch invariant (I1)", () => {
  it("drops an outcome carrying a stale epoch", () => {
    // A command bumps the epoch; an outcome stamped with the OLD epoch is dropped.
    const m0 = reduce(initialMachine(), { type: "ATTACH_START", runId: "r" }); // epoch 0->1, attaching
    expect(m0.ctx.epoch).toBe(1);
    expect(m0.phase.name).toBe("attaching");
    // A late ATTACH_LIVE from a SUPERSEDED attempt (epoch 0) must NOT drive us.
    const stale = reduce(m0, { type: "ATTACH_LIVE", epoch: 0 });
    expect(stale.phase.name).toBe("attaching");
    expect(stale.effects).toEqual([]);
  });

  it("applies an outcome carrying the current epoch", () => {
    const m0 = reduce(initialMachine(), { type: "ATTACH_START", runId: "r" });
    const live = reduce(m0, { type: "ATTACH_LIVE", epoch: m0.ctx.epoch });
    expect(live.phase.name).toBe("streaming");
  });

  it("an outcome with no epoch is never dropped (trigger events)", () => {
    const m0 = reduce(initialMachine(), { type: "ATTACH_START", runId: "r" });
    const disposed = reduce(m0, { type: "DISPOSE" });
    expect(disposed.phase.name).toBe("idle");
    expect(hasEffect(disposed, "abortAttach")).toBe(true);
  });

  it("every command-transition increments the epoch exactly once", () => {
    let m = initialMachine();
    const before = m.ctx.epoch;
    m = reduce(m, { type: "SEND_LOCAL" });
    expect(m.ctx.epoch).toBe(before + 1);
    m = reduce(m, { type: "STOP_REQUESTED" });
    expect(m.ctx.epoch).toBe(before + 2);
  });
});

describe("run-fsm — local turn", () => {
  it("SEND_LOCAL → sending, local ownership, cancels recovery", () => {
    const m = reduce(withRunFact(), { type: "SEND_LOCAL" });
    expect(m.phase.name).toBe("sending");
    expect(m.ctx.ownership).toBe("local");
    expect(effectTypes(m)).toEqual(expect.arrayContaining(["disarmPoll"]));
  });

  it("STREAM_START adopts the runId into the run-fact and goes streaming", () => {
    const m = run(initialMachine(), { type: "SEND_LOCAL" });
    const s = reduce(m, { type: "STREAM_START", runId: "run-9", epoch: m.ctx.epoch });
    expect(s.phase.name).toBe("streaming");
    expect(s.ctx.runFact).toEqual({ runId: "run-9" });
  });

  it("FINISH_CLEAN → idle, run-fact cleared, poll disarmed", () => {
    const streaming = run(initialMachine(), { type: "SEND_LOCAL" }, { type: "STREAM_START", runId: "r" });
    const done = reduce(streaming, { type: "FINISH_CLEAN" });
    expect(done.phase.name).toBe("idle");
    expect(done.ctx.runFact).toBeNull();
  });
});

// #488 commit 2 — SSE break BEFORE the first assistant frame must still recover.
describe("run-fsm — commit 2: disconnect recovery by run-fact, not by assistant message", () => {
  it("FINISH_DISCONNECT with an active run-fact → polling(disconnect) as observer, no re-attach", () => {
    // Setup-phase break: no assistant frame yet, but a run-fact exists.
    const streaming = withRunFact("run-2");
    const m = reduce(streaming, {
      type: "FINISH_DISCONNECT",
      epoch: streaming.ctx.epoch,
    });
    expect(m.phase).toEqual({ name: "polling", reason: "disconnect" });
    expect(m.ctx.ownership).toBe("observer");
    expect(m.effects).toEqual([{ type: "armPoll", reason: "disconnect" }]);
    expect(hasEffect(m, "resumeStream")).toBe(false);
  });

  it("FINISH_DISCONNECT with NO run-fact → idle (plain connection-lost)", () => {
    const m = reduce(initialMachine(), {
      type: "FINISH_DISCONNECT",
      epoch: 0,
    });
    expect(m.phase.name).toBe("idle");
  });
});

describe("run-fsm — observer drop / incomplete finish fall to the poll", () => {
  it("a MOUNT-attach observer drop falls to the poll", () => {
    let m = reduce(initialMachine(), { type: "ATTACH_START", runId: "r" });
    m = reduce(m, { type: "ATTACH_LIVE", epoch: m.ctx.epoch });
    expect(m.ctx.ownership).toBe("observer");
    m = reduce(m, { type: "FINISH_DISCONNECT", epoch: m.ctx.epoch });
    expect(m.phase).toEqual({ name: "polling", reason: "disconnect" });
    expect(m.ctx.ownership).toBe("observer");
    expect(hasEffect(m, "armPoll")).toBe(true);
  });

  it("STREAM_INCOMPLETE (observer starved/torn finish) → polling", () => {
    let m = reduce(initialMachine(), { type: "ATTACH_START", runId: "r" });
    m = reduce(m, { type: "ATTACH_LIVE", epoch: m.ctx.epoch });
    m = reduce(m, { type: "STREAM_INCOMPLETE", reason: "starved", epoch: m.ctx.epoch });
    expect(m.phase).toEqual({ name: "polling", reason: "starved" });
    expect(hasEffect(m, "armPoll")).toBe(true);
  });
});

// #488 commit 4 — polling stalled-state + user-tail gating.
describe("run-fsm — commit 4: stalled + run-fact gating", () => {
  it("POLL_IDLE_CAP: polling → stalled with a banner (poll disarmed), not silent", () => {
    let m = reduce(withRunFact(), { type: "ATTACH_START", runId: "r" });
    m = reduce(m, { type: "ATTACH_NONE", epoch: m.ctx.epoch });
    expect(m.phase.name).toBe("polling");
    m = reduce(m, { type: "POLL_IDLE_CAP" });
    expect(m.phase.name).toBe("stalled");
    expect(hasEffect(m, "disarmPoll")).toBe(true);
  });

  it("RETRY from stalled re-arms the poll", () => {
    let m = reduce(withRunFact(), { type: "ATTACH_START", runId: "r" });
    m = reduce(m, { type: "ATTACH_NONE", epoch: m.ctx.epoch });
    m = reduce(m, { type: "POLL_IDLE_CAP" });
    m = reduce(m, { type: "RETRY" });
    expect(m.phase.name).toBe("polling");
    expect(hasEffect(m, "armPoll")).toBe(true);
  });

  it("a fresh NEGATIVE run-fact while attaching cancels recovery (user-tail, no active run)", () => {
    // The mount POST /run returns no active run: attaching → idle, no poll armed.
    let m = reduce(withRunFact(), { type: "ATTACH_START", runId: "r" });
    m = reduce(m, { type: "RUN_FACT", runFact: null, epoch: m.ctx.epoch });
    expect(m.phase.name).toBe("idle");
    expect(m.ctx.runFact).toBeNull();
    expect(hasEffect(m, "disarmPoll")).toBe(true);
  });

  it("a negative run-fact while polling stops the poll", () => {
    let m = reduce(withRunFact(), { type: "ATTACH_START", runId: "r" });
    m = reduce(m, { type: "ATTACH_NONE", epoch: m.ctx.epoch });
    m = reduce(m, { type: "RUN_FACT", runFact: null, epoch: m.ctx.epoch });
    expect(m.phase.name).toBe("idle");
  });

  it("POLL_TERMINAL settles polling → idle (I4 data-driven exit)", () => {
    let m = reduce(withRunFact(), { type: "ATTACH_START", runId: "r" });
    m = reduce(m, { type: "ATTACH_NONE", epoch: m.ctx.epoch });
    m = reduce(m, { type: "POLL_TERMINAL" });
    expect(m.phase.name).toBe("idle");
    expect(m.ctx.runFact).toBeNull();
  });
});

// #488 commit 5 — error classification + supersede CAS transitions.
describe("run-fsm — commit 5: supersede CAS + error classification", () => {
  it("SUPERSEDE_REQUESTED → superseding, fires the CAS effect, bumps epoch", () => {
    const streaming = withRunFact("run-old");
    const m = reduce(streaming, { type: "SUPERSEDE_REQUESTED", targetRunId: "run-old" });
    expect(m.phase.name).toBe("superseding");
    expect(m.ctx.epoch).toBe(streaming.ctx.epoch + 1);
    const sup = m.effects.find((e) => e.type === "supersede");
    expect(sup).toEqual({ type: "supersede", targetRunId: "run-old" });
  });

  it("SUPERSEDE_READY → streaming as the new local owner", () => {
    let m = reduce(withRunFact("run-old"), { type: "SUPERSEDE_REQUESTED", targetRunId: "run-old" });
    m = reduce(m, { type: "SUPERSEDE_READY", runId: "run-new", epoch: m.ctx.epoch });
    expect(m.phase.name).toBe("streaming");
    expect(m.ctx.ownership).toBe("local");
    expect(m.ctx.runFact).toEqual({ runId: "run-new" });
  });

  it("SUPERSEDE_MISMATCH → error(supersede-mismatch) + verify via /run (no blind banner)", () => {
    let m = reduce(withRunFact("run-old"), { type: "SUPERSEDE_REQUESTED", targetRunId: "run-old" });
    m = reduce(m, { type: "SUPERSEDE_MISMATCH", currentRunId: "run-x", epoch: m.ctx.epoch });
    expect(m.phase).toEqual({ name: "error", kind: "supersede-mismatch" });
    expect(hasEffect(m, "postRun")).toBe(true);
    expect(m.ctx.runFact).toEqual({ runId: "run-x" });
  });

  it("SUPERSEDE_TIMEOUT → error(supersede-timeout), no auto-retry effect", () => {
    let m = reduce(withRunFact("run-old"), { type: "SUPERSEDE_REQUESTED", targetRunId: "run-old" });
    m = reduce(m, { type: "SUPERSEDE_TIMEOUT", epoch: m.ctx.epoch });
    expect(m.phase).toEqual({ name: "error", kind: "supersede-timeout" });
    expect(m.effects).toEqual([]);
  });

  it("SUPERSEDE_INVALID → error(supersede-invalid)", () => {
    let m = reduce(withRunFact("run-old"), { type: "SUPERSEDE_REQUESTED", targetRunId: "run-old" });
    m = reduce(m, { type: "SUPERSEDE_INVALID", epoch: m.ctx.epoch });
    expect(m.phase).toEqual({ name: "error", kind: "supersede-invalid" });
  });

  it("a stale SUPERSEDE outcome from a superseded epoch is dropped", () => {
    let m = reduce(withRunFact("run-old"), { type: "SUPERSEDE_REQUESTED", targetRunId: "run-old" });
    const supersedingEpoch = m.ctx.epoch;
    // The user retriggers, bumping the epoch again.
    m = reduce(m, { type: "SUPERSEDE_REQUESTED", targetRunId: "run-old" });
    // The first CAS's late TIMEOUT (old epoch) must NOT knock us out of superseding.
    const late = reduce(m, { type: "SUPERSEDE_TIMEOUT", epoch: supersedingEpoch });
    expect(late.phase.name).toBe("superseding");
  });

  it("RUN_ALREADY_ACTIVE (plain POST gate) → error(run-already-active), no retry effect", () => {
    const m = reduce(run(initialMachine(), { type: "SEND_LOCAL" }), { type: "RUN_ALREADY_ACTIVE" });
    expect(m.phase).toEqual({ name: "error", kind: "run-already-active" });
    expect(m.effects).toEqual([]);
  });

  it("#497/S4: RUN_ALREADY_ACTIVE{activeRunId} ADOPTS the server's active run as the run-fact", () => {
    // The server sends `activeRunId` so a later supersede can TARGET that run
    // instead of a blind promote+abort. Absorb it into runFact.
    const m = reduce(run(initialMachine(), { type: "SEND_LOCAL" }), {
      type: "RUN_ALREADY_ACTIVE",
      activeRunId: "run-foreign",
    });
    expect(m.phase).toEqual({ name: "error", kind: "run-already-active" });
    expect(m.ctx.runFact).toEqual({ runId: "run-foreign" });
    expect(m.effects).toEqual([]);
  });

  it("#497/S4: RUN_ALREADY_ACTIVE without an activeRunId keeps the prior run-fact", () => {
    const seeded = reduce(run(initialMachine(), { type: "SEND_LOCAL" }), {
      type: "RUN_FACT",
      runFact: { runId: "run-prior" },
    });
    const m = reduce(seeded, { type: "RUN_ALREADY_ACTIVE" });
    expect(m.ctx.runFact).toEqual({ runId: "run-prior" });
  });
});

// #488 F2 — a late mount `getRun → ATTACH_START` must not hijack a local turn.
describe("run-fsm — F2: ATTACH_START only from idle", () => {
  it("ATTACH_START from a local `sending` turn is ignored (no observer hijack)", () => {
    const sending = reduce(initialMachine(), { type: "SEND_LOCAL" }); // idle -> sending, local
    const m = reduce(sending, { type: "ATTACH_START", runId: "r" });
    expect(m.phase.name).toBe("sending");
    expect(m.ctx.ownership).toBe("local"); // NOT flipped to observer
    expect(m.effects).toEqual([]); // no resumeStream
  });

  it("ATTACH_START from idle attaches as normal", () => {
    const m = reduce(initialMachine(), { type: "ATTACH_START", runId: "r" });
    expect(m.phase.name).toBe("attaching");
    expect(m.ctx.ownership).toBe("observer");
    expect(hasEffect(m, "resumeStream")).toBe(true);
  });
});

describe("run-fsm — stop (I4: exit by data)", () => {
  it("STOP_REQUESTED → stopping, fires stopRun + abortAttach, no data-independent exit", () => {
    const m = reduce(withRunFact(), { type: "STOP_REQUESTED" });
    expect(m.phase.name).toBe("stopping");
    expect(effectTypes(m)).toEqual(expect.arrayContaining(["stopRun", "abortAttach"]));
  });

  it("stopping exits on the aborted stream's finish carrying the PRE-STOP epoch", () => {
    // MEDIUM (#488 re-review): STOP_REQUESTED is a command that BUMPS the epoch, but
    // the runtime stamps the aborted stream's onFinish with the stream's START (pre-
    // stop) generation — exactly what the component sends. `stopping` must HONOR
    // that finish regardless of generation (no idle-cap covers `stopping`).
    // MUTATION-VERIFY: remove the honor-in-`stopping` branch and this hangs in
    // `stopping` (the epoch filter drops the pre-stop finish) -> red.
    const preStopEpoch = withRunFact().ctx.epoch; // E1 (the stream's start epoch)
    let m = reduce(withRunFact(), { type: "STOP_REQUESTED" }); // E1 -> E2, stopping
    expect(m.ctx.epoch).toBe(preStopEpoch + 1);
    m = reduce(m, { type: "FINISH_ABORT", epoch: preStopEpoch }); // NOT the current epoch
    expect(m.phase.name).toBe("idle");
    expect(m.ctx.runFact).toBeNull();
  });

  it("stopping exits on a clean finish carrying the pre-stop epoch too", () => {
    const preStopEpoch = withRunFact().ctx.epoch;
    let m = reduce(withRunFact(), { type: "STOP_REQUESTED" });
    m = reduce(m, { type: "FINISH_CLEAN", epoch: preStopEpoch });
    expect(m.phase.name).toBe("idle");
  });

  it("stopping exits on a negative run-fact (data)", () => {
    let m = reduce(withRunFact(), { type: "STOP_REQUESTED" });
    m = reduce(m, { type: "RUN_FACT", runFact: null, epoch: m.ctx.epoch });
    expect(m.phase.name).toBe("idle");
  });

  // Review #4: `stopping` arms the poll but had no inactivity backstop.
  it("review-4: POLL_IDLE_CAP in `stopping` exits to idle (bounded), NOT stalled", () => {
    let m = reduce(withRunFact(), { type: "STOP_REQUESTED" });
    expect(m.phase.name).toBe("stopping");
    expect(hasEffect(m, "armPoll")).toBe(true);
    // MUTATION-VERIFY: drop the `stopping` branch in POLL_IDLE_CAP and this hangs
    // in `stopping` (poll forever) -> red.
    m = reduce(m, { type: "POLL_IDLE_CAP" });
    expect(m.phase.name).toBe("idle");
    expect(hasEffect(m, "disarmPoll")).toBe(true);
    expect(m.ctx.ownership).toBe("local");
  });
});

// Review #1: positive attach outcomes must be guarded by the SOURCE phase — the
// epoch filter alone is insufficient because POLL_TERMINAL uses to() (no epoch
// bump) and does not abort the in-flight GET.
describe("run-fsm — review-1: attach outcomes guarded by source phase", () => {
  it("a late ATTACH_LIVE / ATTACH_NONE after leaving `attaching` is ignored", () => {
    let m = reduce(initialMachine(), { type: "ATTACH_START", runId: "r" });
    const epoch = m.ctx.epoch;
    m = reduce(m, { type: "ATTACH_NONE", epoch }); // attaching -> polling
    m = reduce(m, { type: "POLL_TERMINAL" }); // -> idle (epoch unchanged)
    expect(m.phase.name).toBe("idle");
    m = reduce(m, { type: "ATTACH_LIVE", epoch }); // late 2xx, same epoch
    expect(m.phase.name).toBe("idle");
    // And a late ATTACH_NONE (not `attaching`) is a no-op too.
    m = reduce(m, { type: "ATTACH_NONE", epoch });
    expect(m.phase.name).toBe("idle");
  });
});

// Review #2: every terminal transition resets ownership to local.
describe("run-fsm — review-2: terminal transitions reset ownership to local", () => {
  const observer = (): Machine => {
    let m = reduce(initialMachine(), { type: "ATTACH_START", runId: "r" });
    m = reduce(m, { type: "ATTACH_LIVE", epoch: m.ctx.epoch });
    expect(m.ctx.ownership).toBe("observer");
    return m;
  };
  it("FINISH_CLEAN resets ownership", () => {
    const m = reduce(observer(), { type: "FINISH_CLEAN", epoch: observer().ctx.epoch });
    expect(m.ctx.ownership).toBe("local");
  });
  it("FINISH_ERROR / POLL_TERMINAL / RUN_FACT(null) reset ownership", () => {
    let o = observer();
    expect(reduce(o, { type: "FINISH_ERROR", kind: "stream", epoch: o.ctx.epoch }).ctx.ownership).toBe("local");
    // POLL_TERMINAL from an observer polling phase
    let p = reduce(observer(), { type: "STREAM_INCOMPLETE", reason: "starved", epoch: observer().ctx.epoch });
    expect(reduce(p, { type: "POLL_TERMINAL" }).ctx.ownership).toBe("local");
    // RUN_FACT(null) from an observer attaching phase
    let a = reduce(initialMachine(), { type: "ATTACH_START", runId: "r" });
    expect(reduce(a, { type: "RUN_FACT", runFact: null, epoch: a.ctx.epoch }).ctx.ownership).toBe("local");
  });
});

describe("run-fsm — ownership (I2) is context, orthogonal to phase", () => {
  it("attach sets observer; send/supersede-ready set local", () => {
    let m = reduce(initialMachine(), { type: "ATTACH_START", runId: "r" });
    expect(m.ctx.ownership).toBe("observer");
    m = reduce(m, { type: "ATTACH_LIVE", epoch: m.ctx.epoch });
    expect(m.phase.name).toBe("streaming");
    expect(m.ctx.ownership).toBe("observer"); // still observing a detached run
    // A local send flips ownership back to local.
    m = reduce(m, { type: "SEND_LOCAL" });
    expect(m.ctx.ownership).toBe("local");
  });
});

describe("run-fsm — dispose (I5)", () => {
  it("DISPOSE from any phase aborts controllers and bumps epoch", () => {
    let m = reduce(withRunFact(), { type: "ATTACH_START", runId: "r" });
    const before = m.ctx.epoch;
    m = reduce(m, { type: "DISPOSE" });
    expect(m.phase.name).toBe("idle");
    expect(m.ctx.epoch).toBe(before + 1);
    expect(effectTypes(m)).toEqual(
      expect.arrayContaining(["abortAttach", "disarmPoll"]),
    );
  });
});
