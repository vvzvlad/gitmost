import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Body-paint latch + forced-sampling tests (#639, structural criteria 2-5).
 *
 * INITIAL_PATHNAME in vitals.ts is captured ONCE at module init, so each case
 * loads the module fresh (vi.resetModules + dynamic import) after setting the
 * document's boot pathname. `@/lib/config` is mocked so telemetry is enabled and
 * force-sampled; `performance.now`/marks are stubbed so timings are exact.
 */

type VitalsModule = typeof import("./vitals");

async function loadVitals(opts: {
  pathname: string;
  telemetryEnabled?: boolean;
  sampleRate?: string;
  mockWebVitals?: boolean;
}): Promise<VitalsModule> {
  vi.resetModules();
  // Control the module-init pathname capture (the doc's boot route).
  window.history.replaceState(null, "", opts.pathname);
  vi.doMock("@/lib/config", () => ({
    isClientTelemetryEnabled: () => opts.telemetryEnabled ?? true,
    getClientTelemetrySampleRate: () => opts.sampleRate ?? "1",
  }));
  if (opts.mockWebVitals) {
    // The #681 observer-wiring test stubs a global PerformanceObserver; web-vitals'
    // onINP would otherwise ALSO register an `{type:"event"}` observer through it,
    // muddying which observer is ours. No-op the web-vitals subscribers so only
    // initVitals' own observers are installed on the stub.
    vi.doMock("web-vitals/attribution", () => ({
      onINP: () => undefined,
      onLCP: () => undefined,
      onCLS: () => undefined,
      onTTFB: () => undefined,
    }));
  }
  return import("./vitals");
}

function stubNoMark(now: number): void {
  vi.spyOn(performance, "getEntriesByName").mockReturnValue([] as any);
  vi.spyOn(performance, "clearMarks").mockImplementation(() => undefined);
  vi.spyOn(performance, "now").mockReturnValue(now);
}

function stubMark(markStart: number, now: number): void {
  vi.spyOn(performance, "getEntriesByName").mockReturnValue([
    { startTime: markStart } as any,
  ]);
  vi.spyOn(performance, "clearMarks").mockImplementation(() => undefined);
  vi.spyOn(performance, "now").mockReturnValue(now);
}

function names<T extends { name: string }>(events: T[], name: string): T[] {
  return events.filter((e) => e.name === name);
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock("@/lib/config");
  vi.doUnmock("web-vitals/attribution");
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("page_open_body_ms latch (#639)", () => {
  // Criterion 2 — reload path: no click mark, count from timeOrigin, and both
  // paint points feed ONE shared one-shot latch (second call is a no-op).
  it("reports once via the timeOrigin start on a mark-less reload of a page route", async () => {
    const v = await loadVitals({ pathname: "/s/eng/p/design-abc" });
    stubNoMark(842);
    v.armBodyPaint("page-1");
    v.notePageBodyPaint("page-1"); // static-copy branch paints
    v.notePageBodyPaint("page-1"); // live-editor branch — one-shot no-op

    const events = v.__vitalsTestHooks.drainBuffer();
    const opens = names(events, "page_open_body_ms");
    expect(opens).toHaveLength(1);
    expect(opens[0].value).toBe(842);
    expect(opens[0].route).toBe("/s/:space/p/:slug");
  });

  // Criterion 3 — click-mark path is the start, and editor re-creation (a second
  // paint for the same document) does NOT double-report.
  it("uses the click mark as start and does not double-report on re-creation", async () => {
    const v = await loadVitals({ pathname: "/s/eng/p/design-abc" });
    stubMark(1000, 1300);
    v.armBodyPaint("page-1");
    v.notePageBodyPaint("page-1"); // first paint
    v.notePageBodyPaint("page-1"); // editor re-creation / static->live swap

    const opens = names(v.__vitalsTestHooks.drainBuffer(), "page_open_body_ms");
    expect(opens).toHaveLength(1);
    expect(opens[0].value).toBe(300); // 1300 - 1000
  });

  it("prefers the click mark even when the document booted on a non-page route", async () => {
    const v = await loadVitals({ pathname: "/home" });
    stubMark(2000, 2250);
    v.armBodyPaint("page-1");
    v.notePageBodyPaint("page-1");

    const opens = names(v.__vitalsTestHooks.drainBuffer(), "page_open_body_ms");
    expect(opens).toHaveLength(1);
    expect(opens[0].value).toBe(250);
  });

  // Criterion 4 — the initial-pathname guard: a mark-less open whose document
  // booted on a NON-page route (load /home, idle, programmatic "new note") is
  // NOT reported, even though the live location is now a page route.
  it("does NOT report a mark-less open when the document booted on a non-page route", async () => {
    const v = await loadVitals({ pathname: "/home" });
    stubNoMark(300_000); // ~5 min of idle since boot
    // The programmatic navigation has already changed the LIVE location:
    window.history.replaceState(null, "", "/s/eng/p/new-note-xyz");
    v.armBodyPaint("page-new");
    v.notePageBodyPaint("page-new");

    const events = v.__vitalsTestHooks.drainBuffer();
    expect(names(events, "page_open_body_ms")).toHaveLength(0);
    // The body DID paint, so it must not count as a timeout either.
    expect(names(events, "body_paint_timeout")).toHaveLength(0);
  });

  // Criterion 4 (cap half) — even on a page-booted document, a mark-less value
  // over the hard cap is suppressed (idle-then-navigate inflation).
  it("does NOT report a mark-less value over the hard cap", async () => {
    const v = await loadVitals({ pathname: "/s/eng/p/first" });
    stubNoMark(300_000); // > PAGE_OPEN_MAX_MS (60s)
    v.armBodyPaint("page-2");
    v.notePageBodyPaint("page-2");

    const events = v.__vitalsTestHooks.drainBuffer();
    expect(names(events, "page_open_body_ms")).toHaveLength(0);
    expect(names(events, "body_paint_timeout")).toHaveLength(0);
  });

  // Review F1 — the cap guards the MARK path too: a STALE click mark (elapsed
  // over the cap) is suppressed, so an unconsumed mark from an earlier click
  // cannot inflate the next open. Without the fix this reports ~70000.
  it("does NOT report a click-mark value over the hard cap (stale mark)", async () => {
    const v = await loadVitals({ pathname: "/s/eng/p/first" });
    stubMark(1_000, 71_000); // elapsed 70s > PAGE_OPEN_MAX_MS (60s)
    v.armBodyPaint("page-stale");
    v.notePageBodyPaint("page-stale");

    const events = v.__vitalsTestHooks.drainBuffer();
    expect(names(events, "page_open_body_ms")).toHaveLength(0);
    // The body DID paint — a suppressed value is not a timeout.
    expect(names(events, "body_paint_timeout")).toHaveLength(0);
  });

  // Review F1 (suggestion 3) — disarmBodyPaint (effect cleanup on unmount before
  // paint) cancels the survivorship timer, so a page the user navigated away from
  // does NOT emit a body_paint_timeout.
  it("disarmBodyPaint cancels the survivorship timer on unmount before paint", async () => {
    const v = await loadVitals({ pathname: "/s/eng/p/design-abc" });
    vi.useFakeTimers();
    stubNoMark(500);
    v.armBodyPaint("page-unmount");
    v.disarmBodyPaint("page-unmount"); // unmounted before it painted
    vi.advanceTimersByTime(15_000);

    const events = v.__vitalsTestHooks.drainBuffer();
    expect(names(events, "body_paint_timeout")).toHaveLength(0);
    expect(names(events, "page_open_body_ms")).toHaveLength(0);
  });

  // Criterion 5 — never-paint survivorship guard: body_paint_timeout is emitted,
  // page_open_body_ms is NOT, and a late paint after the timeout is a no-op.
  it("emits body_paint_timeout (not page_open_body_ms) when the body never paints", async () => {
    const v = await loadVitals({ pathname: "/s/eng/p/design-abc" });
    vi.useFakeTimers();
    stubNoMark(500);
    v.armBodyPaint("page-3");
    // No notePageBodyPaint — the body never paints.
    vi.advanceTimersByTime(15_000);

    const events = v.__vitalsTestHooks.drainBuffer();
    expect(names(events, "page_open_body_ms")).toHaveLength(0);
    const timeouts = names(events, "body_paint_timeout");
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0].value).toBe(1);

    // A late paint after the timeout already fired must not report.
    v.notePageBodyPaint("page-3");
    expect(
      names(v.__vitalsTestHooks.drainBuffer(), "page_open_body_ms"),
    ).toHaveLength(0);
  });

  it("cancels the timeout when the body paints in time", async () => {
    const v = await loadVitals({ pathname: "/s/eng/p/design-abc" });
    vi.useFakeTimers();
    stubNoMark(400);
    v.armBodyPaint("page-4");
    v.notePageBodyPaint("page-4"); // paints before the window elapses
    vi.advanceTimersByTime(60_000);

    const events = v.__vitalsTestHooks.drainBuffer();
    expect(names(events, "body_paint_timeout")).toHaveLength(0);
    expect(names(events, "page_open_body_ms")).toHaveLength(1);
  });

  it("re-arms for a new document (page switch) so the next open reports again", async () => {
    const v = await loadVitals({ pathname: "/s/eng/p/design-abc" });
    stubNoMark(100);
    v.armBodyPaint("page-a");
    v.notePageBodyPaint("page-a");
    // Page switch to a different document key.
    v.armBodyPaint("page-b");
    v.notePageBodyPaint("page-b");

    expect(
      names(v.__vitalsTestHooks.drainBuffer(), "page_open_body_ms"),
    ).toHaveLength(2);
  });

  it("is a no-op when telemetry is disabled", async () => {
    const v = await loadVitals({
      pathname: "/s/eng/p/design-abc",
      telemetryEnabled: false,
    });
    stubNoMark(500);
    v.armBodyPaint("page-x");
    v.notePageBodyPaint("page-x");
    expect(v.__vitalsTestHooks.drainBuffer()).toHaveLength(0);
  });
});

