import {
  onCLS,
  onINP,
  onLCP,
  onTTFB,
  type CLSMetricWithAttribution,
  type INPMetricWithAttribution,
  type LCPMetricWithAttribution,
  type TTFBMetricWithAttribution,
} from "web-vitals/attribution";
import {
  getClientTelemetrySampleRate,
  isClientTelemetryEnabled,
} from "@/lib/config";
import { currentRouteTemplate, templateRoute } from "./route-template";

/**
 * Client perf-telemetry (#355): web-vitals + custom metrics buffered and posted
 * to POST /api/telemetry/vitals via sendBeacon.
 *
 * Design constraints from the issue:
 *  - Sampling is decided ONCE per session (25%), cached in sessionStorage,
 *    BEFORE any observer is subscribed. Non-sampled sessions send nothing.
 *  - Route labels are TEMPLATES only; attr is truncated to 120 chars; no page
 *    titles/slugs/text ever leave the browser.
 *  - Observers are passive and reporting is best-effort — telemetry must not
 *    degrade the perf it measures.
 */

const ENDPOINT = "/api/telemetry/vitals";
const SAMPLE_RATE = 0.25;
const SAMPLE_KEY = "gm_vitals_sampled";
const FLUSH_INTERVAL_MS = 15_000;
const MAX_BUFFER = 40; // flush early if the buffer fills between timers
const MAX_ATTR_LENGTH = 120;
const EDITOR_TX_MIN_MS = 8; // only report editor transactions slower than this
// #683 — same >8ms report threshold as editor_tx: fast ops (cache-hit tree
// expand, trivial re-highlight) must not flood the metric, and they carry no
// user-perceived wait worth measuring.
const OPERATION_MIN_MS = 8;

// #681 — Event Timing durationThreshold for editor_key_latency_ms. Per the
// Event Timing spec the minimum reportable interaction duration is 16ms (finer
// ones are dropped by the browser and durations are rounded to 8ms), so 16 is
// the floor. Fast keystrokes (<16ms) never surface, by design: this metric is a
// distribution over PERCEPTIBLE keydown→paint latencies (we want the lags, not
// background noise), not a per-keystroke trace.
const EDITOR_KEY_LATENCY_MIN_MS = 16;

// #639 — hard cap on a mark-less (timeOrigin) page_open_body_ms measurement.
// The mark-less start counts from `performance.timeOrigin`, i.e. document boot.
// A programmatic (non-<a>) navigation after minutes of idle carries NO click
// mark, so without a cap it would report the whole idle time (~300000 ms) and
// single-handedly wreck the baseline's p75/p95. 60s is an order of magnitude
// above the worst plausible cold-cache reload-to-paint (the lazy editor chunk on
// a slow connection is a few seconds), yet far below the idle-then-navigate
// inflation this cap exists to reject.
const PAGE_OPEN_MAX_MS = 60_000;

// #639 — survivorship-bias guard window. `page_open_body_ms` only reports on a
// SUCCESSFUL paint; a body that never paints (offline, empty ydoc, REST never
// arrived) would otherwise emit nothing and fall out of the sample, so p75
// "improves" exactly when the feature fails. If the body is not painted within
// this window of mount we emit `body_paint_timeout` instead. 15s is comfortably
// longer than a cold-cache editor paint on a slow connection (so a slow-but-
// successful paint cancels the timer first) and equals one FLUSH_INTERVAL_MS, so
// a genuinely stuck body is recorded within a single flush window.
const BODY_PAINT_TIMEOUT_MS = 15_000;

// #639 — the route templates that own a page BODY editor. A mark-less
// (reload/timeOrigin) measurement is only attributed when the document BOOTED on
// one of these; see INITIAL_PATHNAME.
const PAGE_ROUTE_TEMPLATES = new Set<string>([
  "/s/:space/p/:slug",
  "/p/:slug",
  "/share/:shareId/p/:slug",
  "/share/p/:slug",
]);

