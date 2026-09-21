import { describe, it, expect } from 'vitest';
import {
  resolveCardStatus,
  isEndpointConfigured,
  resolveKeyField,
  nextReindexPollInterval,
  isReindexComplete,
  isReindexButtonLoading,
  reindexRunKey,
  isNewReindexRun,
} from './ai-provider-settings';

describe('resolveCardStatus', () => {
  it('returns "off" when not configured and not enabled', () => {
    expect(resolveCardStatus(false, false)).toBe('off');
  });

  it('returns "warning" when enabled but not configured (misconfig, not silent "off")', () => {
    expect(resolveCardStatus(false, true)).toBe('warning');
  });

  it('returns "configured" when configured but disabled', () => {
    expect(resolveCardStatus(true, false)).toBe('configured');
  });

  it('returns "ready" when configured and enabled', () => {
    expect(resolveCardStatus(true, true)).toBe('ready');
  });
});

describe('isEndpointConfigured', () => {
  it('configured when model and the endpoint own base URL are set', () => {
    expect(isEndpointConfigured('m', 'https://own', '')).toBe(true);
  });

  it('configured by inheriting the chat base URL when own base is empty', () => {
    expect(isEndpointConfigured('m', '', 'https://chat')).toBe(true);
  });

  it('not configured when model is set but both base URLs are empty', () => {
    expect(isEndpointConfigured('m', '', '')).toBe(false);
  });

  it('not configured when both base URLs are whitespace-only', () => {
    expect(isEndpointConfigured('m', '   ', '\t')).toBe(false);
  });

  it('not configured when the model is whitespace-only', () => {
    expect(isEndpointConfigured('   ', 'https://own', 'https://chat')).toBe(
      false,
    );
  });
});

describe('resolveKeyField (write-only key payload)', () => {
  // The same logic backs all three keys (chat / embedding / stt) in buildPayload.
  it('typed a value -> set the new key', () => {
    expect(resolveKeyField('sk-new', false)).toEqual({
      set: true,
      value: 'sk-new',
    });
  });

  it('typed a value wins even if cleared was also flagged', () => {
    expect(resolveKeyField('sk-new', true)).toEqual({
      set: true,
      value: 'sk-new',
    });
  });

  it('cleared (empty buffer) -> set the key to empty string', () => {
    expect(resolveKeyField('', true)).toEqual({ set: true, value: '' });
  });

  it('untouched (empty buffer, not cleared) -> omit the key', () => {
    expect(resolveKeyField('', false)).toEqual({ set: false });
  });
});

