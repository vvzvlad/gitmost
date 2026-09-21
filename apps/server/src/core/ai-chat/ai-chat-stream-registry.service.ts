import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

/**
 * In-memory run-stream registry (#184 phase 1.5, step-aligned retention #491). A
 * durable agent run tees its SSE frames here (via
 * `pipeUIMessageStreamToResponse({ consumeSseStream })`) so a LATE tab — one that
 * reloaded, or opened after the starter dropped — can attach through
 * `GET /ai-chat/runs/:chatId/stream`, be handed the TAIL past the step it already
 * has persisted, and then follow the live tail as a normal streamer.
 *
 * This is deliberately single-process and best-effort: it holds nothing the DB
 * does not (the run + assistant row are the source of truth), so a process
 * restart simply drops in-flight entries and the client falls back to its
 * restore + degraded-poll path. The async `attach` return type is the seam for a
 * future phase-2 cross-process backend (Redis) — the interface does not change.
 *
 * ── #491 step-aligned retention (the OOM fix) ────────────────────────────────
 * The old registry buffered up to 32MB of raw SSE frames PER active run (V8 ~2×
 * in memory) and, on attach, blasted the WHOLE buffer to the socket synchronously
 * with no drain — a handful of marathon runs on a 1GB container OOM'd. #491 caps
 * the ring at a few MB (env-tunable, default 4MB) and keeps it there by ROTATING:
 *
 *  - Every buffered frame is STAMPED with a step number at tee (see ingestFrame).
 *    Convention: the stamp of a frame is the number of `finish-step` parts seen
 *    BEFORE it (starting at 0). The finish-step frame itself carries the current
 *    value, THEN the counter increments. So a frame stamped `s` is the content of
 *    the (s+1)-th step — 0-based step index `s` — and the stamp aligns EXACTLY
 *    with `metadata.stepsPersisted`: a client whose persisted `stepsPersisted` is
 *    N has steps 0..N-1 on disk (and in its seed) and needs the tail `stamp >= N`.
 *
 *  - The ring rotates ONLY on a CONFIRMED persist of step N
 *    (`confirmPersistedStep`), dropping frames with `stamp < N` (those steps are
 *    now on disk and a fresh client seed carries them). A NON-confirmed step is
 *    never rotated away, so a persist FAILURE just makes the ring cover MORE
 *    (auto-safe). This is the anti-inversion rule: a naive "rotate in .then()"
 *    that rotated after an UNwritten step would drop a step nobody has → silent
 *    hole. Rotation is gated on a real, successful persist.
 *
 *  - If the ring still exceeds its byte cap after rotation (a single fat step, or
 *    a lagging persist), the OLDEST frames are evicted to stay bounded. Evicting a
 *    not-yet-persisted frame opens a GAP: an attach whose N falls at or below an
 *    evicted step answers 204 and the client degrades to restore+poll. The gap is
 *    NOT sticky — the coverage floor is recomputed from the ring, so a later
 *    persist that rotates past the holey steps clears it.
 *
 * ── attach numbering / coverage (the wire convention) ────────────────────────
 * The step marker N comes ONLY FROM THE CLIENT (a query param). The server never
 * reads the row to derive N — a server-side N from a stale seed would open a
 * silent one-step hole. N is the client's persisted `stepsPersisted` (a COUNT):
 *   - the tail it needs = frames with `stamp >= N`;
 *   - coverage is OK ⟺ `coverageFloor(entry) <= N`, where coverageFloor is the
 *     smallest step FULLY present in the ring (its smallest retained stamp, bumped
 *     by one when that leading step was only partially evicted by overflow). If
 *     `coverageFloor > N` the ring starts AFTER the client's frontier (a hole, or
 *     the client's seed simply lagged behind a rotation) → 204 → the client
 *     refetches (a larger N) and re-attaches.
 * The N cutoff is applied in ALL branches, INCLUDING the finished-retained replay.
 *
 * ── same-tick invariants (unchanged, still load-bearing) ─────────────────────
 * invariant 1: only the matching run may mutate/observe an entry (runId check).
 * invariant 2: retention deletes ONLY its own entry (a replacement may own the key).
 * invariant 3: open() over a live entry mirrors the done-path (subscribers released).
 * invariant 4: the tail SLICE + subscriber registration happen in ONE synchronous
 *              tick inside attach() — no await between them — so a concurrently
 *              ingested frame is EITHER in the snapshot (buffered before the sync
 *              block, and the just-added subscriber never sees it) OR fanned out to
 *              the paused subscriber's `pending` (ingested after) — never both and
 *              never neither: no loss, no duplication. NOTE (#491): the controller
 *              now AWAITS the drain-respecting tail write BEFORE calling start(), so
 *              frames ingested during that await accumulate in `pending`; this is
 *              bounded by the subscriber cap (an overflow degrades start() to an
 *              end(), a 204-equivalent). It is the SYNCHRONOUS snapshot+registration
 *              — not a same-tick start() — that makes this correct.
 * invariant 5: the controller wires close-cleanup BEFORE any write.
 * invariant 6: no cross-run replay — the `anchor` (the client's assistant row id)
 *              must match this run's assistant id, or a foreign run's transcript
 *              would be appended to the client's message.
 */