describe("operation_ms helpers (#683)", () => {
  // A faithful in-memory performance-mark store so the mark→measure→consume flow
  // is exercised for real (not just the pure reporter). `fakeNow` is the mocked
  // clock: markOperationStart stamps it; measureOperation reads it back.
  function stubMarkStore(): { setNow: (n: number) => void } {
    let store: Record<string, number> = {};
    let fakeNow = 0;
    vi.spyOn(performance, "mark").mockImplementation((name: any) => {
      store[String(name)] = fakeNow;
      return undefined as any;
    });
    vi.spyOn(performance, "clearMarks").mockImplementation((name?: any) => {
      if (name === undefined) store = {};
      else delete store[String(name)];
    });
    vi.spyOn(performance, "getEntriesByName").mockImplementation((name: any) =>
      String(name) in store
        ? ([{ startTime: store[String(name)] }] as any)
        : ([] as any),
    );
    vi.spyOn(performance, "now").mockImplementation(() => fakeNow);
    return {
      setNow: (n: number) => {
        fakeNow = n;
      },
    };
  }

  // AC1/AC6 — reportOperation emits operation_ms with the op as `attr`.
  it("reports operation_ms with the op in attr (Pattern B direct report)", async () => {
    const v = await loadVitals({ pathname: "/s/eng/p/x" });
    stubMarkStore();
    v.reportOperation("diagram_mermaid", 123);

    const events = names(v.__vitalsTestHooks.drainBuffer(), "operation_ms");
    expect(events).toHaveLength(1);
    expect(events[0].value).toBe(123);
    expect(events[0].attr).toBe("diagram_mermaid");
  });

  // Edge case — >8ms report threshold (as editor_tx): fast ops don't flood.
  it("drops sub-threshold (<=8ms) samples and keeps faster-than-a-frame out", async () => {
    const v = await loadVitals({ pathname: "/s/eng/p/x" });
    stubMarkStore();
    v.reportOperation("tree_expand", 8); // exactly the threshold — dropped
    v.reportOperation("tree_expand", 3); // cache-hit ~0ms — dropped
    v.reportOperation("tree_expand", 9); // just above — kept

    const events = names(v.__vitalsTestHooks.drainBuffer(), "operation_ms");
    expect(events).toHaveLength(1);
    expect(events[0].value).toBe(9);
  });

  // Pattern A — mark then measure reports the elapsed, and CONSUMES the mark so a
  // second settle for the same op is a no-op (expiry/no double-count).
  it("mark→measure reports elapsed once and consumes the mark", async () => {
    const v = await loadVitals({ pathname: "/s/eng/p/x" });
    const clock = stubMarkStore();
    clock.setNow(1000);
    v.markOperationStart("comment_resolve");
    clock.setNow(1250);
    v.measureOperation("comment_resolve"); // 250ms
    v.measureOperation("comment_resolve"); // mark consumed — no-op

    const events = names(v.__vitalsTestHooks.drainBuffer(), "operation_ms");
    expect(events).toHaveLength(1);
    expect(events[0].value).toBe(250);
    expect(events[0].attr).toBe("comment_resolve");
  });

  // Edge case — a replayed start overwrites the prior mark (last-start-wins), so
  // the measure reflects the most recent interaction, not the abandoned one.
  it("a new markOperationStart overwrites the prior mark", async () => {
    const v = await loadVitals({ pathname: "/s/eng/p/x" });
    const clock = stubMarkStore();
    clock.setNow(0);
    v.markOperationStart("spotlight_open"); // abandoned start
    clock.setNow(500);
    v.markOperationStart("spotlight_open"); // replay — overwrites
    clock.setNow(520);
    v.measureOperation("spotlight_open");

    const events = names(v.__vitalsTestHooks.drainBuffer(), "operation_ms");
    expect(events).toHaveLength(1);
    expect(events[0].value).toBe(20); // 520 - 500, not 520 - 0
  });

  // Success-only / cancelled-interaction — measureOperation with no live mark (the
  // interaction was cancelled, or measure was skipped on the error path) reports
  // nothing; the mark simply expires.
  it("measureOperation with no mark reports nothing (cancelled / error path)", async () => {
    const v = await loadVitals({ pathname: "/s/eng/p/x" });
    stubMarkStore();
    v.measureOperation("comment_apply");
    expect(
      names(v.__vitalsTestHooks.drainBuffer(), "operation_ms"),
    ).toHaveLength(0);
  });

  // AC6 (gate half) — telemetry off ⇒ zero collection: neither mark, measure, nor
  // a direct report buffers anything.
  it("is a no-op end-to-end when telemetry is disabled", async () => {
    const v = await loadVitals({
      pathname: "/s/eng/p/x",
      telemetryEnabled: false,
    });
    const clock = stubMarkStore();
    clock.setNow(0);
    v.markOperationStart("history_diff");
    clock.setNow(9999);
    v.measureOperation("history_diff");
    v.reportOperation("history_diff", 500);
    expect(v.__vitalsTestHooks.drainBuffer()).toHaveLength(0);
  });
});