const ALLOWED_NAMES = new Set([
  "INP",
  "LCP",
  "CLS",
  "TTFB",
  "editor_tx_ms",
  "page_open_ms",
  "longtask_ms",
  // #563 — page-meta boot-cache counters (value is always 1; they are counts).
  "page_meta_hit",
  "page_meta_miss",
  "page_meta_evict",
  // #639 — real-body-paint latency + the never-painted survivorship counter.
  // Must ALSO be in reportClientMetric's union type below AND the server
  // ALLOWED_METRIC_NAMES; a name missing from EITHER side is silently dropped.
  "page_open_body_ms",
  "body_paint_timeout",
  // #683 — single client-perceived / compute operation metric. The specific
  // operation rides in `attr` (op name), NOT the metric name, so this one entry
  // covers every op. Must ALSO be in reportClientMetric's union type below AND
  // the server ALLOWED_METRIC_NAMES; a name missing from EITHER side is dropped.
  "operation_ms",
  // #681 — full keydown→paint editor latency via the Event Timing API. Unlike
  // editor_tx_ms (the SYNCHRONOUS PM transaction only), this captures the React
  // re-render / menu-subscription / floating-ui work that runs AFTER dispatch —
  // the layer #343 optimised, which editor_tx is structurally blind to. Must
  // ALSO be in reportClientMetric's union type below AND the server
  // ALLOWED_METRIC_NAMES; a name missing from EITHER side is silently dropped.
  "editor_key_latency_ms",
]);

interface VitalEvent {
  name: string;
  value: number;
  rating?: string;
  route?: string;
  attr?: string;
  docSize?: number;
}

let sampledCache: boolean | null = null;
let initialised = false;
let buffer: VitalEvent[] = [];
let longtaskSum = 0; // accumulated longtask duration (ms) for the current window

// #639 — the pathname the document BOOTED on, captured ONCE at module init.
// Read LIVE, a later SPA navigation would make a mark-less programmatic open
// (navigate(), not an <a> click) look like a fresh page load and attribute
// minutes of idle time from timeOrigin. `navigation.type` does NOT help — it
// stays "navigate" for the whole SPA document lifetime.
const INITIAL_PATHNAME = readInitialPathname();

// Body-paint latch state — one-shot per document (pageId). While a page open is
// being measured its key is `bodyPaintMeasuringKey`; once it either reports or
// times out the key moves to `bodyPaintResolvedKey`, so a second paint (the
// static->live swap, or an editor re-creation) is a no-op.
let bodyPaintMeasuringKey: string | null = null;
let bodyPaintResolvedKey: string | null = null;
let bodyPaintTimer: ReturnType<typeof setTimeout> | null = null;

function readInitialPathname(): string {
  try {
    return window.location.pathname;
  } catch {
    return "";
  }
}

/**
 * Parse the optional dev sampling-rate override (#639 §4) to a clamped [0,1]
 * number, or null when unset/invalid (default 25% session sampling applies).
 */
function sampleRateOverride(): number | null {
  const raw = getClientTelemetrySampleRate();
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n > 1 ? 1 : n;
}

/**
 * Decide once per session whether this session is sampled. Cached in
 * sessionStorage so the choice is stable across reloads within the session and
 * identical for every observer/custom-metric caller.
 */
export function isVitalsSampled(): boolean {
  if (sampledCache !== null) return sampledCache;
  // #639 §4 — a forced rate (bench/baseline) decides WITHOUT reading the
  // persisted sessionStorage choice: a dev turning the override on must not be
  // silenced by an earlier tab-session's "not sampled". Cached like the normal
  // path so the decision stays stable for every caller this module load.
  const override = sampleRateOverride();
  if (override !== null) {
    return (sampledCache = override >= 1 ? true : Math.random() < override);
  }
  try {
    const stored = sessionStorage.getItem(SAMPLE_KEY);
    if (stored === "1") return (sampledCache = true);
    if (stored === "0") return (sampledCache = false);
    const sampled = Math.random() < SAMPLE_RATE;
    sessionStorage.setItem(SAMPLE_KEY, sampled ? "1" : "0");
    return (sampledCache = sampled);
  } catch {
    // sessionStorage unavailable (private mode / SSR): default to not sampled.
    return (sampledCache = false);
  }
}

