import { computeWorkTime } from './compute-work-time';
import { bucketByDay } from './bucket-by-day';
import { TimelineSample, WorkSession } from './work-time.types';

const MIN = 60 * 1000;

/** Union wall-clock of a set of intervals (touching intervals merge). */
function unionMs(intervals: Array<[number, number]>): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [cs, ce] = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    if (s <= ce) {
      if (e > ce) ce = e;
    } else {
      total += ce - cs;
      cs = s;
      ce = e;
    }
  }
  return total + (ce - cs);
}

const ivsOf = (sessions: WorkSession[], cls?: string): Array<[number, number]> =>
  sessions
    .filter((x) => cls == null || x.class === cls)
    .map((x) => [x.start, x.end] as [number, number]);

function s(
  iso: string,
  opts: {
    source?: string | null;
    chat?: string | null;
    kind?: string | null;
    by?: string | null;
  } = {},
): TimelineSample {
  return {
    createdAt: `${iso}Z`,
    lastUpdatedById: opts.by ?? 'human-1',
    lastUpdatedSource: opts.source === undefined ? 'user' : opts.source,
    lastUpdatedAiChatId: opts.chat ?? null,
    kind: opts.kind ?? null,
  };
}

// §7 config: T_gap=30m, P_in+P_out=10m, P_single=2m.
const S7 = { tGap: 30 * MIN, agentTGap: 30 * MIN, pIn: 5 * MIN, pOut: 5 * MIN, pSingle: 2 * MIN };

