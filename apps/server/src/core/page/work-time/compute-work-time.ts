import {
  TimelineSample,
  WorkSession,
  WorkTimeResult,
} from './work-time.types';
import { WorkTimeConfig, resolveWorkTimeConfig } from './work-time.config';

/** A normalized activity sample (one history row), createdAt as epoch-ms. */
interface NormSample {
  t: number;
  isAgent: boolean;
  aiChatId: string | null;
  kind: string | null;
}

/**
 * A collapsed segment: either a scalar sample (t_start == t_end) or an
 * agent-burst spanning several agent samples of one run (§5.1). It participates
 * in sessionization as a single "sample".
 */
interface Segment {
  tStart: number;
  tEnd: number;
  isAgent: boolean;
}

function toMs(v: Date | string | number): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  return new Date(v).getTime();
}

/**
 * Normalize raw rows → sorted, deduped activity samples. `git` is dropped when
 * configured; every other kind (incl. `idle` — the continuous-work pulse §3) is
 * a real activity sample. Sort is by createdAt ASC; samples whose timestamps
 * fall in the same `dedupRoundMs` bucket collapse to one (§9#7: a synchronous
 * boundary row + the immediate agent snapshot can share a createdAt). A merged
 * sample is human unless EVERY member is an agent, so supervision never gets
 * mis-attributed to the agent.
 */
function normalize(
  rows: TimelineSample[],
  config: WorkTimeConfig,
): NormSample[] {
  const samples: NormSample[] = [];
  for (const row of rows) {
    const source = row.lastUpdatedSource;
    if (config.excludeGit && source === 'git') continue;
    samples.push({
      t: toMs(row.createdAt),
      isAgent: source === 'agent',
      aiChatId: row.lastUpdatedAiChatId ?? null,
      kind: row.kind ?? null,
    });
  }
  samples.sort((a, b) => a.t - b.t);

  if (config.dedupRoundMs <= 0 || samples.length < 2) return samples;

  const deduped: NormSample[] = [];
  for (const s of samples) {
    const prev = deduped[deduped.length - 1];
    if (prev && s.t - prev.t < config.dedupRoundMs) {
      // Merge into the previous sample. Human wins the class; keep the earliest
      // t; keep a non-null aiChatId if either has one (so a bare boundary row
      // does not erase the run id).
      prev.isAgent = prev.isAgent && s.isAgent;
      prev.aiChatId = prev.aiChatId ?? s.aiChatId;
      // Prefer the more specific kind (a real kind over a null/boundary) only
      // matters for burst continuation; keep prev.kind (earliest) as-is.
      continue;
    }
    deduped.push({ ...s });
  }
  return deduped;
}

/**
 * Collapse consecutive same-run agent samples into one burst segment (§5.1) so a
 * dense burst (8 snapshots in 7 minutes) contributes its wall-clock, not a count
 * × block. A burst is broken by any sample NOT continuing the same aiChatId
 * agent run: a non-agent sample, a `boundary` (actor transition), or a DIFFERENT
 * aiChatId. Only an AGENT-sourced `idle` pulse with the SAME or a null aiChatId
 * continues the burst (its label lags the real edit ≤ maxWait, well within
 * rounding); a user-sourced `idle` (a human supervision pulse) breaks it.
 */
function collapse(samples: NormSample[], config: WorkTimeConfig): Segment[] {
  const segments: Segment[] = [];
  let burst: { chatId: string | null; tStart: number; tEnd: number } | null =
    null;

  const flush = () => {
    if (!burst) return;
    let tEnd = burst.tEnd;
    if (config.burstCapMs != null && tEnd - burst.tStart > config.burstCapMs) {
      tEnd = burst.tStart + config.burstCapMs;
    }
    segments.push({ tStart: burst.tStart, tEnd, isAgent: true });
    burst = null;
  };

  for (const s of samples) {
    // An agent-sourced idle pulse continues the current agent burst (same or
    // null run id). A user-sourced idle (human supervision) must NOT be swallowed
    // here — it falls through to the human branch so the session flips to `work`.
    if (
      burst &&
      s.kind === 'idle' &&
      s.isAgent &&
      (s.aiChatId === burst.chatId || s.aiChatId == null)
    ) {
      burst.tEnd = s.t;
      continue;
    }
    if (s.isAgent && s.kind !== 'boundary') {
      if (burst && burst.chatId === s.aiChatId) {
        burst.tEnd = s.t;
      } else {
        flush();
        burst = { chatId: s.aiChatId, tStart: s.t, tEnd: s.t };
      }
      continue;
    }
    // A human sample, a boundary, or an agent-boundary: breaks the burst and is
    // itself a zero-width segment (its class follows its own source).
    flush();
    segments.push({ tStart: s.t, tEnd: s.t, isAgent: s.isAgent });
  }
  flush();
  return segments;
}

function gapThreshold(
  a: Segment,
  b: Segment,
  config: WorkTimeConfig,
): number {
  return a.isAgent && b.isAgent ? config.agentTGap : config.tGap;
}

