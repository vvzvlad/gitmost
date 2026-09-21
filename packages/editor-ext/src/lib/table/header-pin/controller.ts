// Per-table header-pin controller: native sticky when table fits its wrapper, transform fallback when it doesn't.

import { computePinTop, pinOffsetWatcher } from './offset';
import { OscillationLatch } from './oscillation-latch';

const WRAPPER_NO_OVERFLOW = 'tableWrapperNoOverflow';
const HEADER_PINNED = 'tableHeaderPinned';
const PIN_OFFSET_VAR = '--table-pin-offset';

// Oscillation fail-safe. `setMode('native')` toggles `tableWrapperNoOverflow`, which
// switches the wrapper between `overflow-x: auto` and `overflow: visible` — and the
// wrapper is the fit observer's own root, so the write can change containment and
// re-fire the observer. Under a hair-trigger geometry (typically a reserved classic
// scrollbar exactly straddling the threshold) the two modes can chase each other
// forever.
//
// ONLY `native <-> fallback` transitions count as oscillation evidence: they are the
// ones driven by the overflow toggle. Transitions to/from `off` come from the
// eligibility check (nested table, header row no longer all-<th>) and are not part of
// the feedback loop, so counting them would let an unrelated structural edit trip the
// latch. The budget is therefore exactly PIN_MODE_FLIP_LIMIT native<->fallback flips
// inside the window; the next one latches.
const PIN_MODE_FLIP_LIMIT = 6;
const PIN_MODE_FLIP_WINDOW_MS = 1000;
// A latch is a degraded state, so it needs an exit. This is a FIXED COOLDOWN, not a
// "geometry settled" detector: while latched no flip can even be attempted (apply()
// is gated and the observer is disconnected), so there is nothing to measure quiet
// against — we simply retry native sticky this long after latching, on the
// assumption that whatever transient geometry caused the flapping (a splitter drag,
// a column resize parking the width on the bistable point) is over.
// Evaluated lazily from two paths that already run — refresh() on doc changes, and
// updateFallbackOffset() on scroll frames — so no timer and no extra observer. The
// scroll path is what makes the cooldown work on a read-only page, where the doc
// never changes but the user still scrolls the long table.
const PIN_LATCH_COOLDOWN_MS = 30_000;
// If a table keeps re-latching after each cooldown its geometry is genuinely
// bistable, so retrying forever would just log forever. After this many latches we
// stop retrying for the life of this controller and say so once.
const PIN_LATCH_GIVE_UP_COUNT = 3;

type PinMode = 'off' | 'native' | 'fallback';

function firstRowIsAllHeaders(row: HTMLTableRowElement | null): boolean {
  if (!row) return false;
  const cells = Array.from(row.cells);
  return cells.length > 0 && cells.every((c) => c.tagName === 'TH');
}

function isNestedTable(wrapper: HTMLElement): boolean {
  return wrapper.closest('table .tableWrapper') !== null;
}

function isLayoutInert(rect: DOMRectReadOnly): boolean {
  return rect.width === 0 && rect.height === 0;
}

const fallbackControllers = new Set<TablePinController>();
let fallbackScrollListener: (() => void) | null = null;
let fallbackRafPending = false;

function ensureFallbackListener() {
  if (fallbackScrollListener) return;
  fallbackScrollListener = () => {
    if (fallbackRafPending) return;
    fallbackRafPending = true;
    requestAnimationFrame(() => {
      fallbackRafPending = false;
      for (const ctrl of fallbackControllers) ctrl.updateFallbackOffset();
    });
  };
  document.addEventListener('scroll', fallbackScrollListener, {
    passive: true,
    capture: true,
  });
}

function maybeTeardownFallbackListener() {
  if (!fallbackScrollListener || fallbackControllers.size > 0) return;
  document.removeEventListener('scroll', fallbackScrollListener, {
    capture: true,
  });
  fallbackScrollListener = null;
  fallbackRafPending = false;
}

