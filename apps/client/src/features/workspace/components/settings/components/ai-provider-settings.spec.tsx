import { describe, it, expect } from 'vitest';
import { resolveCardStatus } from './ai-provider-settings';

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