/** Merge intervals; overlapping OR touching intervals are unioned. */
function unionDuration(intervals: Array<[number, number]>): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [curStart, curEnd] = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    if (s <= curEnd) {
      if (e > curEnd) curEnd = e;
    } else {
      total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    }
  }
  total += curEnd - curStart;
  return total;
}

/**
 * #395 core — estimate time worked on a page from its history timeline (§5).
 * Pure and deterministic: no DB, no clock, no I/O.
 *
 * Pipeline: normalize+dedup → collapse agent bursts → ONE sessionization pass
 * over all segments (threshold depends on the pair: both-agent → agentTGap, else
 * tGap; the last session is ALWAYS closed after the loop) → class per finished
 * session (all-agent → agent_only, else work) → pad each session (multi-sample
 * → [first−P_in, last+P_out]; lone scalar → [t−P_single, t]) → clip padding of
 * adjacent DIFFERENT-class sessions at the raw-gap midpoint (so work/agent_only
 * never overlap) → metrics are the union wall-clock within each class (union, not
 * Σ, so overlaps never double, and cross-class-disjoint by the clip above).
 */
export function computeWorkTime(
  rows: TimelineSample[],
  config?: Partial<WorkTimeConfig>,
): WorkTimeResult {
  const cfg = resolveWorkTimeConfig(config);
  const samples = normalize(rows, cfg);
  const segments = collapse(samples, cfg);

  // Sessionize — one pass over ALL segments.
  const rawSessions: Segment[][] = [];
  let cur: Segment[] | null = null;
  for (const seg of segments) {
    if (cur == null) {
      cur = [seg];
    } else {
      const last = cur[cur.length - 1];
      if (seg.tStart - last.tEnd <= gapThreshold(last, seg, cfg)) {
        cur.push(seg);
      } else {
        rawSessions.push(cur);
        cur = [seg];
      }
    }
  }
  if (cur != null) rawSessions.push(cur); // MUST close the last session (§5, §9#1)

  // A finished session with BOTH its raw (unpadded) span and its padded bounds.
  // `rawSessions` are already in ascending time order, so `built` is too.
  interface BuiltSession {
    rawStart: number;
    rawEnd: number;
    padStart: number;
    padEnd: number;
    cls: WorkSession['class'];
  }
  const built: BuiltSession[] = [];

  for (const segs of rawSessions) {
    const first = segs[0];
    const last = segs[segs.length - 1];
    const cls = segs.every((s) => s.isAgent) ? 'agent_only' : 'work';

    let padStart: number;
    let padEnd: number;
    if (segs.length === 1 && first.tStart === first.tEnd) {
      // Lone single-instant session (one scalar, or a one-snapshot agent run):
      // pre-roll only, no invented "future" work (§5).
      padStart = first.tStart - cfg.pSingle;
      padEnd = first.tStart;
    } else {
      padStart = first.tStart - cfg.pIn;
      padEnd = last.tEnd + cfg.pOut;
    }

    built.push({
      rawStart: first.tStart,
      rawEnd: last.tEnd,
      padStart,
      padEnd,
      cls,
    });
  }

  // Clip cross-class padding so a `work` and an `agent_only` session that abut
  // never claim the same wall-clock. For each ADJACENT pair of DIFFERENT classes,
  // cap the earlier session's trailing pad and the later session's leading pad at
  // the MIDPOINT of the raw (unpadded) inactivity gap between them: the earlier
  // padded interval then ends ≤ midpoint and the later one starts ≥ midpoint, so
  // the two are disjoint (they touch at most at the midpoint). This makes the
  // per-class unions (workMs / agentOnlyMs) cross-class-disjoint BY CONSTRUCTION
  // — closing the double-count where a work session ending in an agent segment
  // and a nearby agent_only session (gap in (agentTGap, pIn+pOut]) overlapped and
  // were counted into both metrics (§5, §9). Within-class adjacency is left
  // untouched: `unionDuration` already dedups it, and clipping there could perturb
  // the per-class metric value.
  for (let i = 1; i < built.length; i++) {
    const a = built[i - 1];
    const b = built[i];
    if (a.cls === b.cls) continue;
    const midpoint = (a.rawEnd + b.rawStart) / 2;
    if (a.padEnd > midpoint) a.padEnd = midpoint;
    if (b.padStart < midpoint) b.padStart = midpoint;
  }

  const sessions: WorkSession[] = [];
  const workIvs: Array<[number, number]> = [];
  const agentIvs: Array<[number, number]> = [];
  for (const s of built) {
    sessions.push({ start: s.padStart, end: s.padEnd, class: s.cls });
    (s.cls === 'work' ? workIvs : agentIvs).push([s.padStart, s.padEnd]);
  }

  sessions.sort((a, b) => a.start - b.start);

  return {
    workMs: unionDuration(workIvs),
    agentOnlyMs: unionDuration(agentIvs),
    sessions,
  };
}