export class TablePinController {
  private wrapper: HTMLElement;
  private table: HTMLTableElement;
  private fitsObserver?: IntersectionObserver;
  private mode: PinMode = 'off';
  private cachedHeaderRow: HTMLTableRowElement | null = null;
  private pendingEntry: IntersectionObserverEntry | null = null;
  private evaluateRafPending = false;
  private evaluateRaf: number | null = null;
  // Fit-detection oscillation fail-safe. Shares its implementation with the
  // pin-offset republish latch (see oscillation-latch.ts) so the two read the
  // same; only the constants and the latch's effect differ.
  private latch = new OscillationLatch({
    limit: PIN_MODE_FLIP_LIMIT,
    windowMs: PIN_MODE_FLIP_WINDOW_MS,
    cooldownMs: PIN_LATCH_COOLDOWN_MS,
    giveUpCount: PIN_LATCH_GIVE_UP_COUNT,
  });
  // True while this controller holds a pinOffsetWatcher reference. The reference
  // is tied to being in a PINNING MODE, not to the controller's lifetime: nothing
  // consumes --editor-pin-offset unless some table is actually pinned (its only
  // consumer is the `top:` of `.tableWrapperNoOverflow.tableHeaderPinned` rows in
  // table.css, which has a `var(..., 90px)` fallback), so an unpinned page must
  // not be paying for a watcher at all.
  private pinOffsetHeld = false;
  private destroyed = false;

  constructor(wrapper: HTMLElement, table: HTMLTableElement) {
    this.wrapper = wrapper;
    this.table = table;
    this.fitsObserver = new IntersectionObserver(
      (entries) => {
        // Never write style synchronously from inside this callback: `apply()`
        // toggles a class on the wrapper, and the wrapper is THIS observer's
        // root. WebKit re-evaluates intersections after style writes made in
        // the callback (Blink defers to the next frame), so a synchronous
        // evaluate/apply can drive the observer in a tight loop. Coalescing
        // into a single rAF breaks that synchronous coupling.
        const entry = entries[entries.length - 1];
        if (!entry) return;
        this.pendingEntry = entry;
        // The pending flag is raised BEFORE scheduling and lowered inside the
        // frame, so the bookkeeping stays correct even if the callback runs
        // synchronously (the returned handle would otherwise be assigned after
        // the frame already cleared it).
        if (this.evaluateRafPending) return;
        this.evaluateRafPending = true;
        this.evaluateRaf = requestAnimationFrame(() => {
          this.evaluateRafPending = false;
          const pending = this.pendingEntry;
          this.pendingEntry = null;
          if (pending) this.evaluateFit(pending);
        });
      },
      { root: this.wrapper, threshold: 1 },
    );
    this.fitsObserver.observe(this.table);
  }

  private getHeaderRow(): HTMLTableRowElement | null {
    if (this.cachedHeaderRow && this.table.contains(this.cachedHeaderRow)) {
      return this.cachedHeaderRow;
    }
    this.cachedHeaderRow = this.table.querySelector('tr');
    return this.cachedHeaderRow;
  }

  private evaluateFit(entry: IntersectionObserverEntry) {
    if (this.latch.latched) return;
    if (!this.isEligible()) {
      this.apply('off');
      return;
    }
    if (isLayoutInert(entry.boundingClientRect)) return;
    this.apply(entry.isIntersecting ? 'native' : 'fallback');
  }

  private isEligible(): boolean {
    return (
      !isNestedTable(this.wrapper) && firstRowIsAllHeaders(this.getHeaderRow())
    );
  }

