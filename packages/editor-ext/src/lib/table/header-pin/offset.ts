// Pin-offset measurement and watcher used by the table header-pin controller.

import { OscillationLatch } from './oscillation-latch';

// Fallback app-bar height (px) when no fixed surface is mounted; matches global-app-shell.tsx.
const APP_BAR_FALLBACK_HEIGHT = 45;

export const EDITOR_PIN_OFFSET_VAR = '--editor-pin-offset';

// Selectors for fixed surfaces between viewport top and editor content. Use data attributes —
// CSS module classes are build-time hashed and won't match.
const PIN_ANCHOR_SELECTORS = [
  '[data-page-header]',
  '[data-fixed-toolbar]',
] as const;

// Republish oscillation budget. Even with a narrow observation set (see the
// watcher below) a genuinely bistable geometry must not be able to spin forever
// (repo invariant #2: everything long-running terminates by construction). Same
// shape as the fit-detection latch in controller.ts, via the shared
// OscillationLatch.
//
// What counts as evidence matters as much as the budget. Only a value that
// RETURNS to one published a moment ago (A->B->A) is oscillation; a strictly
// new value is not. This mirrors the controller latch, which counts only
// native<->fallback flips and ignores eligibility transitions for the same
// reason. Without the discrimination an ordinary page load — 45 (no anchors
// yet) -> 90 (header mounts) -> 135 (toolbar mounts) -> 137 (web fonts land) ->
// … — would trip the latch after seven perfectly healthy settling steps and
// freeze the offset far from the truth.
const PIN_OFFSET_RECENT_VALUES = 3;
const PIN_OFFSET_PUBLISH_LIMIT = 6;
const PIN_OFFSET_PUBLISH_WINDOW_MS = 1000;
const PIN_OFFSET_LATCH_COOLDOWN_MS = 30_000;
const PIN_OFFSET_LATCH_GIVE_UP_COUNT = 3;

function latchOptions() {
  return {
    limit: PIN_OFFSET_PUBLISH_LIMIT,
    windowMs: PIN_OFFSET_PUBLISH_WINDOW_MS,
    cooldownMs: PIN_OFFSET_LATCH_COOLDOWN_MS,
    giveUpCount: PIN_OFFSET_LATCH_GIVE_UP_COUNT,
  };
}

// Resolves the currently mounted pin anchors. They mount and unmount over the
// page's life — the fixed toolbar only exists in edit mode, the page header can
// re-render — so this is re-run on every publish rather than cached at acquire
// time.
export function resolvePinAnchors(): HTMLElement[] {
  const anchors: HTMLElement[] = [];
  for (const sel of PIN_ANCHOR_SELECTORS) {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (el) anchors.push(el);
  }
  return anchors;
}

export function computePinTop(anchors?: HTMLElement[]): number {
  let bottom = APP_BAR_FALLBACK_HEIGHT;
  for (const el of anchors ?? resolvePinAnchors()) {
    const rect = el.getBoundingClientRect();
    if (rect.height > 0 && rect.bottom > bottom) bottom = rect.bottom;
  }
  // Quantize to whole pixels. getBoundingClientRect().bottom is a float, and the
  // pinned/transformed header row keeps nudging the anchor rect by sub-pixel
  // amounts. Without rounding, publish()'s `top === lastValue` dedupe below never
  // holds, so every observer tick rewrites --editor-pin-offset on
  // documentElement. That write is expensive in EVERY engine: an inherited custom
  // property set on the root invalidates the computed style of the whole
  // document. Here it costs more still, because the property is the `top`
  // constraint of every `position: sticky` header row on the page, so each write
  // also forces every sticky constraint to be re-evaluated — feeding the very
  // layout jitter that triggered the tick. Rounding only defeats SUB-pixel
  // jitter; a whole-pixel oscillation is handled by the latch below, not by
  // quantizing harder.
  return Math.round(bottom);
}

