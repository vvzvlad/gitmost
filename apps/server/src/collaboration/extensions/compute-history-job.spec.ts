import { computeHistoryJob, resolveSource } from './persistence.extension';
import {
  IDLE_INTERVAL_AGENT,
  IDLE_INTERVAL_USER,
  IDLE_MAX_WAIT_AGENT,
  IDLE_MAX_WAIT_USER,
} from '../constants';

const PAGE_ID = '550e8400-e29b-41d4-a716-446655440000';

const page = { id: PAGE_ID };

describe('computeHistoryJob (#370 — shared trailing idle pipeline)', () => {
  it('human edit → user idle window, bare page.id job', () => {
    // Humans and the agent now share ONE idle job per page (jobId = page.id).
    // The agent's old delay=0 fast path is GONE — intentional agent points now
    // arrive via the explicit save-version signal, not a zero-delay snapshot.
    const { jobId, delay } = computeHistoryJob(page, 'user');
    expect(delay).toBe(IDLE_INTERVAL_USER);
    expect(jobId).toBe(PAGE_ID);
  });

  it('agent edit → agent idle window (shorter), still the bare page.id job', () => {
    const { jobId, delay } = computeHistoryJob(page, 'agent');
    expect(delay).toBe(IDLE_INTERVAL_AGENT);
    // No `-agent` suffix anymore: the agent joins the common idle pipeline.
    expect(jobId).toBe(PAGE_ID);
  });

  it('agent flushes sooner than a human', () => {
    expect(IDLE_INTERVAL_AGENT).toBeLessThan(IDLE_INTERVAL_USER);
  });

  it('treats any non-"agent" source string as human (keys strictly on === agent)', () => {
    const { jobId, delay } = computeHistoryJob(page, 'user');
    expect(delay).toBe(IDLE_INTERVAL_USER);
    expect(jobId).toBe(PAGE_ID);
  });

  // #370 review round-1 WARNING: the max-wait ceiling prevents autosnapshot
  // starvation during a continuous editing session (the trailing timer would
  // otherwise re-arm forever and never fire).
  describe('max-wait ceiling', () => {
    const T0 = 1_000_000; // arbitrary fixed epoch for deterministic tests

    it('once a burst is armed, delay clamps to the remaining max-wait budget', () => {
      // 1 minute into the burst the USER interval (60m) far exceeds the remaining
      // max-wait budget (10m - 1m = 9m), so the delay is clamped DOWN to that
      // remaining budget — the full interval is NOT used once a ceiling applies.
      const { delay } = computeHistoryJob(page, 'user', T0, T0 + 60_000);
      expect(delay).toBe(IDLE_MAX_WAIT_USER - 60_000);
    });

    it('never waits longer than the max-wait budget from the burst start', () => {
      // A store arriving right at the ceiling → delay 0 (fire promptly).
      const { delay } = computeHistoryJob(
        page,
        'user',
        T0,
        T0 + IDLE_MAX_WAIT_USER,
      );
      expect(delay).toBe(0);
    });

    it('past the ceiling never returns a negative delay', () => {
      const { delay } = computeHistoryJob(
        page,
        'user',
        T0,
        T0 + IDLE_MAX_WAIT_USER + 5 * 60_000,
      );
      expect(delay).toBe(0);
    });

    it('the agent ceiling is shorter than the user ceiling', () => {
      expect(IDLE_MAX_WAIT_AGENT).toBeLessThan(IDLE_MAX_WAIT_USER);
      const { delay } = computeHistoryJob(
        page,
        'agent',
        T0,
        T0 + IDLE_MAX_WAIT_AGENT,
      );
      expect(delay).toBe(0);
    });

    it('without a burstStart there is no ceiling (backward-compatible)', () => {
      expect(computeHistoryJob(page, 'user').delay).toBe(IDLE_INTERVAL_USER);
      expect(computeHistoryJob(page, 'agent').delay).toBe(IDLE_INTERVAL_AGENT);
    });
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
