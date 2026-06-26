import { normalizeLabelName } from './utils';

// Pins the server-side label normalizer used by the label repo/service/DTOs to
// dedupe labels. Contract: trim the ends, collapse every run of whitespace into
// a single hyphen, and lowercase. A regression here would let visually-identical
// labels (differing only by case or spacing) be treated as distinct.

describe('normalizeLabelName', () => {
  it('lowercases the name', () => {
    expect(normalizeLabelName('Bug')).toBe('bug');
    expect(normalizeLabelName('HIGH-PRIORITY')).toBe('high-priority');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizeLabelName('  bug  ')).toBe('bug');
  });

  it('collapses an internal run of spaces into a single hyphen', () => {
    expect(normalizeLabelName('high    priority')).toBe('high-priority');
  });

  it('replaces a single internal space with a hyphen', () => {
    expect(normalizeLabelName('in progress')).toBe('in-progress');
  });

  it('collapses tabs and newlines (any whitespace) into a single hyphen', () => {
    expect(normalizeLabelName('high\tpriority')).toBe('high-priority');
    expect(normalizeLabelName('high\npriority')).toBe('high-priority');
    expect(normalizeLabelName('high \t \n priority')).toBe('high-priority');
  });

  it('collapses unicode whitespace (e.g. non-breaking space) into a hyphen', () => {
    expect(normalizeLabelName('high priority')).toBe('high-priority');
  });

  it('applies trim, collapse and lowercase together', () => {
    expect(normalizeLabelName('  In   PROGRESS\t ')).toBe('in-progress');
  });

  it('leaves an already-normalized name unchanged', () => {
    expect(normalizeLabelName('high-priority')).toBe('high-priority');
  });
});
