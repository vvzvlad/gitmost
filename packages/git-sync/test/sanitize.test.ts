import { describe, expect, it } from 'vitest';
import { sanitizeTitle, disambiguate } from '../src/engine/sanitize.js';

describe('sanitizeTitle', () => {
  it('passes a plain title through unchanged', () => {
    expect(sanitizeTitle('Getting Started')).toBe('Getting Started');
  });

  it('replaces every forbidden printable character with a dash', () => {
    // Forbidden set: / \ < > : " | ? *
    expect(sanitizeTitle('a/b\\c<d>e:f"g|h?i*j')).toBe('a-b-c-d-e-f-g-h-i-j');
  });

  it('replaces ASCII control characters with a dash', () => {
    // Build the input with explicit control code points (tab=9, newline=10) to
    // avoid editor escaping pitfalls. Control chars become "-" BEFORE
    // whitespace is collapsed, so they survive as dashes (not a folded space).
    const TAB = String.fromCharCode(9);
    const NL = String.fromCharCode(10);
    expect(sanitizeTitle('a b' + TAB + 'c' + NL + 'd')).toBe('a b-c-d');
  });

  it('collapses runs of plain whitespace to a single space and trims', () => {
    expect(sanitizeTitle('  hello   world  ')).toBe('hello world');
  });

  it('caps the length at 120 characters', () => {
    const long = 'x'.repeat(200);
    const out = sanitizeTitle(long);
    expect(out.length).toBe(120);
    expect(out).toBe('x'.repeat(120));
  });

  it('prefixes reserved Windows names with an underscore', () => {
    expect(sanitizeTitle('CON')).toBe('_CON');
    expect(sanitizeTitle('nul')).toBe('_nul');
    // The base name (before the first dot) is what matters.
    expect(sanitizeTitle('con.md')).toBe('_con.md');
  });

  it('does not flag names that merely contain a reserved word', () => {
    expect(sanitizeTitle('console')).toBe('console');
    expect(sanitizeTitle('Control')).toBe('Control');
  });

  it('returns "_" for empty or whitespace-only input', () => {
    expect(sanitizeTitle('')).toBe('_');
    expect(sanitizeTitle('   ')).toBe('_');
  });

  it('handles a title that is only forbidden characters', () => {
    // Each forbidden char becomes "-", so the result is non-empty and safe.
    expect(sanitizeTitle('///')).toBe('---');
  });

  it('neutralizes all-dot names so they cannot escape the vault', () => {
    // ".", "..", "..." (and whitespace-padded variants) are path-traversal
    // hazards as directory segments. The result must never be a pure-dot
    // segment and must contain no path separators.
    for (const input of ['.', '..', '...', ' .. ']) {
      const out = sanitizeTitle(input);
      expect(['.', '..', '...']).not.toContain(out);
      expect(/^\.+$/.test(out)).toBe(false);
      expect(out).not.toContain('/');
      expect(out).not.toContain('\\');
    }
    // The concrete prefixing behaviour (existing "_" safeguard).
    expect(sanitizeTitle('.')).toBe('_.');
    expect(sanitizeTitle('..')).toBe('_..');
    expect(sanitizeTitle('...')).toBe('_...');
    expect(sanitizeTitle(' .. ')).toBe('_..');
  });

  it('is deterministic — the same input yields the same output', () => {
    const title = 'Some / weird : title?';
    expect(sanitizeTitle(title)).toBe(sanitizeTitle(title));
  });
});