/**
 * True only when telemetry is BOTH enabled by the operator (F1 flag) AND this
 * session is sampled. Callers outside initVitals (e.g. the editor dispatch
 * wrapper) use this to skip ALL instrumentation cost on disabled/non-sampled
 * sessions — no observers, no per-transaction timing.
 */
export function isVitalsActive(): boolean {
  return isClientTelemetryEnabled() && isVitalsSampled();
}

function truncateAttr(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.slice(0, MAX_ATTR_LENGTH);
}

function enqueue(event: VitalEvent): void {
  if (!ALLOWED_NAMES.has(event.name)) return;
  if (!Number.isFinite(event.value)) return;
  buffer.push(event);
  if (buffer.length >= MAX_BUFFER) flush();
}

function flush(): void {
  // Fold any pending longtask total into the batch first.
  if (longtaskSum > 0) {
    buffer.push({
      name: "longtask_ms",
      value: Math.round(longtaskSum),
      route: currentRouteTemplate(),
    });
    longtaskSum = 0;
  }
  if (buffer.length === 0) return;

  const payload = JSON.stringify({ events: buffer });
  buffer = [];

  try {
    const blob = new Blob([payload], { type: "application/json" });
    if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, blob)) return;
    // Fallback for browsers without sendBeacon: keepalive fetch.
    void fetch(ENDPOINT, {
      method: "POST",
      body: payload,
      headers: { "Content-Type": "application/json" },
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Best-effort: never throw out of telemetry.
  }
}

/**
 * Report a custom client metric (editor_tx_ms, page_open_ms). No-op unless the
 * session is sampled. Route is always the current TEMPLATE.
 */
export function reportClientMetric(
  name:
    | "editor_tx_ms"
    | "page_open_ms"
    | "page_meta_hit"
    | "page_meta_miss"
    | "page_meta_evict"
    // #639 — must stay in lockstep with ALLOWED_NAMES above and the server
    // ALLOWED_METRIC_NAMES; a name missing from any of the three is dropped.
    | "page_open_body_ms"
    | "body_paint_timeout"
    // #683 — one metric for all client-perceived / compute operations; the op
    // name is carried in `extra.attr` (see reportOperation).
    | "operation_ms"
    // #681 — full keydown→paint editor latency (see reportEditorKeyLatency).
    // Must stay in lockstep with ALLOWED_NAMES above and the server
    // ALLOWED_METRIC_NAMES; a name missing from any of the three is dropped.
    | "editor_key_latency_ms",
  value: number,
  extra?: { docSize?: number; attr?: string },
): void {
  if (!isVitalsActive()) return;
  if (!Number.isFinite(value)) return;
  enqueue({
    name,
    value,
    route: currentRouteTemplate(),
    docSize: extra?.docSize,
    attr: extra?.attr,
  });
}

/** Threshold-gated editor transaction reporter (only reports slow syncs). */
export function reportEditorTx(ms: number, docSize: number): void {
  if (ms <= EDITOR_TX_MIN_MS) return;
  reportClientMetric("editor_tx_ms", ms, { docSize });
}

/**
 * #683 — the operations measured by `operation_ms{op}`. ONE metric; the op is the
 * `attr`. Pattern A (surface opens / client-perceived round-trips) uses
 * markOperationStart(op) on the user action + measureOperation(op) at the settled
 * point; Pattern B (pure client compute/render) times the work with
 * performance.now() and calls reportOperation(op, ms) directly. All op values are
 * short lowercase-and-underscore identifiers, so they pass the server's
 * CSS-selector-shaped `attr` charset validation.
 */
