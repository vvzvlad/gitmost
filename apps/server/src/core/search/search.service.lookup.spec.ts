import { escapeLikePattern } from './search.service';

/**
 * Pure-function coverage for `escapeLikePattern` — LIKE-metacharacter escaping so
 * `%`/`_`/`\` are matched literally (the acceptance requirement that a query of
 * `%` or `_` does NOT match everything, #529 acceptance #10). The substring
 * branch's DB behaviour is covered by the integration spec.
 *
 * NOTE (#529): the old tiered `computeLookupScore` was replaced by RRF rank
 * fusion in the unified engine, so its unit coverage moved to the integration
 * ordering tests; only the escaping helper remains a pure unit here.
 */
describe('escapeLikePattern', () => {
  it('escapes the LIKE metacharacters % _ and \\', () => {
    expect(escapeLikePattern('%')).toBe('\\%');
    expect(escapeLikePattern('_')).toBe('\\_');
    expect(escapeLikePattern('\\')).toBe('\\\\');
  });

  it('escapes the backslash FIRST so it does not double-escape %/_', () => {
    // Input `\%` must become `\\` + `\%` = `\\\%`, not `\\%`.
    expect(escapeLikePattern('\\%')).toBe('\\\\\\%');
  });

  it('leaves ordinary technical chars (. - / digits) untouched', () => {
    expect(escapeLikePattern('backup-srv.local')).toBe('backup-srv.local');
    expect(escapeLikePattern('10.0.12')).toBe('10.0.12');
    expect(escapeLikePattern('WB-MGE-30D86B')).toBe('WB-MGE-30D86B');
    expect(escapeLikePattern('a/b')).toBe('a/b');
  });

  it('escapes only the metacharacters in a mixed string', () => {
    expect(escapeLikePattern('50%_off.zip')).toBe('50\\%\\_off.zip');
  });

  it('is null/undefined-safe', () => {
    expect(escapeLikePattern(undefined as any)).toBe('');
    expect(escapeLikePattern(null as any)).toBe('');
  });
});
