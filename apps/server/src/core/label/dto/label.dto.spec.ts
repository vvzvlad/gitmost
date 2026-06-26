import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate, Matches } from 'class-validator';
import { AddLabelsDto } from './label.dto';

// API-boundary validation for label names. `AddLabelsDto.names` applies the
// matcher /^[a-z0-9_-][a-z0-9_~-]*$/ to every element (each: true): a name must
// start with a lowercase letter, digit, hyphen or underscore (NOT a tilde) and
// then contain only those plus tildes. This guards the label storage key against
// uppercase, whitespace, accents and tilde-leading names.
//
// NOTE: the production DTO also runs `@Transform(normalizeLabelName)` BEFORE the
// matcher (trim + collapse whitespace to '-' + lowercase). `normalizeLabelName`
// itself is already covered (utils.spec.ts), so we deliberately do two things:
//  1) lock the raw @Matches regex in isolation (a mirror DTO with ONLY the same
//     matcher) for the exact accept/reject set the regex must enforce; and
//  2) sanity-check the real AddLabelsDto end-to-end for inputs whose normalized
//     form still exercises the matcher.

// Mirrors ONLY the production matcher so we test the regex, not the transform.
class NameMatchProbe {
  @Matches(/^[a-z0-9_-][a-z0-9_~-]*$/)
  name: string;
}

async function matcherErrors(name: string) {
  const dto = plainToInstance(NameMatchProbe, { name });
  return validate(dto as object);
}

function hasError(errors: any[], property: string, constraint?: string) {
  const err = errors.find((e) => e.property === property);
  if (!err) return false;
  if (!constraint) return true;
  return Object.keys(err.constraints ?? {}).includes(constraint);
}

describe('label name @Matches regex', () => {
  it('accepts valid names', async () => {
    for (const name of ['foo', 'a~b', '1-2_3', '-lead']) {
      expect(hasError(await matcherErrors(name), 'name', 'matches')).toBe(false);
    }
  });

  it('rejects a tilde-leading name', async () => {
    expect(hasError(await matcherErrors('~lead'), 'name', 'matches')).toBe(true);
  });

  it('rejects whitespace, accents and empty', async () => {
    expect(hasError(await matcherErrors('a b'), 'name', 'matches')).toBe(true);
    expect(hasError(await matcherErrors('héllo'), 'name', 'matches')).toBe(true);
    expect(hasError(await matcherErrors(''), 'name', 'matches')).toBe(true);
  });
});

describe('AddLabelsDto.names (matcher applied per element)', () => {
  async function validateNames(names: unknown) {
    const dto = plainToInstance(AddLabelsDto, { pageId: 'p1', names });
    return validate(dto as object);
  }

  it('accepts a list of valid names', async () => {
    const errors = await validateNames(['foo', 'a~b', '1-2_3']);
    expect(hasError(errors, 'names', 'matches')).toBe(false);
  });

  it('rejects a tilde-leading name even after normalization', async () => {
    // normalizeLabelName lowercases/collapses whitespace but does not strip a
    // leading tilde, so the matcher still fails.
    const errors = await validateNames(['~lead']);
    expect(hasError(errors, 'names', 'matches')).toBe(true);
  });

  it('rejects an accented name even after normalization', async () => {
    const errors = await validateNames(['héllo']);
    expect(hasError(errors, 'names', 'matches')).toBe(true);
  });
});
