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
// must satisfy the DTO. The genuinely-failing case is marked `test.failing` so the
// suite stays green while locking the bug; it flips red (alerting us) once the DTO
// bounds are widened to cover the generator's real range.

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

  // BUG LOCK: dense between-inserts produce keys longer than 12 chars, which
  // MaxLength(12) rejects even though they are valid ordering keys. This SHOULD
  // pass; it currently fails. Flips green when the DTO bound is fixed.
  test.failing(
    'accepts dense between-inserted keys (currently rejected by MaxLength(12))',
    async () => {
      let lo = generateJitteredKeyBetween(null, null);
      let hi = generateJitteredKeyBetween(lo, null);
      // Repeatedly insert just above `lo`, shrinking the gap so the key grows.
      let longest = lo;
      for (let i = 0; i < 40; i++) {
        const mid = generateJitteredKeyBetween(lo, hi);
        if (mid.length > longest.length) longest = mid;
        hi = mid;
      }
      expect(longest.length).toBeGreaterThan(12); // sanity: we produced a long key
      const errors = await constraintErrors(longest);
      expect(hasError(errors, 'position')).toBe(false);
    },
  );
});
