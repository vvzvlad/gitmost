// Shared oscillation fail-safe for the header-pin stack.
//
// The stack has TWO independent feedback loops that can, under an unlucky
// geometry, drive each other forever:
//
//  1. `TablePinController`'s fit detection: `setMode('native')` toggles
//     `tableWrapperNoOverflow` on the wrapper, and the wrapper is the fit
//     IntersectionObserver's own root, so the write can re-fire the observer.
//  2. `pinOffsetWatcher`'s republish: writing an inherited custom property on
//     `documentElement` invalidates the whole document's computed style, which
//     can nudge the measured anchor rect and produce a different value.
//
// Both need the same structure — count events in a window, latch past a budget,
// retry after a fixed cooldown, and give up permanently after N latches — so the
// counting/latching/cooldown bookkeeping lives here ONCE instead of being
// mirrored (repo invariant #7: no hand-synced copies). The *policy* (constants,
// what latching does, what the warning says) stays with each caller.

export function monotonicNow(): number {
  return typeof performance !== 'undefined' &&
    typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export interface OscillationLatchOptions {
  // Events allowed inside one window; the next one trips the latch.
  limit: number;
  windowMs: number;
  // How long a latch holds before a retry is allowed. This is a FIXED COOLDOWN,
  // not a "geometry settled" detector: while latched the loop is not running, so
  // there is nothing to measure quiet against — we simply assume that whatever
  // transient geometry caused the flapping is over by then. It is evaluated
  // lazily from ticks the caller already has, so it needs no timer.
  cooldownMs: number;
  // Latches after which retrying is abandoned for the life of this latch object.
  giveUpCount: number;
}

export class OscillationLatch {
  latched = false;
  latchCount = 0;
  gaveUp = false;

  private count = 0;
  // null (not 0) is the "no window open" sentinel: monotonicNow() can legitimately
  // return 0, and a 0 sentinel would reopen the window on every event and disable
  // the latch entirely.
  private windowStart: number | null = null;
  private latchedAt = 0;

  constructor(private readonly opts: OscillationLatchOptions) {}

  // Records one oscillation event. Returns true when it crosses the budget, i.e.
  // the caller should latch.
  note(): boolean {
    const now = monotonicNow();
    if (
      this.windowStart === null ||
      now - this.windowStart > this.opts.windowMs
    ) {
      this.windowStart = now;
      this.count = 0;
    }
    this.count += 1;
    return this.count > this.opts.limit;
  }

  // Enters the latched state. `gaveUpNow` is true only on the FIRST transition
  // into the give-up state, so the caller can announce it exactly once even if
  // the latch is later cleared and re-entered.
  latch(): { latchCount: number; gaveUpNow: boolean } {
    this.latched = true;
    this.latchedAt = monotonicNow();
    this.latchCount += 1;
    const spent = this.latchCount >= this.opts.giveUpCount;
    const gaveUpNow = spent && !this.gaveUp;
    if (spent) this.gaveUp = true;
    return { latchCount: this.latchCount, gaveUpNow };
  }

  // Clears the latched state WITHOUT touching latchCount/gaveUp, so the retry
  // budget stays spent for the life of this latch object.
  unlatch() {
    this.latched = false;
    this.count = 0;
    this.windowStart = null;
  }

  // Lazy cooldown check: call it from a tick the caller already has. Returns true
  // only when it actually released the latch, so the caller can re-arm whatever
  // it tore down.
  maybeRelease(): boolean {
    if (!this.latched) return false;
    if (this.gaveUp) return false;
    if (monotonicNow() - this.latchedAt < this.opts.cooldownMs) return false;
    this.unlatch();
    return true;
  }
}