export type OperationName =
  // Pattern A — surface opens & client-perceived round-trips.
  | "comments_open"
  | "ai_chat_open"
  | "spotlight_open"
  | "comment_resolve"
  | "comment_apply"
  | "history_restore"
  | "search_full"
  | "tree_dragdrop"
  | "tree_expand"
  // Pattern B — pure client compute / render.
  | "history_diff"
  | "code_highlight"
  | "diagram_mermaid"
  | "diagram_excalidraw"
  | "diagram_drawio";

// #683 — per-op start marks. Keyed by op so overlapping different ops each keep
// their own start; a repeated start for the SAME op overwrites the prior mark
// (last-start-wins), matching the "cancelled/replayed interaction" edge case.
const OPERATION_MARK_PREFIX = "gm_op_start:";

/**
 * Report one operation_ms sample (Pattern B callers, and the shared sink for
 * Pattern A's measureOperation). Threshold-gated like editor_tx so cache hits and
 * trivial recomputes don't flood; the op rides in `attr`. Gated by
 * isVitalsActive() inside reportClientMetric — flag off / not sampled ⇒ no-op.
 */
export function reportOperation(op: OperationName, ms: number): void {
  if (!Number.isFinite(ms) || ms <= OPERATION_MIN_MS) return;
  reportClientMetric("operation_ms", ms, { attr: op });
}

/**
 * Mark the start of a Pattern-A operation at the user-action point. Overwrites
 * any prior unconsumed mark for the same op (replayed/cancelled interaction).
 * Cheap enough to call unconditionally, but skipped when telemetry is inactive
 * so a disabled/non-sampled session pays zero cost.
 */
export function markOperationStart(op: OperationName): void {
  if (!isVitalsActive()) return;
  try {
    const mark = OPERATION_MARK_PREFIX + op;
    performance.clearMarks(mark);
    performance.mark(mark);
  } catch {
    // performance marks are best-effort; never throw into the user path.
  }
}

/**
 * Measure a Pattern-A operation at its settled point, if a start mark exists, and
 * report it (threshold-gated). Consumes the mark so a later settle for the same
 * op doesn't double-count; an unconsumed mark (interaction cancelled before it
 * settled) simply expires — it is only ever read here or overwritten by the next
 * markOperationStart. Call this ONLY on the SUCCESS path (never in onError), so a
 * failed operation reports nothing and leaves its mark to expire.
 */
export function measureOperation(op: OperationName): void {
  if (!isVitalsActive()) return;
  try {
    const mark = OPERATION_MARK_PREFIX + op;
    const marks = performance.getEntriesByName(mark, "mark");
    if (marks.length === 0) return;
    const elapsed = performance.now() - marks[0].startTime;
    performance.clearMarks(mark);
    reportOperation(op, elapsed);
  } catch {
    // best-effort; never throw into the user path.
  }
}

const PAGE_OPEN_MARK = "gm_page_open_start";

/** Mark the start of a page-open interaction (tree-row / link click). */
export function markPageOpenStart(): void {
  try {
    performance.clearMarks(PAGE_OPEN_MARK);
    performance.mark(PAGE_OPEN_MARK);
  } catch {
    // ignore
  }
}

function clearBodyPaintTimer(): void {
  if (bodyPaintTimer !== null) {
    clearTimeout(bodyPaintTimer);
    bodyPaintTimer = null;
  }
}

/**
 * Compute the page_open_body_ms value to report, or null to SUPPRESS (#639).
 *
 * Start of count:
 *  - a click mark (`gm_page_open_start`, set by the tree-row/link listener)
 *    wins — count from it, and consume it;
 *  - otherwise (a hard reload has no click) count from `performance.timeOrigin`
 *    (i.e. `performance.now()`), but ONLY if the document BOOTED on a page route
 *    AND the value is under the hard cap. Both guards are required: without the
 *    initial-pathname guard a mark-less programmatic open would be measured at
 *    all; without the cap an idle-then-navigate open on a page-booted document
 *    would still slip through with minutes of idle time attributed.
 */
