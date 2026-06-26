import {
  computeHistoryJob,
  resolveSource,
} from './persistence.extension';
import {
  HISTORY_FAST_INTERVAL,
  HISTORY_FAST_THRESHOLD,
  HISTORY_INTERVAL,
} from '../constants';

// A fixed clock + fixed createdAt make pageAge deterministic.
const NOW = 1_700_000_000_000;
const PAGE_ID = '550e8400-e29b-41d4-a716-446655440000';

// Build a minimal page whose age (NOW - createdAt) is exactly `ageMs`.
const pageAged = (ageMs: number) => ({
  id: PAGE_ID,
  createdAt: new Date(NOW - ageMs),
});

describe('computeHistoryJob', () => {
  it('agent edit → delay MUST be 0 and job id is source-keyed', () => {
    // INVARIANT (§15 H2 / persistence.extension): the agent delay MUST stay 0.
    // The worker re-reads the page row at run time, so any non-zero delay risks
    // snapshotting content a later human edit has already overwritten. This is
    // the load-bearing assertion of this spec — do not relax it.
    const { jobId, delay } = computeHistoryJob(pageAged(0), 'agent', NOW);
    expect(delay).toBe(0);
    expect(jobId).toBe(`${PAGE_ID}-agent`);
  });

  it('agent edit on an OLD page is still delay 0 (age never applies to agents)', () => {
    // Even when the page is far older than the fast threshold, the agent path
    // must short-circuit to 0 — age-based debounce is a human-only concern.
    const { jobId, delay } = computeHistoryJob(
      pageAged(HISTORY_FAST_THRESHOLD + 60_000),
      'agent',
      NOW,
    );
    expect(delay).toBe(0);
    expect(jobId).toBe(`${PAGE_ID}-agent`);
  });

  it('human edit on a YOUNG page (age < threshold) → fast interval, bare job id', () => {
    const { jobId, delay } = computeHistoryJob(
      pageAged(HISTORY_FAST_THRESHOLD - 1),
      'user',
      NOW,
    );
    expect(delay).toBe(HISTORY_FAST_INTERVAL);
    expect(jobId).toBe(PAGE_ID);
  });

  it('human edit on an OLD page (age > threshold) → standard interval', () => {
    const { jobId, delay } = computeHistoryJob(
      pageAged(HISTORY_FAST_THRESHOLD + 1),
      'user',
      NOW,
    );
    expect(delay).toBe(HISTORY_INTERVAL);
    expect(jobId).toBe(PAGE_ID);
  });

  it('boundary: pageAge EXACTLY === threshold takes the slow branch (the `<` is strict)', () => {
    // Off-by-one guard: the condition is `pageAge < HISTORY_FAST_THRESHOLD`, so
    // an age of exactly the threshold is NOT "fast" — it must use HISTORY_INTERVAL.
    const { delay } = computeHistoryJob(
      pageAged(HISTORY_FAST_THRESHOLD),
      'user',
      NOW,
    );
    expect(delay).toBe(HISTORY_INTERVAL);
  });

  it('treats any non-"agent" source string as human', () => {
    // resolveSource only ever yields 'agent' | 'user', but guard the contract:
    // the agent branch keys strictly on === 'agent'.
    const { jobId, delay } = computeHistoryJob(pageAged(0), 'user', NOW);
    expect(delay).toBe(HISTORY_FAST_INTERVAL);
    expect(jobId).toBe(PAGE_ID);
  });
});

describe('resolveSource (truth table)', () => {
  // (sticky, actor) → expected. Marker is OR of the sticky flag and actor==='agent'.
  it('sticky=false, actor=user → user', () => {
    expect(resolveSource(false, 'user')).toBe('user');
  });

  it('sticky=true, actor=user → agent (sticky wins)', () => {
    expect(resolveSource(true, 'user')).toBe('agent');
  });

  it('sticky=false, actor=agent → agent (current writer is the agent)', () => {
    expect(resolveSource(false, 'agent')).toBe('agent');
  });

  it('sticky=true, actor=agent → agent', () => {
    expect(resolveSource(true, 'agent')).toBe('agent');
  });

  it('sticky=false, actor=undefined → user (human collab path omits the claim)', () => {
    expect(resolveSource(false, undefined)).toBe('user');
  });
});