describe("editor_key_latency_ms Event Timing observer (#681)", () => {
  // A real-ish PerformanceEventTiming: the fields the browser hands the observer,
  // including `target: null` (Event Timing does NOT expose the target element —
  // the whole reason the filter uses a live focus check instead).
  function eventEntry(
    over: Partial<PerformanceEventTiming> = {},
  ): PerformanceEventTiming {
    return {
      name: "keydown",
      entryType: "event",
      startTime: 1000,
      duration: 48,
      processingStart: 1008,
      processingEnd: 1016,
      cancelable: true,
      target: null,
      interactionId: 0,
      toJSON: () => ({}),
      ...over,
    } as unknown as PerformanceEventTiming;
  }

  // Put real focus inside a real `.ProseMirror` element so isEditorFocused()
  // exercises the actual DOM focus path (#8: the observable property under a
  // real-ish entry + real focus, not a stubbed helper). Returns a cleanup fn.
  function focusInsideEditor(): void {
    const editor = document.createElement("div");
    editor.className = "ProseMirror";
    editor.contentEditable = "true";
    editor.tabIndex = -1;
    document.body.appendChild(editor);
    editor.focus();
  }

  function focusOutsideEditor(): void {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
  }

  // AC1/AC2 — an editor-focused keydown reports editor_key_latency_ms with the
  // entry's FULL duration (keydown→paint) and the current route template.
  it("reports the full keydown duration when focus is inside the editor", async () => {
    const v = await loadVitals({ pathname: "/s/eng/p/design-abc" });
    focusInsideEditor();
    v.reportEditorKeyLatency([eventEntry({ duration: 64 })]);

    const events = names(
      v.__vitalsTestHooks.drainBuffer(),
      "editor_key_latency_ms",
    );
    expect(events).toHaveLength(1);
    expect(events[0].value).toBe(64);
    expect(events[0].route).toBe("/s/:space/p/:slug");
  });

  // Filter half 1 — non-keydown interactions (click/pointerdown) are ignored even
  // when the editor is focused: this metric is typing latency only.
  it("ignores non-keydown interaction entries", async () => {
    const v = await loadVitals({ pathname: "/s/eng/p/x" });
    focusInsideEditor();
    v.reportEditorKeyLatency([
      eventEntry({ name: "click", duration: 90 }),
      eventEntry({ name: "pointerdown", duration: 90 }),
    ]);
    expect(
      names(v.__vitalsTestHooks.drainBuffer(), "editor_key_latency_ms"),
    ).toHaveLength(0);
  });

  // Filter half 2 — a keydown while focus is OUTSIDE any .ProseMirror (a comment
  // input, the spotlight, page chrome) is not an editor interaction: ignored.
  it("ignores a keydown when focus is outside the editor", async () => {
    const v = await loadVitals({ pathname: "/s/eng/p/x" });
    focusOutsideEditor();
    v.reportEditorKeyLatency([eventEntry({ duration: 80 })]);
    expect(
      names(v.__vitalsTestHooks.drainBuffer(), "editor_key_latency_ms"),
    ).toHaveLength(0);
  });

  // Always-on, per-interaction (NOT sampled to one p98): every qualifying entry in
  // a batch reports its own sample.
  it("reports every qualifying entry in a batch", async () => {
    const v = await loadVitals({ pathname: "/s/eng/p/x" });
    focusInsideEditor();
    v.reportEditorKeyLatency([
      eventEntry({ duration: 24 }),
      eventEntry({ name: "click", duration: 200 }), // filtered out
      eventEntry({ duration: 112 }),
    ]);
    const events = names(
      v.__vitalsTestHooks.drainBuffer(),
      "editor_key_latency_ms",
    );
    expect(events.map((e) => e.value)).toEqual([24, 112]);
  });

  // AC4 gate half — telemetry off ⇒ nothing collected even for an editor keydown.
  it("is a no-op when telemetry is disabled", async () => {
    const v = await loadVitals({
      pathname: "/s/eng/p/x",
      telemetryEnabled: false,
    });
    focusInsideEditor();
    v.reportEditorKeyLatency([eventEntry({ duration: 100 })]);
    expect(v.__vitalsTestHooks.drainBuffer()).toHaveLength(0);
  });

  // Wiring (#8) — initVitals installs a real `{type:"event", durationThreshold:16,
  // buffered:false}` observer whose callback routes list.getEntries() through the
  // SAME reportEditorKeyLatency filter (#7: one source of the detection). Driving
  // the captured callback with a real-ish list + real focus proves the observer is
  // wired to the filter and reports the correct shape.
  it("initVitals installs an event observer wired to the editor-keydown filter", async () => {
    const observed: Array<{
      cb: (list: { getEntries: () => PerformanceEntry[] }) => void;
      options: PerformanceObserverInit;
    }> = [];
    class FakePerformanceObserver {
      constructor(
        private cb: (list: { getEntries: () => PerformanceEntry[] }) => void,
      ) {}
      observe(options: PerformanceObserverInit) {
        observed.push({ cb: this.cb, options });
      }
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
    vi.stubGlobal("PerformanceObserver", FakePerformanceObserver);
    vi.useFakeTimers(); // swallow initVitals' setInterval(flush)

    const v = await loadVitals({
      pathname: "/s/eng/p/x",
      mockWebVitals: true,
    });
    v.initVitals();

    const eventObs = observed.find((o) => o.options.type === "event");
    expect(eventObs).toBeDefined();
    expect(eventObs!.options.durationThreshold).toBe(16);
    expect(eventObs!.options.buffered).toBe(false);

    // Drive the live observer callback with a real-ish entry + real editor focus.
    focusInsideEditor();
    eventObs!.cb({
      getEntries: () => [eventEntry({ duration: 72 })],
    });

    const events = names(
      v.__vitalsTestHooks.drainBuffer(),
      "editor_key_latency_ms",
    );
    expect(events).toHaveLength(1);
    expect(events[0].value).toBe(72);
  });
});

describe("forced sampling override (#639 §4)", () => {
  it("forces sampling ON even if an earlier tab-session decided not-sampled", async () => {
    // A prior session persisted a "not sampled" decision.
    sessionStorage.setItem("gm_vitals_sampled", "0");
    const v = await loadVitals({ pathname: "/home", sampleRate: "1" });
    expect(v.isVitalsSampled()).toBe(true);
  });

  it("falls back to the persisted session decision when the override is unset", async () => {
    const v = await loadVitals({ pathname: "/home", sampleRate: "" });
    sessionStorage.setItem("gm_vitals_sampled", "0");
    v.__vitalsTestHooks.reset(); // clear the in-module cache so it re-reads storage
    expect(v.isVitalsSampled()).toBe(false);
  });
});