function computePageOpenElapsed(): number | null {
  // 1) explicit click mark.
  try {
    const marks = performance.getEntriesByName(PAGE_OPEN_MARK, "mark");
    if (marks.length > 0) {
      const elapsed = performance.now() - marks[0].startTime;
      performance.clearMarks(PAGE_OPEN_MARK);
      // The cap guards the MARK path too, not only the mark-less path: a click
      // mark can go STALE (a cmd/middle-click or a click that never mounted a
      // PageEditor in this tab leaves the mark unconsumed; markPageOpenStart only
      // overwrites it on the NEXT qualifying click, not on a programmatic
      // navigate()). Without the cap, the next mark-less open (e.g. the "new note"
      // button) would consume that stale mark and report minutes of idle time,
      // inflating exactly the baseline this phase exists to measure.
      return elapsed > 0 && Number.isFinite(elapsed) && elapsed <= PAGE_OPEN_MAX_MS
        ? elapsed
        : null;
    }
  } catch {
    // fall through to the timeOrigin path
  }
  // 2) mark-less (reload) path — guarded.
  if (!PAGE_ROUTE_TEMPLATES.has(templateRoute(INITIAL_PATHNAME))) return null;
  const elapsed = performance.now();
  if (!(elapsed > 0 && Number.isFinite(elapsed)) || elapsed > PAGE_OPEN_MAX_MS) {
    return null;
  }
  return elapsed;
}

/**
 * Arm the body-paint latch for a page open (call on mount / page switch), keyed
 * by the document (pageId). Starts the survivorship-bias timeout: if the body is
 * not painted within BODY_PAINT_TIMEOUT_MS, `body_paint_timeout` is emitted.
 * Idempotent per key — an effect re-run for the same page neither restarts the
 * timer nor re-measures an already-resolved open.
 */
export function armBodyPaint(docKey: string): void {
  if (!isVitalsActive()) return;
  if (docKey === bodyPaintResolvedKey || docKey === bodyPaintMeasuringKey) {
    return;
  }
  clearBodyPaintTimer();
  bodyPaintMeasuringKey = docKey;
  bodyPaintTimer = setTimeout(() => {
    if (bodyPaintMeasuringKey !== docKey) return;
    bodyPaintMeasuringKey = null;
    bodyPaintResolvedKey = docKey;
    bodyPaintTimer = null;
    // This open never painted; drop any click mark it was holding so a stale
    // mark cannot leak forward and inflate the NEXT open's page_open_body_ms.
    try {
      performance.clearMarks(PAGE_OPEN_MARK);
    } catch {
      // no-op: performance marks are best-effort
    }
    reportClientMetric("body_paint_timeout", 1);
  }, BODY_PAINT_TIMEOUT_MS);
}

/**
 * Cancel an armed-but-unresolved body-paint measurement for `docKey` (call from
 * an effect cleanup on unmount). If the page unmounts before it paints, we drop
 * the pending survivorship timer instead of firing a `body_paint_timeout` for a
 * page the user already navigated away from. A no-op once the latch resolved.
 */
export function disarmBodyPaint(docKey: string): void {
  if (docKey !== bodyPaintMeasuringKey) return;
  bodyPaintMeasuringKey = null;
  clearBodyPaintTimer();
}

/**
 * Record that REAL body content painted for `docKey` (call from BOTH paint
 * points — the static copy and the swapped-in live editor). One-shot per
 * document: the first call resolves the latch (cancels the timeout) and reports
 * `page_open_body_ms` when a valid start is available; every later call for the
 * same document is a no-op. A paint always resolves the latch even when the
 * measured value is suppressed (the body DID paint, so it is not a timeout).
 */
export function notePageBodyPaint(docKey: string): void {
  if (docKey !== bodyPaintMeasuringKey) return;
  bodyPaintMeasuringKey = null;
  bodyPaintResolvedKey = docKey;
  clearBodyPaintTimer();
  try {
    const elapsed = computePageOpenElapsed();
    if (elapsed !== null) reportClientMetric("page_open_body_ms", elapsed);
  } catch {
    // never let telemetry break rendering
  }
}