describe('computeWorkTime', () => {
  it('§7 fixture — sessionizes 20-ish samples to ≈1h32m, not the ≈60h naive span', () => {
    const rows: TimelineSample[] = [
      // S1: multi-sample morning session
      s('2026-07-04T03:40:00'),
      s('2026-07-04T03:45:00'),
      s('2026-07-04T03:49:00'),
      // S2: agent burst (one run) then human supervising → class work
      s('2026-07-04T15:43:00', { source: 'agent', chat: 'c1', kind: 'agent' }),
      s('2026-07-04T15:47:00', { source: 'agent', chat: 'c1', kind: 'agent' }),
      s('2026-07-04T15:50:00', { source: 'agent', chat: 'c1', kind: 'agent' }),
      s('2026-07-04T16:13:00'),
      // S3: single
      s('2026-07-04T18:11:00'),
      // S4: multi-sample evening session
      s('2026-07-04T19:38:00'),
      s('2026-07-04T19:44:00'),
      s('2026-07-04T19:54:00'),
      // S5 / S6: two singles two days later, 44m apart → two sessions at T_gap=30
      s('2026-07-06T15:34:00'),
      s('2026-07-06T16:18:00'),
    ];

    const r = computeWorkTime(rows, S7);

    // 19 + 40 + 2 + 26 + 2 + 2 = 91 minutes.
    expect(r.workMs).toBe(91 * MIN);
    expect(r.agentOnlyMs).toBe(0);
    expect(r.sessions).toHaveLength(6);
    expect(r.sessions.every((x) => x.class === 'work')).toBe(true);

    const naiveSpan =
      new Date('2026-07-06T16:18:00Z').getTime() -
      new Date('2026-07-04T03:40:00Z').getTime();
    expect(naiveSpan).toBeGreaterThan(60 * 60 * MIN); // ≈60h
    expect(r.workMs).toBeLessThan(naiveSpan / 30); // dramatically smaller
  });

  it('n=0 → zero, no sessions', () => {
    const r = computeWorkTime([]);
    expect(r).toEqual({ workMs: 0, agentOnlyMs: 0, sessions: [] });
  });

  it('n=1 human → one P_single work session', () => {
    const r = computeWorkTime([s('2026-07-04T10:00:00')], S7);
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0].class).toBe('work');
    expect(r.workMs).toBe(2 * MIN);
    expect(r.agentOnlyMs).toBe(0);
    // pre-roll only: [t − P_single, t]
    expect(r.sessions[0].end).toBe(new Date('2026-07-04T10:00:00Z').getTime());
  });

  it('n=1 agent → one P_single agent_only session, work=0 (§9#2)', () => {
    const r = computeWorkTime(
      [s('2026-07-04T10:00:00', { source: 'agent', chat: 'c1', kind: 'agent' })],
      S7,
    );
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0].class).toBe('agent_only');
    expect(r.workMs).toBe(0);
    expect(r.agentOnlyMs).toBe(2 * MIN);
  });

  it('MUST close the last session — the newest session is not lost (§9#1)', () => {
    // Two singles a day apart: without the post-loop close, the 2nd is dropped.
    const rows = [s('2026-07-04T10:00:00'), s('2026-07-05T10:00:00')];
    const r = computeWorkTime(rows, S7);
    expect(r.sessions).toHaveLength(2);
    const lastStart = Math.max(...r.sessions.map((x) => x.start));
    expect(lastStart).toBe(
      new Date('2026-07-05T10:00:00Z').getTime() - 2 * MIN,
    );
    expect(r.workMs).toBe(4 * MIN);
  });

  it('agent-burst collapse: density does not inflate — length = wall-clock', () => {
    const span = ['00', '01', '02', '03', '04', '05', '06'];
    const dense: TimelineSample[] = span.map((sec) =>
      s(`2026-07-04T10:00:${sec}`, { source: 'agent', chat: 'c1', kind: 'agent' }),
    );
    const sparse: TimelineSample[] = [
      s('2026-07-04T10:00:00', { source: 'agent', chat: 'c1', kind: 'agent' }),
      s('2026-07-04T10:00:06', { source: 'agent', chat: 'c1', kind: 'agent' }),
    ];
    const rDense = computeWorkTime(dense, S7);
    const rSparse = computeWorkTime(sparse, S7);
    // Same 6-second wall-clock span → same estimate regardless of snapshot count.
    expect(rDense.agentOnlyMs).toBe(rSparse.agentOnlyMs);
    expect(rDense.sessions).toHaveLength(1);
    expect(rDense.sessions[0].class).toBe('agent_only');
  });

  it('supervisory agent time inside a human session counts as work, not agent', () => {
    const rows = [
      s('2026-07-04T10:00:00', { source: 'agent', chat: 'c1', kind: 'agent' }),
      s('2026-07-04T10:05:00', { source: 'agent', chat: 'c1', kind: 'agent' }),
      s('2026-07-04T10:12:00'), // human within T_gap
    ];
    const r = computeWorkTime(rows, S7);
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0].class).toBe('work');
    expect(r.agentOnlyMs).toBe(0);
    expect(r.workMs).toBeGreaterThan(0);
  });

  it('a DIFFERENT aiChatId breaks the burst — two agent runs, idle gap excluded', () => {
    // Run c1 ends 10:05, run c2 starts 10:20 (15m > agentTGap 7m) → two sessions.
    const rows = [
      s('2026-07-04T10:00:00', { source: 'agent', chat: 'c1', kind: 'agent' }),
      s('2026-07-04T10:05:00', { source: 'agent', chat: 'c1', kind: 'agent' }),
      s('2026-07-04T10:20:00', { source: 'agent', chat: 'c2', kind: 'agent' }),
      s('2026-07-04T10:25:00', { source: 'agent', chat: 'c2', kind: 'agent' }),
    ];
    const r = computeWorkTime(rows); // default agentTGap = 7m
    expect(r.sessions).toHaveLength(2);
    expect(r.sessions.every((x) => x.class === 'agent_only')).toBe(true);
    // The 15m idle gap between the two runs is NOT counted.
    const run1 = 5 * MIN + 5 * MIN + 5 * MIN; // pIn + span + pOut
    expect(r.agentOnlyMs).toBe(2 * run1);
  });

  it('idle pulse (same/null run) is a full activity sample that continues a burst', () => {
    const rows = [
      s('2026-07-04T10:00:00', { source: 'agent', chat: 'c1', kind: 'agent' }),
      // idle flush 4m later, null run id → continues the burst, not a new one
      s('2026-07-04T10:04:00', { source: 'agent', chat: null, kind: 'idle' }),
      s('2026-07-04T10:08:00', { source: 'agent', chat: 'c1', kind: 'agent' }),
    ];
    const r = computeWorkTime(rows);
    expect(r.sessions).toHaveLength(1);
    // burst span 10:00→10:08 (+pIn/pOut) = 8 + 10 = 18m
    expect(r.agentOnlyMs).toBe(18 * MIN);
  });

  it('a USER-sourced idle breaks an agent burst → session is work, not agent_only', () => {
    // A human supervision idle inherits source=user (aiChatId:null) and must NOT
    // be swallowed into the agent burst. Δ=3m is within the default agentTGap so
    // the two samples stay one session — but its class flips to `work`.
    const rows = [
      s('2026-07-04T10:00:00', { source: 'agent', chat: 'c1', kind: 'agent' }),
      s('2026-07-04T10:03:00', { source: 'user', chat: null, kind: 'idle' }),
    ];
    const r = computeWorkTime(rows);
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0].class).toBe('work');
    expect(r.workMs).toBeGreaterThan(0);
    // The human idle is NOT captured as agent_only time.
    expect(r.agentOnlyMs).toBe(0);
    // Σ over `work` sessions == workMs and Σ over `agent_only` == agentOnlyMs.
    const sum = (cls: string) =>
      r.sessions
        .filter((x) => x.class === cls)
        .reduce((acc, x) => acc + (x.end - x.start), 0);
    expect(sum('work')).toBe(r.workMs);
    expect(sum('agent_only')).toBe(r.agentOnlyMs);
  });

  it('idle pulse keeps a human writing session visible (not excluded)', () => {
    const rows = [
      s('2026-07-04T10:00:00'),
      s('2026-07-04T10:08:00', { kind: 'idle' }), // pulse within T_gap
      s('2026-07-04T10:15:00'),
    ];
    const r = computeWorkTime(rows);
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0].class).toBe('work');
    // span 10:00→10:15 + pIn/pOut = 15 + 10 = 25m
    expect(r.workMs).toBe(25 * MIN);
  });

  it('git-source samples are excluded (§10 excludeGit)', () => {
    const rows = [
      s('2026-07-04T10:00:00', { source: 'git', kind: 'boundary' }),
      s('2026-07-04T10:01:00', { source: 'git', kind: 'boundary' }),
    ];
    expect(computeWorkTime(rows).workMs).toBe(0);
    // ...but honoured off:
    expect(
      computeWorkTime(rows, { excludeGit: false }).workMs,
    ).toBeGreaterThan(0);
  });

  it('rejects an invalid config (tGap < pIn + pOut)', () => {
    expect(() =>
      computeWorkTime([s('2026-07-04T10:00:00')], {
        tGap: 5 * MIN,
        pIn: 5 * MIN,
        pOut: 5 * MIN,
      }),
    ).toThrow(/tGap/);
  });

  it('rejects an invalid config (2·agentTGap < pIn + pOut)', () => {
    // tGap (default 15m) still ≥ pIn+pOut, so only the 2·agentTGap guard trips.
    // Without it a short session of one class between two of the other could
    // produce a NON-adjacent cross-class overlap the adjacent-only clip misses.
    expect(() =>
      computeWorkTime([s('2026-07-04T10:00:00')], {
        agentTGap: 2 * MIN,
        pIn: 5 * MIN,
        pOut: 5 * MIN,
      }),
    ).toThrow(/agentTGap/);
  });

  // F1 — cross-class double-count. On the DEFAULT config agentTGap (7m) < pIn+pOut
  // (10m), so a `work` session ending in an agent segment and a nearby separate
  // `agent_only` run (gap in (7m,10m]) used to produce OVERLAPPING padded
  // intervals — the same wall-clock counted into BOTH workMs and agentOnlyMs. The
  // cross-class padding clip must make the two per-class unions disjoint.
  it('does NOT double-count wall-clock across work/agent_only (§F1)', () => {
    // user@0s ; agent(chatX)@60s (breaks into a work session with the human) ;
    // agent(chatY)@560s,590s (a separate agent_only run). Raw gap between the work
    // session (ends 60s) and the agent run (starts 560s) is 500s ∈ (agentTGap,
    // pIn+pOut] once padded — the classic overlap window.
    const rows: TimelineSample[] = [
      s('2026-07-04T00:00:00'), // user @ 0s
      s('2026-07-04T00:01:00', { source: 'agent', chat: 'cX', kind: 'agent' }), // @ 60s
      s('2026-07-04T00:09:20', { source: 'agent', chat: 'cY', kind: 'agent' }), // @ 560s
      s('2026-07-04T00:09:50', { source: 'agent', chat: 'cY', kind: 'agent' }), // @ 590s
    ];
    const r = computeWorkTime(rows); // DEFAULT config

    // Both classes present.
    expect(r.workMs).toBeGreaterThan(0);
    expect(r.agentOnlyMs).toBeGreaterThan(0);

    // Per-class metrics are exactly their own union (union, not Σ).
    expect(r.workMs).toBe(unionMs(ivsOf(r.sessions, 'work')));
    expect(r.agentOnlyMs).toBe(unionMs(ivsOf(r.sessions, 'agent_only')));

    // The F1 invariant: work-union and agent-union are cross-class-disjoint, so
    // the union of ALL padded intervals equals workMs + agentOnlyMs (no overlap).
    // With the clip disabled this fails (union < sum by the 100s overlap).
    expect(unionMs(ivsOf(r.sessions))).toBe(r.workMs + r.agentOnlyMs);
  });

  // F1 property/fuzz — random timelines across several timezones must uphold the
  // work-time invariants. Backs the (corrected) PR claim of a real fuzz test.
  it('property: random timelines uphold union & cross-class-disjoint invariants', () => {
    // Deterministic LCG (numerical-recipes constants) so a failure is reproducible.
    let seed = 0x9e3779b9 >>> 0;
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];

    const tzs = [
      'UTC',
      'America/New_York',
      'Europe/Moscow',
      'Australia/Lord_Howe', // 30-min DST offset — a nasty bucket stress
    ];
    const base = Date.UTC(2026, 5, 1, 0, 0, 0); // 2026-06-01Z
    const chats = ['c1', 'c2', 'c3'];

    for (let iter = 0; iter < 250; iter++) {
      const tz = pick(tzs);
      const n = 2 + Math.floor(rand() * 18); // 2..19 rows
      const rows: TimelineSample[] = [];
      // Walk time forward by a random inter-sample gap. The gap distribution is
      // centred on the DANGEROUS band — a bit under to a bit over pIn+pOut (10m)
      // AND straddling agentTGap (7m) — so adjacent samples routinely split into
      // separate sessions whose ±P padding would overlap if a class boundary sits
      // there. Mixing user/agent classes at these gaps reliably manufactures the
      // work-ending-in-agent → agent_only cross-class boundary F1 is about, plus
      // dense within-class runs (occasional 0–2m gaps) that exercise the union.
      let t = base + Math.floor(rand() * 60 * MIN);
      for (let i = 0; i < n; i++) {
        const roll = rand();
        const gap =
          roll < 0.25
            ? Math.floor(rand() * 2 * MIN) // dense burst (same-class union)
            : roll < 0.85
              ? 5 * MIN + Math.floor(rand() * 8 * MIN) // 5–13m: the split band
              : 20 * MIN + Math.floor(rand() * 40 * MIN); // long idle → new day-ish
        t += gap;
        const iso = new Date(t).toISOString().slice(0, 19); // 'YYYY-MM-DDTHH:MM:SS'
        const isAgent = rand() < 0.5;
        rows.push(
          isAgent
            ? s(iso, { source: 'agent', chat: pick(chats), kind: 'agent' })
            : s(iso, { source: 'user', kind: rand() < 0.3 ? 'idle' : 'manual' }),
        );
      }

      const r = computeWorkTime(rows); // DEFAULT config

      const workIvs = ivsOf(r.sessions, 'work');
      const agentIvs = ivsOf(r.sessions, 'agent_only');

      // (1) each metric is exactly its per-class union (catches a union→Σ regress).
      expect(r.workMs).toBe(unionMs(workIvs));
      expect(r.agentOnlyMs).toBe(unionMs(agentIvs));

      // (2) NO cross-class overlap: union(all) == workMs + agentOnlyMs (F1).
      expect(unionMs(ivsOf(r.sessions))).toBe(r.workMs + r.agentOnlyMs);

      // (3) bucket invariant: Σ per-day activeMs == workMs (§6.3).
      const perDay = bucketByDay(r.sessions, tz);
      const sumActive = perDay.reduce((a, d) => a + d.activeMs, 0);
      expect(sumActive).toBe(r.workMs);
    }
  });
});