/** How long a finished entry is retained for late attach (replay + immediate end). */
export const RUN_STREAM_RETAIN_FINISHED_MS = 30_000;

/**
 * DEFAULT per-run replay ring cap (#491, down from 32MB). SSE frames carry
 * UNcompacted tool outputs + framing overhead (×1.5–2 vs the persisted parts), so
 * a "2–3 large reads + reasoning" step routinely blows past 2MB; 4MB comfortably
 * holds a step or two of TAIL, which is all a resuming client needs (steps below
 * its persisted frontier come from the seed, not the ring). The ring stays bounded
 * because it rotates on every confirmed persist; this cap is only the ceiling for
 * the un-persisted tail between rotations. Env-tunable via
 * AI_CHAT_RUN_STREAM_MAX_BUFFER_BYTES (bytes); a 0/invalid value falls back to this.
 */
export const AI_CHAT_RUN_STREAM_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

// 2× the ring cap: a just-written full-tail burst alone can never trip the
// per-subscriber cap (see controller); only a genuinely stalled socket can. This
// derivative relationship is preserved even when the ring cap is env-overridden.
export const SUBSCRIBER_MAX_BUFFERED_BYTES = 2 * AI_CHAT_RUN_STREAM_MAX_BUFFER_BYTES;

/**
 * A finish-step boundary frame is exactly `data: {"type":"finish-step"...}\n\n`
 * (verified empirically against ai@6.0.207 — each UI-message-stream part is a
 * single `data: {json}\n\n` event, never split across `data:` lines, and `type`
 * is always the first key). A prefix match is cheaper than JSON.parse-per-frame
 * and has no false positives: a literal `"type":"finish-step"` inside a text
 * delta is JSON-escaped (`\"type\":...`), and the frame would start with
 * `data: {"type":"text-delta"` anyway.
 */
export const FINISH_STEP_FRAME_PREFIX = 'data: {"type":"finish-step"';

/** Resolve the ring cap from the environment, falling back to the default. */
function resolveMaxBufferBytes(): number {
  const raw = process.env.AI_CHAT_RUN_STREAM_MAX_BUFFER_BYTES;
  if (!raw) return AI_CHAT_RUN_STREAM_MAX_BUFFER_BYTES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : AI_CHAT_RUN_STREAM_MAX_BUFFER_BYTES;
}

export interface RunStreamCallbacks {
  onFrame: (frame: string) => void;
  onEnd: () => void;
}

export interface RunStreamAttachment {
  // The synthetic `start` frame (carrying { runId, chatId }) followed by the
  // buffered TAIL filtered to `stamp >= N`. The controller writes these to the
  // socket in chunks respecting drain, then calls start().
  replay: string[];
  finished: boolean;
  start(): void; // drain pending frames (order preserved) and go live
  unsubscribe(): void; // safe to call at any point, idempotent
}