/**
 * #681 — is the current focus inside a ProseMirror editor? A PerformanceEventTiming
 * entry exposes a `target`, but it returns `null` once the node is detached by
 * callback time (and it is not reliably retained across the paint), so we cannot
 * depend on it to filter editor keydowns. Instead we check the LIVE focus at callback time:
 * a keydown lag matters to this metric only when the editor has focus. The
 * heuristic is intentionally broad — a focused input nested inside a `.ProseMirror`
 * container (e.g. an inline widget) counts as an editor interaction too, which is
 * acceptable per the issue's edge-case call.
 */
function isEditorFocused(): boolean {
  try {
    return document.activeElement?.closest(".ProseMirror") != null;
  } catch {
    // No DOM (SSR) or a hostile activeElement: treat as not-in-editor.
    return false;
  }
}

/**
 * #681 — the editor-keydown filter + report for a batch of Event Timing entries.
 * This is the SINGLE source of the editor-keydown detection: the live
 * PerformanceObserver callback (initVitals) and the tests both drive THIS
 * function, so there is no hand-synced mirror of the filter (#7).
 *
 * For each entry it reports `editor_key_latency_ms` = the entry's `duration`,
 * i.e. the FULL keydown→next-paint time (input delay + event handling + React
 * commit + presentation), for keydowns whose focus is in the editor. The
 * browser has already dropped sub-threshold (<16ms) interactions via
 * `durationThreshold`, so every entry here is a perceptible interaction.
 * Reporting is gated by isVitalsActive() inside reportClientMetric — flag off or
 * not-sampled ⇒ no-op.
 */
export function reportEditorKeyLatency(entries: PerformanceEventTiming[]): void {
  for (const entry of entries) {
    // The observer also delivers pointerdown/click/etc.; we want editor keydowns
    // only. The entry's `target` is unreliable (null once detached), so filter by
    // name + live focus. This covers all keydowns in the editor (arrows/shortcuts
    // too, not just text insertion), which is what the issue's keydown→paint asks.
    if (entry.name !== "keydown") continue;
    if (!isEditorFocused()) continue;
    reportClientMetric("editor_key_latency_ms", entry.duration, {});
  }
}

function attrTarget(
  metric:
    | INPMetricWithAttribution
    | LCPMetricWithAttribution
    | CLSMetricWithAttribution,
): string | undefined {
  const a = metric.attribution as Record<string, unknown> | undefined;
  if (!a) return undefined;
  // Different vitals expose their culprit element under different keys; only a
  // CSS-selector-ish target string is taken (no text content / titles).
  return (
    truncateAttr(a.interactionTarget) ??
    truncateAttr(a.element) ??
    truncateAttr(a.largestShiftTarget) ??
    undefined
  );
}

/**
 * Initialise client telemetry. Safe to call multiple times (idempotent). Returns
 * immediately without subscribing when the session is not sampled — so a
 * non-sampled session subscribes to NO observers and sends nothing.
 */
