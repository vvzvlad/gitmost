/**
 * #395 — "time worked on an article" domain types.
 *
 * The estimate is built by sessionizing a page's `page_history` timeline on
 * inactivity gaps (WakaTime-style), NOT by taking the span between the first and
 * last edit (which over-counts sleep / lunch / idle days). See the design doc in
 * issue #395 §5–§6.3 for the normative algorithm.
 */

/**
 * A single `page_history` row projected for the work-time computation — the
 * cheap columns only (no `content`). Produced by
 * `PageHistoryRepo.findTimelineByPageId`. `createdAt` is whatever the DB driver
 * hands back (Date); the pure core normalizes it to epoch-ms itself so it stays
 * deterministic and DB-free.
 */
export interface TimelineSample {
  createdAt: Date | string | number;
  lastUpdatedById: string | null;
  /** 'user' | 'agent' | 'git' | null (legacy autosave = human). */
  lastUpdatedSource: string | null;
  lastUpdatedAiChatId: string | null;
  /** #370 tier: 'manual' | 'agent' | 'idle' | 'boundary' | null (legacy). */
  kind: string | null;
}

/** A finished session's class (§5.1). */
export type SessionClass = 'work' | 'agent_only';

/**
 * A finished session: absolute wall-clock bounds already padded with P_in/P_out
 * (multi-sample) or P_single (single scalar), plus its class. This is enough for
 * both the metrics and the per-day punch-card colouring.
 */
export interface WorkSession {
  /** epoch-ms, inclusive lower bound (already P-padded). */
  start: number;
  /** epoch-ms, exclusive upper bound (already P-padded). */
  end: number;
  class: SessionClass;
}

/** Output of {@link computeWorkTime}. */
export interface WorkTimeResult {
  /** union wall-clock of `work` sessions, ms (the headline metric). */
  workMs: number;
  /** union wall-clock of `agent_only` sessions, ms (secondary). */
  agentOnlyMs: number;
  sessions: WorkSession[];
}

/** One activity window inside a calendar day (already clipped to the day). */
export interface DayWindow {
  /** epoch-ms. */
  start: number;
  /** epoch-ms. */
  end: number;
  class: SessionClass;
}

/** One calendar day of the punch-card (§6.3). */
export interface PerDay {
  /** epoch-ms of the local-midnight day start in the requested tz. */
  day: number;
  /** 'YYYY-MM-DD' in the requested tz — stable, tz-independent label. */
  dayISO: string;
  /** Σ of `work` windows this day, ms. Σ over days == workMs (invariant §6.3). */
  activeMs: number;
  /** Σ of `agent_only` windows this day, ms (drawn, NOT in activeMs). */
  agentMs: number;
  /** both classes, clipped to the day, sorted by start (for drawing). */
  windows: DayWindow[];
}
