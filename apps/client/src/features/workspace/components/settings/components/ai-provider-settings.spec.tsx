import { describe, it, expect } from 'vitest';
import {
  resolveCardStatus,
  isEndpointConfigured,
  resolveKeyField,
  nextReindexPollInterval,
  isReindexComplete,
  isReindexButtonLoading,
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
  const base = { now: 1_000, intervalMs: INTERVAL };

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

  it('stops once the run is finished AND fully indexed', () => {
    expect(
      nextReindexPollInterval({
        ...base,
        deadline: 10_000,
        status: { reindexing: false, indexedPages: 478, totalPages: 478 },
      }),
    ).toBe(false);
  });

  it('keeps polling within the deadline when not yet done and no active flag', () => {
    // First poll right after enqueue, before the worker publishes progress.
    expect(
      nextReindexPollInterval({
        ...base,
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
        status: { reindexing: true, indexedPages: 200, totalPages: 478 },
      }),
    ).toBe(false);
  });

  it('stops on an empty workspace (0 of 0) once the run is finished', () => {
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
    expect(isReindexComplete(undefined)).toBe(false);
  });

  it('false while a run is still active (even at indexed==total)', () => {
    expect(
      isReindexComplete({ reindexing: true, indexedPages: 478, totalPages: 478 }),
    ).toBe(false);
  });

  it('false when finished but not yet fully indexed', () => {
    expect(
      isReindexComplete({ reindexing: false, indexedPages: 120, totalPages: 478 }),
    ).toBe(false);
  });

  it('true once finished and fully indexed', () => {
    expect(
      isReindexComplete({ reindexing: false, indexedPages: 478, totalPages: 478 }),
    ).toBe(true);
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