describe('nextReindexPollInterval', () => {
  const INTERVAL = 5000;
  // `seenActive: true` is the steady state for most of a run — a poll has
  // observed `reindexing === true` (the server pre-seeds it from enqueue time).
  const base = { now: 1_000, intervalMs: INTERVAL, seenActive: true };

  it('does not poll when no reindex deadline is set', () => {
    expect(
      nextReindexPollInterval({
        ...base,
        deadline: null,
        status: { reindexing: true, indexedPages: 0, totalPages: 478 },
      }),
    ).toBe(false);
  });

  it('keeps polling while the server reports an active run', () => {
    expect(
      nextReindexPollInterval({
        ...base,
        deadline: 10_000,
        status: { reindexing: true, indexedPages: 120, totalPages: 478 },
      }),
    ).toBe(INTERVAL);
  });

  it('keeps polling during an active run even if counts momentarily look full', () => {
    // The run clears its progress record only at the very end, so a transient
    // indexed==total while reindexing is still true must NOT stop polling.
    expect(
      nextReindexPollInterval({
        ...base,
        deadline: 10_000,
        status: { reindexing: true, indexedPages: 478, totalPages: 478 },
      }),
    ).toBe(INTERVAL);
  });

  it('stops once the run is finished AND fully indexed (after having been active)', () => {
    expect(
      nextReindexPollInterval({
        ...base,
        deadline: 10_000,
        status: { reindexing: false, indexedPages: 478, totalPages: 478 },
      }),
    ).toBe(false);
  });

  it('does NOT stop on the stale pre-reindex snapshot (fully indexed, never seen active)', () => {
    // Regression for #262: right after "Reindex now" the client still holds the
    // PRE-reindex settings (an already fully-indexed workspace reads as
    // reindexing=false, indexed>=total). Without the seenActive gate this looked
    // "done" and stopped polling on the very first tick, freezing the counter at
    // 0 until a manual reload. The fresh window has not observed the active run,
    // so polling must continue until the first real poll lands.
    expect(
      nextReindexPollInterval({
        ...base,
        seenActive: false,
        deadline: 10_000,
        status: { reindexing: false, indexedPages: 478, totalPages: 478 },
      }),
    ).toBe(INTERVAL);
  });

  it('keeps polling within the deadline when not yet done and no active flag', () => {
    // First poll right after enqueue, before the worker publishes progress.
    expect(
      nextReindexPollInterval({
        ...base,
        seenActive: false,
        deadline: 10_000,
        status: { reindexing: false, indexedPages: 0, totalPages: 478 },
      }),
    ).toBe(INTERVAL);
  });

  it('cap always wins: stops once past the deadline even if still reindexing', () => {
    expect(
      nextReindexPollInterval({
        deadline: 1_000,
        now: 2_000, // past the deadline
        intervalMs: INTERVAL,
        seenActive: true,
        status: { reindexing: true, indexedPages: 200, totalPages: 478 },
      }),
    ).toBe(false);
  });

  it('stops on an empty workspace (0 of 0) once the run is finished', () => {
    // The pre-seed publishes reindexing=true even for 0 pages, so a poll sees the
    // run active before the worker clears -> seenActive latches true.
    expect(
      nextReindexPollInterval({
        ...base,
        deadline: 10_000,
        status: { reindexing: false, indexedPages: 0, totalPages: 0 },
      }),
    ).toBe(false);
  });
});

describe('isReindexComplete', () => {
  it('false when no status yet', () => {
    expect(isReindexComplete(undefined, true)).toBe(false);
  });

  it('false while a run is still active (even at indexed==total)', () => {
    expect(
      isReindexComplete(
        { reindexing: true, indexedPages: 478, totalPages: 478 },
        true,
      ),
    ).toBe(false);
  });

  it('false when finished but not yet fully indexed', () => {
    expect(
      isReindexComplete(
        { reindexing: false, indexedPages: 120, totalPages: 478 },
        true,
      ),
    ).toBe(false);
  });

  it('true once finished and fully indexed (after having been active)', () => {
    expect(
      isReindexComplete(
        { reindexing: false, indexedPages: 478, totalPages: 478 },
        true,
      ),
    ).toBe(true);
  });

  it('false on the stale pre-reindex snapshot: finished+fully indexed but never seen active', () => {
    // The just-started edge: the gate keeps this from clearing the poll deadline
    // before the first post-reindex poll arrives.
    expect(
      isReindexComplete(
        { reindexing: false, indexedPages: 478, totalPages: 478 },
        false,
      ),
    ).toBe(false);
  });
});

