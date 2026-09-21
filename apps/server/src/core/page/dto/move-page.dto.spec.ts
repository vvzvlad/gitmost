import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
// Imported exactly as page.service.ts does, so we test the real key generator
// that feeds `position` at the API boundary.
import { generateJitteredKeyBetween } from 'fractional-indexing-jittered';
import { MovePageDto } from './move-page.dto';

// PARITY BUG (Gitea #139, item 6): MovePageDto.position is bounded with
// @MinLength(5) @MaxLength(12), but the actual positions are fractional-indexing
// keys produced by `generateJitteredKeyBetween` (the same generator page.service
// uses). Those bounds do NOT match the generator's real output range:
//   - a freshly generated key (null,null) is short (~5 chars) and currently
//     squeaks past MinLength(5);
//   - but DENSE between-inserts (repeatedly inserting between two adjacent keys)
//     grow the key well past 12 chars, which MaxLength(12) would WRONGLY reject —
//     a valid ordering key the server itself generated would be refused on move.
//
// The tests below assert the CORRECT contract: any key the generator can produce
// must satisfy the DTO. FIXED (#495 item 9): the DTO now validates `position` by
// CHARSET ([0-9A-Za-z], the generator's base-62 alphabet) instead of the wrong
// @MaxLength(12) length bound, so dense between-inserts are accepted; the former
// `test.failing` bug-lock is now a passing assertion.

function constraintErrors(position: unknown) {
  const dto = plainToInstance(MovePageDto, {
    pageId: 'page-1',
    position,
  });
  return validate(dto as object);
}

function hasError(errors: any[], property: string) {
  return errors.some((e) => e.property === property);
}

describe('MovePageDto.position vs generateJitteredKeyBetween parity', () => {
  it('accepts a freshly generated first key', async () => {
    const key = generateJitteredKeyBetween(null, null);
    const errors = await constraintErrors(key);
    expect(hasError(errors, 'position')).toBe(false);
  });

  it('accepts a key appended after an existing key', async () => {
    const first = generateJitteredKeyBetween(null, null);
    const next = generateJitteredKeyBetween(first, null);
    const errors = await constraintErrors(next);
    expect(hasError(errors, 'position')).toBe(false);
  });

  // FIXED: dense between-inserts produce keys longer than 12 chars, which the old
  // MaxLength(12) rejected even though they are valid ordering keys. Now accepted.
  it('accepts dense between-inserted keys longer than 12 chars', async () => {
    let lo = generateJitteredKeyBetween(null, null);
    let hi = generateJitteredKeyBetween(lo, null);
    // Repeatedly insert just above `lo`, shrinking the gap so the key grows. The
    // generator is JITTERED (random), so use enough iterations that the longest
    // key reliably clears the old 12-char bound: measured min-over-50-trials is
    // ~11 at 40 iterations (flaky) but ~36 at 200 (robust margin).
    let longest = lo;
    for (let i = 0; i < 200; i++) {
      const mid = generateJitteredKeyBetween(lo, hi);
      if (mid.length > longest.length) longest = mid;
      hi = mid;
    }
    expect(longest.length).toBeGreaterThan(12); // sanity: we produced a long key
    const errors = await constraintErrors(longest);
    expect(hasError(errors, 'position')).toBe(false);
  });

  // The charset guard replaces the length bound: reject anything outside the
  // generator's [0-9A-Za-z] alphabet (control chars, separators, injection) and
  // the empty string, while still accepting every real key.
  it('rejects a position with characters outside the fractional-index alphabet', async () => {
    for (const bad of ['a0/b', 'a b', 'a\n0', 'a.b', '', "a';--"]) {
      const errors = await constraintErrors(bad);
      expect(hasError(errors, 'position')).toBe(true);
    }
  });
});