  private apply(next: PinMode) {
    if (this.latch.latched) return;
    if (next === this.mode) return;

    // Only the overflow-driven pair can oscillate; eligibility-driven `off`
    // transitions pass straight through without touching the counter.
    if (next === 'off' || this.mode === 'off') {
      this.setMode(next);
      return;
    }

    if (this.latch.note()) {
      // Fit detection is oscillating. Latch into 'fallback' — the only pinned
      // mode that leaves the wrapper's overflow alone, so it cannot re-drive
      // the cycle — and stop listening. Per-controller (per table), not global.
      // `next` is statically narrowed to 'native' | 'fallback' here because every
      // 'off' transition returned above — so the latch structurally cannot
      // override a requested 'off' and force-pin a table that must not be pinned.
      const { latchCount, gaveUpNow } = this.latch.latch();
      this.fitsObserver?.disconnect();
      this.pendingEntry = null;
      const preamble =
        '[table-header-pin] fit detection oscillated (>' +
        PIN_MODE_FLIP_LIMIT +
        ' flips/' +
        PIN_MODE_FLIP_WINDOW_MS +
        'ms) — using the transform fallback for this table; header pinning stays ' +
        'functional but the native sticky path is off. ';
      if (this.latch.gaveUp) {
        // Log only the FIRST transition into the give-up state. unlatch() (the
        // ineligible path) restores retry rights without clearing latchCount, so
        // a table whose eligibility churns can latch again while gaveUp is
        // already set — repeating the announcement would just be noise.
        if (gaveUpNow) {
          console.warn(
            preamble +
              'This is latch #' +
              latchCount +
              ' for this table, so native sticky will not be retried again ' +
              'while this table keeps qualifying for pinning; the transform ' +
              'fallback stays in place.',
          );
        }
      } else {
        console.warn(
          preamble +
            'Native sticky is retried ' +
            PIN_LATCH_COOLDOWN_MS +
            'ms from now, on whichever comes first: a scroll frame over this ' +
            'table or a document change.',
        );
      }
      this.setMode('fallback');
      return;
    }

    this.setMode(next);
  }

  private setMode(next: PinMode) {
    if (next === this.mode) return;

    if (this.mode === 'fallback' && next !== 'fallback') {
      fallbackControllers.delete(this);
      maybeTeardownFallbackListener();
    }

    this.mode = next;
    const cls = this.wrapper.classList;

    // Acquire BEFORE the class writes so :root already carries the offset when
    // the row first paints as pinned; release AFTER them, when nothing is left
    // to consume it. Every path out of a pinning mode funnels through here —
    // the latch (which sets 'fallback'), the ineligible->'off' path in refresh(),
    // and destroy() — so the refcount stays balanced by construction.
    if (next !== 'off') this.holdPinOffset(true);

    if (next === 'off') {
      cls.remove(HEADER_PINNED);
      cls.remove(WRAPPER_NO_OVERFLOW);
      this.wrapper.style.removeProperty(PIN_OFFSET_VAR);
      this.holdPinOffset(false);
    } else if (next === 'native') {
      cls.add(HEADER_PINNED);
      cls.add(WRAPPER_NO_OVERFLOW);
      // Native mode reads --editor-pin-offset from :root; clear stale per-wrapper var from fallback.
      this.wrapper.style.removeProperty(PIN_OFFSET_VAR);
    } else if (next === 'fallback') {
      cls.add(HEADER_PINNED);
      cls.remove(WRAPPER_NO_OVERFLOW);
      fallbackControllers.add(this);
      ensureFallbackListener();
      // Avoid one stale-frame paint under translateY.
      this.updateFallbackOffset();
    }
  }

  // Idempotent by the boolean: acquiring twice or releasing an unheld reference
  // would unbalance the module-level refcount.
  private holdPinOffset(hold: boolean) {
    if (hold === this.pinOffsetHeld) return;
    this.pinOffsetHeld = hold;
    if (hold) pinOffsetWatcher.acquire();
    else pinOffsetWatcher.release();
  }

