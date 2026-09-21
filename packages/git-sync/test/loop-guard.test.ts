import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { bodyHash } from '../src/engine/loop-guard.js';

// Loop-guard body hash (SPEC §10 "хэш тела"). The hash is the signal a future
// pull-side poll-suppression uses to recognize our OWN write. It MUST be
// deterministic (same input -> same hash) and discriminating (different input ->
// different hash).

describe('bodyHash (pure, SPEC §10)', () => {
  it('is deterministic — same input yields the same hash', () => {
    const body = '# Title\n\nsome body with <span data-comment-id="x">mark</span>\n';
    expect(bodyHash(body)).toBe(bodyHash(body));
  });

  it('differs for different input', () => {
    expect(bodyHash('alpha')).not.toBe(bodyHash('beta'));
    // Even a one-character difference produces a different digest.
    expect(bodyHash('alpha')).not.toBe(bodyHash('alphb'));
  });

  it('returns lowercase sha256 hex (64 chars)', () => {
    const h = bodyHash('hello');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // Matches an independent sha256 of the same UTF-8 bytes.
    expect(h).toBe(createHash('sha256').update('hello', 'utf8').digest('hex'));
  });

  it('hashes the empty string to the well-known sha256 empty digest', () => {
    expect(bodyHash('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('is sensitive to UTF-8 content (Cyrillic body)', () => {
    expect(bodyHash('Колонка')).not.toBe(bodyHash('Колонкa'));
    expect(bodyHash('Колонка')).toBe(
      createHash('sha256').update('Колонка', 'utf8').digest('hex'),
    );
  });
});