export function initVitals(): void {
  if (initialised) return;
  initialised = true;

  // Operator flag gate (F1, default OFF): when telemetry is disabled the sink
  // endpoint does not even exist server-side, so install ZERO observers.
  if (!isClientTelemetryEnabled()) return;

  // Sampling gate is evaluated BEFORE any observer subscription.
  if (!isVitalsSampled()) return;

  // #639 §4 — a single dev-only confirmation that collection is actually ON, so
  // a dev taking a baseline can tell "flag off" from "not sampled". Prod builds
  // strip this branch (import.meta.env.DEV is statically false).
  if (import.meta.env.DEV) {
    const rate = sampleRateOverride();
    // eslint-disable-next-line no-console
    console.info(
      `[vitals] client telemetry collection is ON (sample rate=${
        rate ?? SAMPLE_RATE
      }${rate !== null ? ", forced via CLIENT_TELEMETRY_SAMPLE_RATE" : ""})`,
    );
  }

  const report = (
    metric:
      | INPMetricWithAttribution
      | LCPMetricWithAttribution
      | CLSMetricWithAttribution
      | TTFBMetricWithAttribution,
  ) => {
    enqueue({
      name: metric.name,
      value: metric.value,
      rating: metric.rating,
      route: currentRouteTemplate(),
      attr:
        metric.name === "TTFB"
          ? undefined
          : attrTarget(
              metric as
                | INPMetricWithAttribution
                | LCPMetricWithAttribution
                | CLSMetricWithAttribution,
            ),
    });
  };

  onINP(report);
  onLCP(report);
  onCLS(report);
  onTTFB(report);

  // Long tasks: aggregate the total blocking time per flush window (a passive
  // observer; individual entries are summed, never stored/sent individually).
  try {
    if (typeof PerformanceObserver !== "undefined") {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longtaskSum += entry.duration;
        }
      });
      observer.observe({ type: "longtask", buffered: true });
    }
  } catch {
    // longtask entry type unsupported: skip silently.
  }

  // #681 — editor_key_latency_ms: full keydown→paint latency via the Event
  // Timing API (the same browser-native source INP is built on), but ALWAYS-ON
  // (every qualifying interaction, not INP's single p98 sample) and filtered to
  // editor keydowns. This is the ONLY vitals signal that sees the React re-render
  // / menu-subscription / floating-ui work that runs AFTER the ProseMirror
  // dispatch — the #343-class overhead that editor_tx_ms is structurally blind
  // to. A passive browser-collected observer: nothing is added to the keystroke
  // hot path (Event Timing is gathered natively; the callback fires only on
  // interactions ≥ threshold).
  try {
    if (typeof PerformanceObserver !== "undefined") {
      const keyObserver = new PerformanceObserver((list) => {
        reportEditorKeyLatency(
          list.getEntries() as unknown as PerformanceEventTiming[],
        );
      });
      // buffered:false — only live interactions, not a replay of pre-init events
      // (those predate any editor focus / this session's sampling decision).
      keyObserver.observe({
        type: "event",
        durationThreshold: EDITOR_KEY_LATENCY_MIN_MS,
        buffered: false,
      });
    }
  } catch {
    // #10/#681 — Event Timing unsupported (older browser): observe({type:"event"})
    // throws. The metric is then INTENTIONALLY inert — no editor_key_latency_ms is
    // ever collected on this session, exactly like the longtask observer above.
    // This is a deliberate, commented graceful-degrade (the browser lacks the
    // native source), NOT a swallowed error hiding a bug: there is nothing to
    // surface to the operator because telemetry itself is best-effort and the
    // rest of vitals keeps working. Newer browsers (all evergreen) support it.
  }

  // page_open_body_ms start: mark when the user clicks a page link/tree-row (any
  // anchor navigating to a page URL). Passive capture listener; the matching
  // measure fires at first REAL body paint (notePageBodyPaint). No page
  // titles/slugs are read — only the click timing is marked.
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target as Element | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      // A page link is `/s/:space/p/:slug`, `/p/:slug` or a share page path.
      if (/\/p\//.test(href)) markPageOpenStart();
    },
    { capture: true, passive: true },
  );

  // Flush on tab hide (most reliable delivery point) and periodically.
  const onHidden = () => {
    if (document.visibilityState === "hidden") flush();
  };
  document.addEventListener("visibilitychange", onHidden);
  window.addEventListener("pagehide", flush);

  setInterval(flush, FLUSH_INTERVAL_MS);
}

/**
 * Test-only inspection/reset hooks (#639). NOT part of the runtime API: they let
 * the vitals specs observe the buffered events and reset module state between
 * cases without a real network sink. Never called by production code.
 */
export const __vitalsTestHooks = {
  drainBuffer(): VitalEvent[] {
    const events = buffer;
    buffer = [];
    return events;
  },
  reset(): void {
    buffer = [];
    sampledCache = null;
    initialised = false;
    longtaskSum = 0;
    bodyPaintMeasuringKey = null;
    bodyPaintResolvedKey = null;
    clearBodyPaintTimer();
  },
};
