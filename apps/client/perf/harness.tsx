/**
 * DEV-ONLY perf harness UI for the AI chat feature.
 *
 * Left panel: controls + live stats. Right side: a bordered box (~real chat
 * window size) hosting the REAL ChatThread component.
 *
 * Scenario A "Open existing chat": mount ChatThread seeded with a large
 * persisted transcript and measure click -> post-mount-paint time.
 * Scenario B "Live agent stream": mount an empty chat and auto-send a message;
 * the fetch patch (see synthetic-turn.ts) answers with a synthetic SSE stream
 * through the real useChat pipeline.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MutableRefObject } from "react";
import ChatThread from "../src/features/ai-chat/components/chat-thread.tsx";
import type { IAiChatMessageRow } from "../src/features/ai-chat/types/ai-chat.types.ts";
import {
  PRESETS,
  buildPersistedRows,
  buildTurnScript,
  setLiveStreamSettings,
  type PresetKey,
} from "./synthetic-turn.ts";

const AUTO_SEND_TEXT = "Run the synthetic perf turn";
const AUTO_SEND_TIMEOUT_MS = 1000;
/** Stats display refresh period — 2x/s so the display itself stays cheap. */
const STATS_FLUSH_MS = 500;

// ---------------------------------------------------------------------------
// Shared mutable stats (written from callbacks, flushed to state at 2 Hz)
// ---------------------------------------------------------------------------

interface PerfStats {
  longtaskCount: number;
  longtaskTotalMs: number;
  longtaskMaxMs: number;
  fps: number;
  sseChunks: number;
  sseChars: number;
  mountAMs: number | null;
  streamState: "idle" | "streaming" | "done" | "aborted";
}

function emptyStats(): PerfStats {
  return {
    longtaskCount: 0,
    longtaskTotalMs: 0,
    longtaskMaxMs: 0,
    fps: 0,
    sseChunks: 0,
    sseChars: 0,
    mountAMs: null,
    streamState: "idle",
  };
}

/**
 * Self-contained stats panel: owns the longtask observer, the FPS meter and the
 * 2 Hz flush interval. Isolated in its OWN component so its periodic setState
 * re-renders only this panel — NOT the ChatThread under measurement.
 */