describe('reindexRunKey', () => {
  it('is null when the status carries no run identity', () => {
    expect(reindexRunKey(undefined)).toBeNull();
    expect(
      reindexRunKey({ reindexing: false, indexedPages: 5, totalPages: 5 }),
    ).toBeNull();
  });

  it('is null for a legacy/degraded record with an empty runId', () => {
    // The server sends runId='' for a record written before the field existed;
    // the client must treat that as "no identity" (fall back to prior behaviour).
    expect(
      reindexRunKey({
        reindexing: true,
        indexedPages: 0,
        totalPages: 10,
        runId: '',
        reindexStartedAt: 1000,
      }),
    ).toBeNull();
  });

  it('folds runId and startedAt into one stable key', () => {
    expect(
      reindexRunKey({
        reindexing: true,
        indexedPages: 0,
        totalPages: 10,
        runId: 'run-a',
        reindexStartedAt: 1000,
      }),
    ).toBe('run-a:1000');
  });

  it('changes when the runId changes for the same startedAt', () => {
    const a = reindexRunKey({
      reindexing: true,
      indexedPages: 0,
      totalPages: 10,
      runId: 'run-a',
      reindexStartedAt: 1000,
    });
    const b = reindexRunKey({
      reindexing: true,
      indexedPages: 0,
      totalPages: 10,
      runId: 'run-b',
      reindexStartedAt: 1000,
    });
    expect(a).not.toBe(b);
  });

  it('changes when the same runId restarts at a new startedAt', () => {
    const a = reindexRunKey({
      reindexing: true,
      indexedPages: 0,
      totalPages: 10,
      runId: 'run-a',
      reindexStartedAt: 1000,
    });
    const b = reindexRunKey({
      reindexing: true,
      indexedPages: 0,
      totalPages: 10,
      runId: 'run-a',
      reindexStartedAt: 2000,
    });
    expect(a).not.toBe(b);
  });
});

describe('isNewReindexRun (poll keying on runId)', () => {
  // Derive the status shape from the helper itself so the test needs no export
  // of the component-internal ReindexStatus type.
  type ReindexStatusLike = NonNullable<Parameters<typeof reindexRunKey>[0]>;
  const run = (runId: string, startedAt: number): ReindexStatusLike => ({
    reindexing: true,
    indexedPages: 0,
    totalPages: 10,
    runId,
    reindexStartedAt: startedAt,
  });

  it('first identity after none latched is a NEW run', () => {
    expect(isNewReindexRun(null, run('run-a', 1000))).toBe(true);
  });

  it('the SAME identity is not a new run (same run being watched)', () => {
    const key = reindexRunKey(run('run-a', 1000));
    expect(isNewReindexRun(key, run('run-a', 1000))).toBe(false);
  });

  it('a DIFFERENT runId is a new run (reset per-run poll state)', () => {
    const key = reindexRunKey(run('run-a', 1000));
    expect(isNewReindexRun(key, run('run-b', 1000))).toBe(true);
  });

  it('an identity-less poll (no runId / cleared record) is never a new run', () => {
    const key = reindexRunKey(run('run-a', 1000));
    expect(
      isNewReindexRun(key, {
        reindexing: false,
        indexedPages: 10,
        totalPages: 10,
      }),
    ).toBe(false);
  });

  it('a legacy empty-runId poll does not spuriously reset a latched run', () => {
    const key = reindexRunKey(run('run-a', 1000));
    expect(
      isNewReindexRun(key, {
        reindexing: true,
        indexedPages: 3,
        totalPages: 10,
        runId: '',
        reindexStartedAt: 1000,
      }),
    ).toBe(false);
  });
});

describe('isReindexButtonLoading', () => {
  it('loads while the POST mutation is pending', () => {
    expect(
      isReindexButtonLoading({
        mutationPending: true,
        deadline: null,
        status: false,
      }),
    ).toBe(true);
  });

  it('does NOT load post-cap: deadline nulled but reindexing left stale-true', () => {
    // The key case: after the poll cap fires `reindexDeadline` is null while
    // `settings.reindexing` can be a stale `true` from the last poll. Gating on
    // the deadline keeps the spinner from sticking forever so the admin can
    // restart.
    expect(
      isReindexButtonLoading({
        mutationPending: false,
        deadline: null,
        status: true,
      }),
    ).toBe(false);
  });

  it('loads during an active run within the poll window', () => {
    expect(
      isReindexButtonLoading({
        mutationPending: false,
        deadline: 10_000,
        status: true,
      }),
    ).toBe(true);
  });

  it('does not load once the run finished while still polling', () => {
    expect(
      isReindexButtonLoading({
        mutationPending: false,
        deadline: 10_000,
        status: false,
      }),
    ).toBe(false);
  });
});