interface Subscriber extends RunStreamCallbacks {
  started: boolean;
  pending: string[];
  // Byte size of `pending`, capped at the subscriber cap. `start()` is called in
  // the SAME tick as `attach()` today, so `pending` never holds more than one
  // microtask of frames — but the controller writes the (potentially large) tail
  // respecting drain BEFORE start(), so a stalled socket can accumulate here; the
  // cap is the structural backstop (an overflow degrades start() to an end()).
  pendingBytes: number;
  overflowed: boolean;
  pendingEnd: boolean;
  // The client's step frontier N: this subscriber only receives frames with
  // `stamp >= minStamp` (the tail past what it already persisted). Live frames
  // always satisfy this (their stamp is the current, highest step), so it only
  // filters the rare out-of-order below-frontier frame.
  minStamp: number;
}

interface Entry {
  runId: string;
  // The persisted assistant row id of this run (set at bind; undefined if the
  // seed failed). Used by the attach anchor check (invariant 6).
  assistantMessageId?: string;
  // Parallel arrays: frames[i] is the SSE string, stamps[i] its step number.
  frames: string[];
  stamps: number[];
  bytes: number;
  // The running step counter used to stamp the NEXT frame (number of finish-step
  // frames seen so far).
  currentStamp: number;
  // The highest confirmed `stepsPersisted`: frames with stamp < persistedFloor are
  // on disk (safe to drop, never re-buffered). Monotonic (confirmPersistedStep).
  persistedFloor: number;
  // The highest stamp EVICTED by an overflow (unsafe) drop, -1 if none. Used to
  // detect a partially-evicted leading step when computing the coverage floor.
  overflowThroughStamp: number;
  // Sticky-for-logging only: at least one unsafe (overflow) eviction happened.
  overflowed: boolean;
  finished: boolean;
  subscribers: Set<Subscriber>;
  retainTimer?: NodeJS.Timeout;
}

@Injectable()
export class AiChatStreamRegistryService implements OnModuleDestroy {
  private readonly logger = new Logger(AiChatStreamRegistryService.name);
  private readonly entries = new Map<string, Entry>(); // key: chatId
  // Env-resolved caps (per instance) so a deployment can tune the ceiling without
  // a code change. The subscriber cap keeps the documented 2× relationship.
  readonly maxBufferBytes = resolveMaxBufferBytes();
  readonly subscriberMaxBufferedBytes = 2 * this.maxBufferBytes;

  /**
   * Register a fresh entry at the START of a run (before any frame), so a tab
   * that attaches in the begin->seed window finds an entry to wait on. If an
   * entry already exists for this chat (a previous, possibly still-live run whose
   * tee loop is draining), it is terminated MIRRORING the done-path (invariant 3)
   * so its subscribers are released and its retention timer is cleared; a late
   * `done` from that old tee then fires against the closed-over old reference and,
   * thanks to identity checks, never touches this new entry.
   */
  open(chatId: string, runId: string): void {
    const existing = this.entries.get(chatId);
    if (existing) {
      if (existing.retainTimer) {
        clearTimeout(existing.retainTimer);
        existing.retainTimer = undefined;
      }
      // Started subscribers get exactly one onEnd() and are removed; paused ones
      // are marked pendingEnd (their start() will end them). finished=true guards
      // any later done from the old tee loop from double-notifying.
      this.terminateSubscribers(existing);
    }
    this.entries.set(chatId, {
      runId,
      frames: [],
      stamps: [],
      bytes: 0,
      currentStamp: 0,
      persistedFloor: 0,
      overflowThroughStamp: -1,
      overflowed: false,
      finished: false,
      subscribers: new Set<Subscriber>(),
    });
  }