  updateFallbackOffset() {
    // A latched controller is by definition in fallback mode, so it is in
    // fallbackControllers and this runs on every scroll frame — the only tick
    // that still exists on a read-only page, where the doc never changes and
    // refresh() is therefore never called. Costs one boolean per frame when not
    // latched, one timestamp comparison when it is.
    if (this.latch.latched) this.rearmLatchAfterCooldown();

    const pinTop = computePinTop();
    const tableRect = this.table.getBoundingClientRect();
    const headerRow = this.getHeaderRow();
    if (!headerRow) return;
    const rowHeight = headerRow.getBoundingClientRect().height;

    const active = tableRect.top < pinTop && tableRect.bottom > pinTop + rowHeight;

    if (active) {
      const offset = Math.min(pinTop - tableRect.top, tableRect.height - rowHeight);
      this.wrapper.style.setProperty(PIN_OFFSET_VAR, `${offset}px`);
    } else {
      this.wrapper.style.removeProperty(PIN_OFFSET_VAR);
    }
  }

  // Latching is not terminal: PIN_LATCH_COOLDOWN_MS after latching we re-observe
  // and give native sticky another chance — unless this table has already spent
  // its retry budget. Driven from refresh() and from the fallback scroll frame.
  private rearmLatchAfterCooldown() {
    if (this.latch.maybeRelease()) this.fitsObserver?.observe(this.table);
  }

  refresh() {
    // The header <tr> may have been replaced by a PM transaction; drop
    // the cached reference before checking eligibility.
    this.cachedHeaderRow = null;
    if (!this.isEligible()) {
      // Bypass apply()'s latch gate and flip accounting: a table that must not
      // be pinned must always be un-pinned, latched or not. Otherwise a header
      // row deleted after the latch would keep `tableHeaderPinned` and the
      // translateY fallback on a plain data row forever.
      this.setMode('off');
      // Going ineligible already breaks the feedback cycle — the wrapper is not
      // pinned and `tableWrapperNoOverflow` is gone — so the latch has nothing
      // left to protect against. Drop it here, otherwise a table that becomes
      // eligible again (an undone header-row deletion) before the cooldown
      // expires would be stranded with no pinning at all: refresh() would see
      // `latched` and return without ever taking the re-observe path below.
      this.latch.unlatch();
      return;
    }
    if (this.latch.latched) {
      this.rearmLatchAfterCooldown();
      return;
    }
    if (this.mode === 'off') {
      // Eligibility just flipped back on; re-trigger the observer so it
      // emits the current intersection state.
      this.fitsObserver?.unobserve(this.table);
      this.fitsObserver?.observe(this.table);
    }
  }

  destroy() {
    // Idempotent: a second destroy() must not release pinOffsetWatcher twice
    // (that would drive its refcount negative and leak a ResizeObserver on the
    // next acquire/release cycle).
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.evaluateRafPending && this.evaluateRaf !== null) {
      cancelAnimationFrame(this.evaluateRaf);
    }
    this.evaluateRafPending = false;
    this.evaluateRaf = null;
    this.pendingEntry = null;
    this.fitsObserver?.disconnect();
    this.fitsObserver = undefined;
    // Bypass apply()'s latch/flip bookkeeping — teardown must always clean up.
    // setMode('off') releases the pin-offset reference; the extra call covers
    // the case where the mode was already 'off' (setMode early-returns then) and
    // is a no-op when the reference was already released.
    this.setMode('off');
    this.holdPinOffset(false);
  }
}

const controllers = new WeakMap<HTMLElement, TablePinController>();

export function attach(wrapper: HTMLElement) {
  if (controllers.has(wrapper)) return;
  const table = wrapper.querySelector(':scope > table') as HTMLTableElement | null;
  if (!table) return;
  controllers.set(wrapper, new TablePinController(wrapper, table));
}

export function detach(wrapper: HTMLElement) {
  const ctrl = controllers.get(wrapper);
  if (!ctrl) return;
  ctrl.destroy();
  controllers.delete(wrapper);
}

export function getController(wrapper: HTMLElement): TablePinController | undefined {
  return controllers.get(wrapper);
}
