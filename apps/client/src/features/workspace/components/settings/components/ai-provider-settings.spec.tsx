import { describe, it, expect } from 'vitest';
import {
  resolveCardStatus,
  isEndpointConfigured,
  resolveKeyField,
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