function sameAnchors(a: HTMLElement[], b: HTMLElement[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Reference-counted watcher that publishes the editor's top offset to a CSS custom property.
//
// OBSERVATION SCOPE (the regression that must never come back): this observes
// ONLY the resolved pin anchors. It must never observe `document.body` or
// `document.documentElement`. Observing the body closed a feedback loop that
// burned 100% CPU on an idle Safari page: writing the inherited custom property
// on `documentElement` invalidates the whole document's style, relayout changes
// the body box, the body ResizeObserver fires, the header is re-measured, the
// rounded value comes back one pixel different, and it publishes again. Blink
// damps this with its ResizeObserver loop-breaker; WebKit does not. The anchors
// are `position: fixed` surfaces whose boxes do not depend on document height,
// so observing them cannot be re-entered by the property write.
//
// Viewport-driven changes (a window resize reflows the fixed anchors) come from
// the `resize` EVENT rather than an observer: an event listener cannot be
// re-entered by a style write, so it cannot close the cycle either. Anchor
// mount/unmount is picked up by re-resolving on every publish plus the explicit
// `sync()` the editor plugin calls on view updates — no polling timer.
//
// KNOWN, ACCEPTED GAP: if an anchor NODE is replaced (a route change, a header
// remount) without resizing anything and without any ProseMirror transaction,
// the offset can stay stale until the next tick from any source. Closing that
// would require watching the document for structural changes — exactly the
// body-level observation that caused the 100%-CPU loop — so we accept it: the
// worst case is a pinned header row sitting a few pixels off until the user
// scrolls, types, or resizes.
export const pinOffsetWatcher = {
  refs: 0,
  resizeObserver: null as ResizeObserver | null,
  observedAnchors: [] as HTMLElement[],
  windowResizeListener: null as (() => void) | null,
  rafPending: false,
  rafHandle: null as number | null,
  lastValue: -1,
  // The last few PUBLISHED values, newest last. A computed value that is already
  // in here is a return, i.e. oscillation evidence — see the budget comment above.
  recentValues: [] as number[],
  latch: new OscillationLatch(latchOptions()),

  acquire() {
    if (this.refs++ > 0) return;
    this.resizeObserver = new ResizeObserver(() => this.schedule());
    this.windowResizeListener = () => this.schedule();
    window.addEventListener('resize', this.windowResizeListener, {
      passive: true,
    });
    this.publish();
  },

  release() {
    // Floor at zero. An unbalanced release would otherwise make refs negative,
    // and the next acquire() would pass its `refs++ > 0` guard while leaving
    // refs at 0 — so a later acquire() would build a SECOND ResizeObserver,
    // overwrite the reference, and leak the first one.
    if (this.refs <= 0) return;
    if (--this.refs > 0) return;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.observedAnchors = [];
    if (this.windowResizeListener) {
      window.removeEventListener('resize', this.windowResizeListener);
      this.windowResizeListener = null;
    }
    // Cancel any queued frame: it would otherwise re-write the property we are
    // about to remove, leaving a stale offset on :root with no consumer.
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = null;
    this.rafPending = false;
    document.documentElement.style.removeProperty(EDITOR_PIN_OFFSET_VAR);
    this.lastValue = -1;
    this.recentValues = [];
    // Fresh latch for the next pinning session: the give-up budget is scoped to
    // one continuous stretch of pinning, not to the tab's whole lifetime.
    this.latch = new OscillationLatch(latchOptions());
  },

  schedule() {
    if (this.rafPending) return;
    this.rafPending = true;
    this.rafHandle = requestAnimationFrame(() => {
      this.rafPending = false;
      this.rafHandle = null;
      // release() may have run between the schedule and the frame.
      if (this.refs <= 0) return;
      this.publish();
    });
  },

  // Re-resolve the anchor set and re-bind the ResizeObserver to it. Anchors are
  // not assumed to exist at acquire() time.
  syncAnchors(): HTMLElement[] {
    const anchors = resolvePinAnchors();
    if (!this.resizeObserver) return anchors;
    if (sameAnchors(anchors, this.observedAnchors)) return anchors;
    this.resizeObserver.disconnect();
    for (const el of anchors) this.resizeObserver.observe(el);
    this.observedAnchors = anchors;
    return anchors;
  },

  // Public tick for callers that know the anchor set may have changed (the
  // editor plugin calls it on view updates: the fixed toolbar mounts/unmounts
  // with edit mode). A no-op while nothing consumes the value.
  //
  // It only SCHEDULES: callers run inside ProseMirror's update cycle, where the
  // DOM was just written and a getBoundingClientRect() would force a synchronous
  // relayout. The rAF callback runs before paint, so coalescing is visually
  // equivalent, and a burst of transactions costs one frame thanks to the
  // rafPending dedupe in schedule().
  sync() {
    if (this.refs <= 0) return;
    this.schedule();
  },

  publish() {
    // Guard: publish() is reachable from the exported object, and writing the
    // property with no watcher running would leave a value on :root that nothing
    // will ever remove.
    if (this.refs <= 0) return;

    const top = computePinTop(this.syncAnchors());
    if (top === this.lastValue) return;

    if (this.latch.latched) {
      // Lazy cooldown, evaluated on a tick we already have: no timer.
      if (!this.latch.maybeRelease()) return;
      // Start the evidence window over: values published before the latch say
      // nothing about the geometry now.
      this.recentValues = [];
    }

    // WRITE FIRST, latch after. If this turns out to be the value that trips the
    // latch, the frozen offset is the one just computed, not the stale previous
    // one — a settling page must never get stuck at, say, 45px when the truth is
    // 135px.
    const isReturn = this.recentValues.includes(top);
    this.lastValue = top;
    document.documentElement.style.setProperty(
      EDITOR_PIN_OFFSET_VAR,
      `${top}px`,
    );
    this.recentValues.push(top);
    if (this.recentValues.length > PIN_OFFSET_RECENT_VALUES) {
      this.recentValues.shift();
    }

    // Only a value that came BACK is oscillation; a monotonic settling sequence
    // is not, and must not be able to trip the latch.
    if (!isReturn) return;

    if (this.latch.note()) {
      const { latchCount, gaveUpNow } = this.latch.latch();
      const preamble =
        '[table-header-pin] pin offset oscillated (>' +
        PIN_OFFSET_PUBLISH_LIMIT +
        ' returns to a recently published value in ' +
        PIN_OFFSET_PUBLISH_WINDOW_MS +
        'ms) — freezing ' +
        EDITOR_PIN_OFFSET_VAR +
        ' at ' +
        this.lastValue +
        'px, the last computed value. Pinned header rows keep working at that ' +
        'offset; it may be off by however far the geometry was flapping. ';
      if (this.latch.gaveUp) {
        // Announce the give-up exactly once, like the controller latch does.
        if (gaveUpNow) {
          console.warn(
            preamble +
              'This is latch #' +
              latchCount +
              ', so republishing will not be retried again for this pinning ' +
              'session (it resumes the next time a table starts pinning).',
          );
        }
      } else {
        console.warn(
          preamble +
            'Republishing is retried ' +
            PIN_OFFSET_LATCH_COOLDOWN_MS +
            'ms from now, on the next tick that computes a different value.',
        );
      }
    }
  },
};
