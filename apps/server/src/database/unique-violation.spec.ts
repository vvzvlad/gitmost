import { isUniqueViolation, violatedConstraint } from './utils';

/**
 * Unit tests for the driver-bound Postgres unique-violation helpers extracted
 * from the share-alias service (and now shared with favorite.repo). They encode
 * two `kysely-postgres-js` / `postgres@3.x` quirks: the SQLSTATE is the string
 * `'23505'`, and the violated index name arrives as `constraint_name` (with
 * `constraint` only a fallback for other drivers).
 */
describe('isUniqueViolation', () => {
  it('is true for a 23505 error', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
  });

  it('is false for any other code', () => {
    expect(isUniqueViolation({ code: '08006' })).toBe(false);
  });

  it('is false when there is no code / not an object', () => {
    expect(isUniqueViolation({})).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
  });
});

describe('violatedConstraint', () => {
  it('reads the postgres@3.x `constraint_name` field', () => {
    expect(
      violatedConstraint({ code: '23505', constraint_name: 'idx_a' }),
    ).toBe('idx_a');
  });

  it('falls back to `constraint` when `constraint_name` is absent', () => {
    expect(violatedConstraint({ code: '23505', constraint: 'idx_b' })).toBe(
      'idx_b',
    );
  });

  it('prefers `constraint_name` over `constraint` when both are present', () => {
    expect(
      violatedConstraint({ constraint_name: 'idx_a', constraint: 'idx_b' }),
    ).toBe('idx_a');
  });

  it('is undefined when neither field is present', () => {
    expect(violatedConstraint({ code: '23505' })).toBeUndefined();
    expect(violatedConstraint(null)).toBeUndefined();
    expect(violatedConstraint(undefined)).toBeUndefined();
  });
});