describe('sanitizeTitle — boundary trim and nullish input', () => {
  // Spec case 1: the length-cap branch (sanitize.ts lines ~79-81) does
  // `slice(0, MAX_LENGTH).trim()`. The inner `.trim()` after the cap only
  // does observable work when the 120-char slice boundary lands on whitespace.
  // Existing length tests use all-'x' input where that trim is a no-op, so the
  // "trim after cap" sub-branch is otherwise unexercised.
  //
  // NOTE(review): The spec's literal example input
  //   'x'.repeat(118) + '   ' + 'yyyyyyyyyy'
  // does NOT yield the spec's stated expected output 'x'.repeat(118). Whitespace
  // runs are collapsed (`/\s+/g` -> single space) BEFORE the length cap, so the
  // three spaces fold to one: the collapsed string is
  //   'x'.repeat(118) + ' ' + 'y'.repeat(10)   (length 129)
  // and the char at the slice boundary (index 119) is a 'y', not whitespace.
  // The actual result is 'x'.repeat(118) + ' y' (length 120) — the inner trim is
  // a no-op for that exact input. We assert that ACTUAL behavior first (so the
  // discrepancy is documented and locked down), then use a corrected input that
  // genuinely lands the cut inside whitespace to exercise the intended sub-branch.
  it('collapses the spec literal before capping, so its inner trim is a no-op', () => {
    const input = 'x'.repeat(118) + '   ' + 'y'.repeat(10);
    const out = sanitizeTitle(input);
    // Whitespace-run collapse happens before the cap, so the boundary is a 'y'.
    expect(out).toBe('x'.repeat(118) + ' y');
    expect(out.length).toBe(120);
  });

  it('drops a boundary space via the post-cap trim (lines ~79-81)', () => {
    // To genuinely land the slice(0,120) boundary ON whitespace AFTER collapse,
    // put a single token boundary at index 119: 119 non-space chars, then a run
    // of spaces (collapsed to one surviving space at index 119), then more text.
    // slice(0,120) === 'x'.repeat(119) + ' ', and the post-cap .trim() removes
    // that trailing space -> 'x'.repeat(119) (length 119, no trailing space).
    const input = 'x'.repeat(119) + ' '.repeat(5) + 'y'.repeat(10);
    const out = sanitizeTitle(input);
    expect(out).toBe('x'.repeat(119));
    expect(out.length).toBe(119);
    expect(out.endsWith(' ')).toBe(false);
    // The inner trim genuinely fired: without it the result would be
    // 'x'.repeat(119) + ' ' (length 120, trailing space).
    expect(out).not.toBe('x'.repeat(119) + ' ');
  });

  // Spec case 2: the function guards input with `(title ?? '')` (line ~74). The
  // nullish-coalescing branch — title being null/undefined rather than '' — is
  // not exercised by the existing tests (which pass '' and '   '). This is the
  // path that protects against a missing page title.
  it('returns "_" for null input without throwing', () => {
    let out!: string;
    expect(() => {
      out = sanitizeTitle(null as any);
    }).not.toThrow();
    expect(out).toBe('_');
    // No path separators in the produced name.
    expect(out).not.toContain('/');
    expect(out).not.toContain('\\');
  });

  it('returns "_" for undefined input without throwing', () => {
    let out!: string;
    expect(() => {
      out = sanitizeTitle(undefined as any);
    }).not.toThrow();
    expect(out).toBe('_');
    expect(out).not.toContain('/');
    expect(out).not.toContain('\\');
  });

  it('null and undefined inputs collapse to the same empty-name guard result', () => {
    expect(sanitizeTitle(null as any)).toBe(sanitizeTitle(undefined as any));
    expect(sanitizeTitle(null as any)).toBe(sanitizeTitle(''));
  });
});

describe('disambiguate', () => {
  it('appends a stable ~slugId suffix', () => {
    expect(disambiguate('Notes', 'abc123')).toBe('Notes ~abc123');
  });

  it('is deterministic for the same name and slugId', () => {
    expect(disambiguate('Notes', 'abc123')).toBe(
      disambiguate('Notes', 'abc123'),
    );
  });

  it('produces distinct names for colliding siblings', () => {
    const a = disambiguate('Notes', 'slug-a');
    const b = disambiguate('Notes', 'slug-b');
    expect(a).not.toBe(b);
  });
});