function StatsPanel({ stats }: { stats: MutableRefObject<PerfStats> }) {
  const [snapshot, setSnapshot] = useState<PerfStats>(() => ({ ...stats.current }));

  // Long tasks (main-thread blocks > 50ms).
  useEffect(() => {
    let observer: PerformanceObserver | null = null;
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          stats.current.longtaskCount += 1;
          stats.current.longtaskTotalMs += entry.duration;
          stats.current.longtaskMaxMs = Math.max(stats.current.longtaskMaxMs, entry.duration);
        }
      });
      observer.observe({ type: "longtask", buffered: true });
    } catch {
      // longtask entries unsupported in this browser — panel shows zeros.
    }
    return () => observer?.disconnect();
  }, [stats]);

  // FPS: frames rendered within the trailing 1s window.
  useEffect(() => {
    let raf = 0;
    const frames: number[] = [];
    const loop = (now: number) => {
      frames.push(now);
      while (frames.length > 0 && frames[0] <= now - 1000) frames.shift();
      stats.current.fps = frames.length;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [stats]);

  // Flush the mutable stats into the display at most 2x/s.
  useEffect(() => {
    const id = window.setInterval(() => setSnapshot({ ...stats.current }), STATS_FLUSH_MS);
    return () => window.clearInterval(id);
  }, [stats]);

  const resetLongtasks = () => {
    stats.current.longtaskCount = 0;
    stats.current.longtaskTotalMs = 0;
    stats.current.longtaskMaxMs = 0;
    setSnapshot({ ...stats.current });
  };

  const row: CSSProperties = { display: "flex", justifyContent: "space-between", gap: 8 };
  return (
    <div style={{ fontFamily: "monospace", fontSize: 12, lineHeight: 1.7 }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>Stats</div>
      <div style={row}><span>FPS (1s)</span><span>{snapshot.fps}</span></div>
      <div style={row}><span>Long tasks</span><span>{snapshot.longtaskCount}</span></div>
      <div style={row}><span>Long total</span><span>{snapshot.longtaskTotalMs.toFixed(0)} ms</span></div>
      <div style={row}><span>Long max</span><span>{snapshot.longtaskMaxMs.toFixed(0)} ms</span></div>
      <div style={row}><span>SSE chunks</span><span>{snapshot.sseChunks}</span></div>
      <div style={row}><span>SSE chars</span><span>{snapshot.sseChars.toLocaleString()}</span></div>
      <div style={row}><span>Stream</span><span>{snapshot.streamState}</span></div>
      <div style={row}>
        <span>Mount A</span>
        <span>{snapshot.mountAMs === null ? "—" : `${snapshot.mountAMs.toFixed(0)} ms`}</span>
      </div>
      <button type="button" onClick={resetLongtasks} style={{ marginTop: 6 }}>
        Reset long tasks
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Auto-send (scenario B): drive the REAL composer in the mounted DOM
// ---------------------------------------------------------------------------

/**
 * Fill the composer textarea via the native value setter + an `input` event
 * (React 18 controlled-input pattern), then click the enabled "Send" button.
 * Retried on rAF until the elements exist (ChatThread mounts asynchronously).
 */
function autoSend(host: HTMLElement, text: string): void {
  const deadline = performance.now() + AUTO_SEND_TIMEOUT_MS;

  const tryClick = () => {
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="Send"]');
    if (button && !button.disabled) {
      button.click();
      return;
    }
    if (performance.now() < deadline) requestAnimationFrame(tryClick);
    else console.error("[perf] auto-send: Send button never became clickable");
  };

  const trySetValue = () => {
    const textarea = host.querySelector("textarea");
    if (!textarea) {
      if (performance.now() < deadline) requestAnimationFrame(trySetValue);
      else console.error("[perf] auto-send: textarea not found");
      return;
    }
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    // Click on a later frame so React commits the controlled value (which
    // enables the Send button) before we press it.
    requestAnimationFrame(tryClick);
  };

  requestAnimationFrame(trySetValue);
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface MountState {
  mode: "A" | "B";
  key: number;
  chatId: string | null;
  rows: IAiChatMessageRow[];
}

const noop = (): void => {};

export default function PerfHarness() {
  const [preset, setPreset] = useState<PresetKey>("20k");
  const [intervalMs, setIntervalMs] = useState<number>(15);
  const [mounted, setMounted] = useState<MountState | null>(null);
  const [fixtureInfo, setFixtureInfo] = useState<string | null>(null);

  const statsRef = useRef<PerfStats>(emptyStats());
  const hostRef = useRef<HTMLDivElement>(null);
  const keyCounterRef = useRef(0);
  const mountStartRef = useRef(0);
  const pendingMountMeasureRef = useRef(false);

  // The scripted live turn for the current preset (reused across B runs; the
  // script is immutable data, so rebuilding per run is unnecessary).
  const liveScript = useMemo(() => buildTurnScript(PRESETS[preset], "live"), [preset]);

  const openPage = useMemo(() => ({ id: "page-1", title: "Perf test page" }), []);

  // Scenario A: mount ChatThread seeded with a large persisted transcript.
  const handleMountA = () => {
    const fixture = buildPersistedRows(PRESETS[preset]);
    setFixtureInfo(
      `Persisted fixture: ${fixture.rows.length} rows, ` +
        `${fixture.totalChars.toLocaleString()} chars ≈ ${fixture.approxTokens.toLocaleString()} tokens`,
    );
    statsRef.current.mountAMs = null;
    // Mark AFTER fixture generation: we measure mount cost, not generation cost
    // (production receives its rows from the network).
    performance.mark("perf:mountA:start");
    mountStartRef.current = performance.now();
    pendingMountMeasureRef.current = true;
    keyCounterRef.current += 1;
    setMounted({ mode: "A", key: keyCounterRef.current, chatId: "perf-chat", rows: fixture.rows });
  };

  // Measure scenario A: effect runs after the mount commit; double rAF lands
  // after the first paint of the mounted transcript.
  useEffect(() => {
    if (!pendingMountMeasureRef.current) return;
    pendingMountMeasureRef.current = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        statsRef.current.mountAMs = performance.now() - mountStartRef.current;
        performance.mark("perf:mountA:end");
        try {
          performance.measure("perf:mountA", "perf:mountA:start", "perf:mountA:end");
        } catch {
          // Marks cleared mid-run — ignore.
        }
      });
    });
  }, [mounted]);

  // Scenario B: mount an empty chat, arm the synthetic stream, auto-send.
  const handleStartB = () => {
    statsRef.current.sseChunks = 0;
    statsRef.current.sseChars = 0;
    statsRef.current.streamState = "streaming";
    setLiveStreamSettings({
      script: liveScript,
      chunkIntervalMs: intervalMs,
      onProgress: (chunks, chars) => {
        statsRef.current.sseChunks = chunks;
        statsRef.current.sseChars = chars;
      },
      onDone: () => {
        statsRef.current.streamState = "done";
        performance.mark("perf:streamB:end");
        try {
          performance.measure("perf:streamB", "perf:streamB:start", "perf:streamB:end");
        } catch {
          // Start mark missing (e.g. marks cleared) — ignore.
        }
      },
      onAbort: () => {
        statsRef.current.streamState = "aborted";
      },
    });
    performance.mark("perf:streamB:start");
    keyCounterRef.current += 1;
    setMounted({ mode: "B", key: keyCounterRef.current, chatId: null, rows: [] });
    if (hostRef.current) autoSend(hostRef.current, AUTO_SEND_TEXT);
  };

  const handleUnmount = () => setMounted(null);

  const label: CSSProperties = { display: "block", fontSize: 12, margin: "10px 0 2px" };
  const button: CSSProperties = { display: "block", width: "100%", margin: "6px 0", padding: "6px 8px" };

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "system-ui, sans-serif" }}>
      {/* Left: controls + stats */}
      <div
        style={{
          width: 260,
          flex: "0 0 260px",
          padding: 12,
          borderRight: "1px solid #ccc",
          overflowY: "auto",
          boxSizing: "border-box",
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: 4 }}>AI chat perf harness</div>

        <label style={label}>Preset</label>
        <select
          value={preset}
          onChange={(e) => setPreset(e.target.value as PresetKey)}
          style={{ width: "100%" }}
        >
          <option value="5k">5k tokens</option>
          <option value="20k">20k tokens</option>
          <option value="50k">50k tokens</option>
        </select>

        <label style={label}>Chunk interval (scenario B)</label>
        <select
          value={intervalMs}
          onChange={(e) => setIntervalMs(Number(e.target.value))}
          style={{ width: "100%" }}
        >
          <option value={15}>15 ms (normal)</option>
          <option value={5}>5 ms (stress)</option>
        </select>

        <div style={{ marginTop: 12 }}>
          <button type="button" style={button} onClick={handleMountA}>
            Mount persisted chat (A)
          </button>
          <button type="button" style={button} onClick={handleStartB}>
            Start live stream (B)
          </button>
          <button type="button" style={button} onClick={handleUnmount} disabled={!mounted}>
            Unmount
          </button>
        </div>

        <div style={{ fontSize: 11, color: "#555", margin: "8px 0" }}>
          <div>
            Live turn: {liveScript.totalChars.toLocaleString()} chars ≈{" "}
            {liveScript.approxTokens.toLocaleString()} tokens
          </div>
          {fixtureInfo && <div>{fixtureInfo}</div>}
          {mounted && (
            <div>
              Mounted: scenario {mounted.mode} (key {mounted.key})
            </div>
          )}
        </div>

        <hr style={{ border: "none", borderTop: "1px solid #ddd" }} />
        <StatsPanel stats={statsRef} />
      </div>

      {/* Right: the real ChatThread inside a real-window-sized box */}
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#f4f4f5",
        }}
      >
        <div
          ref={hostRef}
          style={{
            width: 540,
            height: 680,
            border: "1px solid #bbb",
            borderRadius: 8,
            background: "#fff",
            padding: 8,
            boxSizing: "border-box",
            overflow: "hidden",
          }}
        >
          {mounted ? (
            <ChatThread
              key={mounted.key}
              chatId={mounted.chatId}
              threadKey={`perf-${mounted.key}`}
              initialRows={mounted.rows}
              openPage={openPage}
              roleId={null}
              roles={[]}
              onRolePicked={noop}
              assistantName="Perf agent"
              onTurnFinished={noop}
              onServerChatId={noop}
            />
          ) : (
            <div style={{ color: "#888", fontSize: 13, padding: 16 }}>
              ChatThread unmounted. Use the controls on the left.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
