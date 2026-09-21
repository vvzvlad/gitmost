import { bucketByDay, zonedDayStart } from './bucket-by-day';
import { computeWorkTime } from './compute-work-time';
import { WorkSession, TimelineSample } from './work-time.types';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function work(start: number, end: number): WorkSession {
  return { start, end, class: 'work' };
}
function agent(start: number, end: number): WorkSession {
  return { start, end, class: 'agent_only' };
}

function sumActive(perDay: ReturnType<typeof bucketByDay>): number {
  return perDay.reduce((a, d) => a + d.activeMs, 0);
}

describe('bucketByDay', () => {
  it('Σ activeMs == workMs — the §6.3 consistency invariant', () => {
    const rows: TimelineSample[] = [
      { createdAt: '2026-07-04T03:40:00Z', lastUpdatedById: 'h', lastUpdatedSource: 'user', lastUpdatedAiChatId: null, kind: null },
      { createdAt: '2026-07-04T03:49:00Z', lastUpdatedById: 'h', lastUpdatedSource: 'user', lastUpdatedAiChatId: null, kind: null },
      { createdAt: '2026-07-04T18:11:00Z', lastUpdatedById: 'h', lastUpdatedSource: 'user', lastUpdatedAiChatId: null, kind: null },
      { createdAt: '2026-07-06T15:34:00Z', lastUpdatedById: 'h', lastUpdatedSource: 'user', lastUpdatedAiChatId: null, kind: null },
    ];
    const r = computeWorkTime(rows);
    const perDay = bucketByDay(r.sessions, 'UTC');
    expect(sumActive(perDay)).toBe(r.workMs);
  });

  it('empty input → no days', () => {
    expect(bucketByDay([], 'UTC')).toEqual([]);
  });

  it('midnight-crossing session splits across two days, sum preserved (§9#9)', () => {
    const start = Date.UTC(2026, 0, 10, 23, 14);
    const end = Date.UTC(2026, 0, 11, 0, 40);
    const perDay = bucketByDay([work(start, end)], 'UTC');
    expect(perDay).toHaveLength(2);
    expect(perDay[0].dayISO).toBe('2026-01-10');
    expect(perDay[1].dayISO).toBe('2026-01-11');
    expect(perDay[0].activeMs).toBe(46 * MIN); // 23:14 → 24:00
    expect(perDay[1].activeMs).toBe(40 * MIN); // 00:00 → 00:40
    expect(sumActive(perDay)).toBe(end - start);
  });

  it('empty days between active days are emitted, not skipped (§9#12)', () => {
    const d1 = work(Date.UTC(2026, 0, 10, 10, 0), Date.UTC(2026, 0, 10, 11, 0));
    const d3 = work(Date.UTC(2026, 0, 12, 10, 0), Date.UTC(2026, 0, 12, 11, 0));
    const perDay = bucketByDay([d1, d3], 'UTC');
    expect(perDay.map((d) => d.dayISO)).toEqual([
      '2026-01-10',
      '2026-01-11',
      '2026-01-12',
    ]);
    expect(perDay[1].activeMs).toBe(0);
    expect(perDay[1].windows).toEqual([]);
  });

  it('agent_only windows are drawn but excluded from activeMs', () => {
    const w = work(Date.UTC(2026, 0, 10, 9, 0), Date.UTC(2026, 0, 10, 10, 0));
    const a = agent(Date.UTC(2026, 0, 10, 14, 0), Date.UTC(2026, 0, 10, 14, 30));
    const perDay = bucketByDay([w, a], 'UTC');
    expect(perDay).toHaveLength(1);
    expect(perDay[0].activeMs).toBe(1 * HOUR);
    expect(perDay[0].agentMs).toBe(30 * MIN);
    expect(perDay[0].windows.map((x) => x.class)).toEqual(['work', 'agent_only']);
  });

  it('work and agent_only are unioned SEPARATELY (agent does not swallow work)', () => {
    // Overlapping work + agent windows on the same day.
    const w = work(Date.UTC(2026, 0, 10, 9, 0), Date.UTC(2026, 0, 10, 11, 0));
    const a = agent(Date.UTC(2026, 0, 10, 10, 0), Date.UTC(2026, 0, 10, 12, 0));
    const perDay = bucketByDay([w, a], 'UTC');
    expect(perDay[0].activeMs).toBe(2 * HOUR);
    expect(perDay[0].agentMs).toBe(2 * HOUR);
  });

  it('overlapping same-class sessions are UNIONed, not summed (no double-count)', () => {
    // Two work sessions that overlap 10:00–10:30 on one day.
    const a = work(Date.UTC(2026, 0, 10, 9, 0), Date.UTC(2026, 0, 10, 10, 30));
    const b = work(Date.UTC(2026, 0, 10, 10, 0), Date.UTC(2026, 0, 10, 11, 0));
    const perDay = bucketByDay([a, b], 'UTC');
    expect(perDay).toHaveLength(1);
    // Union 09:00–11:00 = 2h, NOT 90m + 60m = 150m.
    expect(perDay[0].activeMs).toBe(2 * HOUR);
    // The drawn windows are also merged to one, so the punch-card cannot render
    // an overlapping double bar.
    expect(perDay[0].windows).toHaveLength(1);
    expect(perDay[0].windows[0].start).toBe(a.start);
    expect(perDay[0].windows[0].end).toBe(b.end);
  });

  it('DST fall-back: a full 25-hour day still balances (§9#14)', () => {
    // America/New_York ends DST 2026-11-01 (25h day).
    const tz = 'America/New_York';
    const dayStart = zonedDayStart(Date.UTC(2026, 10, 1, 12, 0), tz);
    const nextStart = zonedDayStart(dayStart + 26 * HOUR, tz);
    expect(nextStart - dayStart).toBe(25 * HOUR);
    const perDay = bucketByDay([work(dayStart, nextStart)], tz);
    expect(perDay).toHaveLength(1);
    expect(perDay[0].dayISO).toBe('2026-11-01');
    expect(perDay[0].activeMs).toBe(25 * HOUR);
    expect(sumActive(perDay)).toBe(nextStart - dayStart);
  });

  it('DST spring-forward: a full 23-hour day still balances (§9#14)', () => {
    // America/New_York starts DST 2026-03-08 (23h day).
    const tz = 'America/New_York';
    const dayStart = zonedDayStart(Date.UTC(2026, 2, 8, 12, 0), tz);
    const nextStart = zonedDayStart(dayStart + 26 * HOUR, tz);
    expect(nextStart - dayStart).toBe(23 * HOUR);
    const perDay = bucketByDay([work(dayStart, nextStart)], tz);
    expect(perDay).toHaveLength(1);
    expect(perDay[0].activeMs).toBe(23 * HOUR);
    expect(sumActive(perDay)).toBe(nextStart - dayStart);
  });

  it('tz changes the day a session lands in but not the total', () => {
    const start = Date.UTC(2026, 0, 10, 2, 0); // 02:00 UTC
    const end = Date.UTC(2026, 0, 10, 3, 0);
    const utc = bucketByDay([work(start, end)], 'UTC');
    const ny = bucketByDay([work(start, end)], 'America/New_York'); // 21:00 prev day
    expect(utc[0].dayISO).toBe('2026-01-10');
    expect(ny[0].dayISO).toBe('2026-01-09');
    expect(sumActive(utc)).toBe(sumActive(ny));
  });
});