  /**
   * Tee a run's SSE frame stream into its entry (called from consumeSseStream).
   * No-op with a warning when there is no entry or the entry belongs to a
   * different run (invariant 1). The reader loop is fire-and-forget: the tee
   * branch outlives the client socket by design.
   */
  bind(
    chatId: string,
    runId: string,
    assistantMessageId: string | undefined,
    stream: ReadableStream<string>,
  ): void {
    const entry = this.entries.get(chatId);
    if (!entry || entry.runId !== runId) {
      // Invariant 1: only the matching run may mutate the entry.
      this.logger.warn(
        `bind: no matching run-stream entry for chat=${chatId} run=${runId}`,
      );
      return;
    }
    entry.assistantMessageId = assistantMessageId;
    const reader = stream.getReader();
    const pump = async (): Promise<void> => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          this.ingestFrame(entry, value);
        }
        this.finalizeEntry(chatId, entry);
      } catch {
        // A read error is a terminal event too — release subscribers.
        this.finalizeEntry(chatId, entry);
      }
    };
    void pump();
  }

  /**
   * Confirm that step `stepsPersisted` (a COUNT: steps 0..stepsPersisted-1) is on
   * disk for this run, and ROTATE the ring: drop the buffered frames of those
   * now-persisted steps (stamp < stepsPersisted). This is the ONLY thing that
   * rotates the ring, and it is called ONLY after a genuinely SUCCESSFUL per-step
   * persist (see ai-chat.service updateStreaming). A failed persist never calls
   * it, so the ring covers more (auto-safe). Identity-checked (invariant 1) and
   * monotonic (a stale lower count is ignored).
   */
  confirmPersistedStep(
    chatId: string,
    runId: string,
    stepsPersisted: number,
  ): void {
    const entry = this.entries.get(chatId);
    if (!entry || entry.runId !== runId) return;
    if (!Number.isFinite(stepsPersisted) || stepsPersisted <= entry.persistedFloor)
      return;
    entry.persistedFloor = stepsPersisted;
    // Clean rotation: drop the persisted steps from the head. These frames are on
    // disk + carried by a fresh client seed, so this NEVER opens a gap.
    while (entry.frames.length > 0 && entry.stamps[0] < stepsPersisted) {
      entry.bytes -= Buffer.byteLength(entry.frames[0]);
      entry.frames.shift();
      entry.stamps.shift();
    }
  }

  /**
   * Terminate a run's entry from the OUTER catch of the stream method (a failure
   * before/while wiring the pipe, so `done` will never arrive). Identity-checked
   * on runId (invariant 1); the shared terminal path is idempotent.
   */
  abortEntry(chatId: string, runId: string): void {
    const entry = this.entries.get(chatId);
    if (!entry || entry.runId !== runId) return;
    this.finalizeEntry(chatId, entry);
  }

  /**
   * Attach to a run's stream from the client's step frontier `n` (its persisted
   * `stepsPersisted`). Async only for the phase-2 Redis seam — the body runs
   * synchronously so the tail SLICE and the subscriber registration happen in ONE
   * tick with no await between them (invariant 4).
   *
   * Returns null (-> the caller answers 204) when:
   *  - there is no entry;
   *  - the `anchor` does not match this run's assistant id (invariant 6);
   *  - the ring does not cover the client's frontier (coverageFloor > n): a hole
   *    from overflow, or the client's seed simply lagged behind a rotation. The
   *    client then refetches (a larger n) and re-attaches.
   *
   * Otherwise the attachment's `replay` is a synthetic `start` frame (the run-fact
   * on re-attach) followed by the buffered tail filtered to `stamp >= n`. For a
   * FINISHED run this is replay-only (no subscriber) and ends after the replay —
   * with n = N_final that tail is just the run's `finish` frame, so the client
   * closes the stream. For a LIVE run a paused subscriber is registered; the
   * caller writes the replay (respecting drain) then calls start() to drain the
   * pending frames and go live.
   */
  async attach(
    chatId: string,
    anchor: string | undefined,
    // The client's persisted step frontier. `null` = a NOT-tail-aware client (no
    // `n` query param) — a legacy/parameterless tab that expects the old
    // "finished -> 204 -> poll" contract; distinct from `0` (a tail-aware client
    // with nothing persisted yet).
    n: number | null,
    cb: RunStreamCallbacks,
  ): Promise<RunStreamAttachment | null> {
    const entry = this.entries.get(chatId);
    if (!entry) return null;
    // Invariant 6: cross-run replay is forbidden. Before bind, assistantMessageId
    // is undefined and mismatches any anchor -> 204 -> client restore+poll path.
    if (anchor && entry.assistantMessageId !== anchor) return null;
    // #491 regression guard (#137/#161 dup): a NOT-tail-aware client (no `n`)
    // resuming a FINISHED run must 204 and poll — the old `finished && !expectLive`
    // gate. Without this, a missing `n` collapsing to frontier 0 would serve the
    // WHOLE tail of a finished, NON-rotated run (coverageFloor 0), and a
    // parameterless client that never stripped its transcript would APPEND that
    // full replay onto the steps it already shows -> duplicated text. A tail-aware
    // client (n present, incl. n=0) still gets the tail past its frontier.
    if (entry.finished && n === null) return null;
    // A finished entry with NOTHING in the ring (aborted before the first frame,
    // or fully overflowed) has no tail to deliver -> 204 -> the client polls.
    if (entry.finished && entry.frames.length === 0) return null;
    // A LIVE run with no `n` (legacy parameterless) replays from step 0 (the old
    // behavior); a tail-aware client resumes from its frontier.
    const frontier = n ?? 0;
    const floor = this.coverageFloor(entry);
    if (floor > frontier) {
      this.logger.warn(
        `run-stream attach gap for run=${entry.runId}: coverageFloor=${floor} ` +
          `> client frontier=${frontier} -> 204 (client refetches + re-attaches)`,
      );
      return null;
    }

    const startFrame = this.buildStartFrame(chatId, entry.runId);
    const sliceTail = (): string[] => {
      const out: string[] = [startFrame];
      for (let i = 0; i < entry.frames.length; i++) {
        if (entry.stamps[i] >= frontier) out.push(entry.frames[i]);
      }
      return out;
    };

    if (entry.finished) {
      // Replay-only: the run is done, no subscriber is registered.
      return {
        replay: sliceTail(),
        finished: true,
        start: () => undefined,
        unsubscribe: () => undefined,
      };
    }

    const sub: Subscriber = {
      onFrame: cb.onFrame,
      onEnd: cb.onEnd,
      started: false,
      pending: [],
      pendingBytes: 0,
      overflowed: false,
      pendingEnd: false,
      minStamp: frontier,
    };
    // Register + snapshot in the SAME synchronous block (invariant 4). No await
    // separates them, so a concurrently ingested frame cannot be lost/duplicated.
    entry.subscribers.add(sub);
    const replay = sliceTail();
    return {
      replay,
      finished: false,
      start: () => {
        if (sub.overflowed) {
          // The pending buffer overflowed while paused: end the stream instead of
          // replaying a partial (a 204-equivalent post-attach degrade).
          try {
            sub.onEnd();
          } catch {
            // The socket is gone; nothing to end.
          }
          entry.subscribers.delete(sub);
          return;
        }
        // Deliver frames buffered while paused, in order, then go live.
        for (const frame of sub.pending) {
          try {
            sub.onFrame(frame);
          } catch {
            entry.subscribers.delete(sub);
            return;
          }
        }
        sub.pending = [];
        sub.started = true;
        if (sub.pendingEnd) {
          try {
            sub.onEnd();
          } catch {
            // The socket is gone; nothing to end.
          }
          entry.subscribers.delete(sub);
        }
      },
      unsubscribe: () => {
        entry.subscribers.delete(sub);
      },
    };
  }

  onModuleDestroy(): void {
    for (const entry of this.entries.values()) {
      if (entry.retainTimer) clearTimeout(entry.retainTimer);
    }
    this.entries.clear();
  }

  /** The synthetic `start` frame the tail is prefixed with — the source of the
   *  run-fact (runId/chatId) on re-attach. A `start` frame does NOT reset the
   *  client's message parts (ai@6.0.207 createStreamingUIMessageState), so it is
   *  safe to prepend even when the sliced tail begins mid-message. */
  private buildStartFrame(chatId: string, runId: string): string {
    return `data: ${JSON.stringify({
      type: 'start',
      messageMetadata: { runId, chatId },
    })}\n\n`;
  }

  /**
   * The smallest step FULLY present in the ring: its smallest retained stamp, or
   * (when the leading step was only partially evicted by an overflow) one past it.
   * When the ring is empty it is the current step (only the live tail is coming).
   * An attach at frontier `n` is covered ⟺ coverageFloor <= n.
   */
  private coverageFloor(entry: Entry): number {
    // Empty ring: only the live tail is coming. The floor is the current step,
    // but never below persistedFloor — a confirmed persist can rotate the ring
    // empty while currentStamp still lags a beat behind on another connection, so
    // max() keeps the invariant STRUCTURAL (a client with n = persistedFloor is
    // always covered) rather than timing-dependent.
    if (entry.frames.length === 0)
      return Math.max(entry.currentStamp, entry.persistedFloor);
    const min = entry.stamps[0];
    return entry.overflowThroughStamp >= min ? min + 1 : min;
  }

  /**
   * Buffer (step-stamped) + fan-out a single frame. The stamp is the number of
   * finish-step frames seen BEFORE this one; a finish-step frame carries the
   * current value and THEN increments the counter (so its stamp equals the 0-based
   * index of the step it closes). Only frames at/above persistedFloor are buffered
   * (already-persisted steps are on disk); the ring is then trimmed to the byte
   * cap, an unsafe eviction opening a gap. Fan-out is always live (filtered per
   * subscriber by its frontier).
   */
  private ingestFrame(entry: Entry, frame: string): void {
    const size = Buffer.byteLength(frame);
    const stamp = entry.currentStamp;
    if (frame.startsWith(FINISH_STEP_FRAME_PREFIX)) {
      entry.currentStamp = stamp + 1;
    }

    // Buffer for replay only if this step is not already persisted+rotated away.
    if (stamp >= entry.persistedFloor) {
      entry.frames.push(frame);
      entry.stamps.push(stamp);
      entry.bytes += size;
      // Enforce the ring cap. Evicting a not-yet-persisted frame (stamp >=
      // persistedFloor) opens a GAP; a leftover persisted frame (< floor) is a
      // safe drop. Keep evicting until the ring is back under the cap.
      while (entry.bytes > this.maxBufferBytes && entry.frames.length > 0) {
        const evStamp = entry.stamps[0];
        entry.bytes -= Buffer.byteLength(entry.frames[0]);
        entry.frames.shift();
        entry.stamps.shift();
        if (evStamp >= entry.persistedFloor) {
          if (evStamp > entry.overflowThroughStamp)
            entry.overflowThroughStamp = evStamp;
          if (!entry.overflowed) {
            entry.overflowed = true;
            this.logger.warn(
              `run-stream ring overflow for run=${entry.runId}: an un-persisted ` +
                `step was evicted to stay under ${this.maxBufferBytes}B; a late ` +
                `attach at an evicted step will 204 until a later persist confirms`,
            );
          }
        }
      }
    }

    // Fan out live, filtered to each subscriber's frontier (a subscriber only
    // wants the tail past the step it already persisted).
    for (const sub of entry.subscribers) {
      if (stamp < sub.minStamp) continue;
      if (sub.started) {
        try {
          sub.onFrame(frame);
        } catch {
          entry.subscribers.delete(sub);
        }
      } else {
        sub.pending.push(frame);
        sub.pendingBytes += size;
        if (sub.pendingBytes > this.subscriberMaxBufferedBytes) {
          // The paused subscriber's buffer overflowed — only possible if start()
          // was delayed (the controller's drain-respecting tail write, or the
          // phase-2 await seam). Drop it rather than buffer the whole run; on
          // start() it degrades to an immediate end (a 204-equivalent).
          sub.overflowed = true;
          sub.pending = [];
          entry.subscribers.delete(sub);
        }
      }
    }
  }

  /**
   * Shared terminal path for done / read-error / external-abort. Idempotent: a
   * second call (already finished) is a no-op, so an open()-replaced or
   * abort-then-done entry is never double-armed or double-ended.
   */
  private finalizeEntry(chatId: string, entry: Entry): void {
    if (entry.finished) return;
    this.terminateSubscribers(entry);
    const timer = setTimeout(() => {
      // Invariant 2: only delete OUR entry (a replacement may already own the key).
      if (this.entries.get(chatId) === entry) this.entries.delete(chatId);
    }, RUN_STREAM_RETAIN_FINISHED_MS);
    timer.unref?.();
    entry.retainTimer = timer;
  }

  /**
   * Mark the entry finished and release its subscribers, mirroring the done-path:
   * started subscribers get exactly one onEnd() and are removed; paused ones are
   * flagged pendingEnd so their start() ends them. Deleting the current element
   * during Set iteration is safe.
   */
  private terminateSubscribers(entry: Entry): void {
    entry.finished = true;
    for (const sub of entry.subscribers) {
      if (sub.started) {
        try {
          sub.onEnd();
        } catch {
          // The socket is gone; nothing to end.
        }
        entry.subscribers.delete(sub);
      } else {
        sub.pendingEnd = true;
      }
    }
  }
}
