import { describe, expect, it } from 'vitest';
import {
  sanitizeCssColor,
  clampCalloutType,
  encodeHtmlEmbedSource,
  decodeHtmlEmbedSource,
} from '../src/lib/docmost-schema.js';

// These tests pin the two security/normalization helpers that Docmost
// interpolates into inline style and the callout banner type on re-render.
// They are the allowlist guard (XSS/style-breakout boundary) and the
// case-insensitive callout normalizer, both otherwise only exercised
// indirectly through parseHTML/renderHTML.

describe('sanitizeCssColor', () => {
  it('accepts a plain named color unchanged', () => {
    expect(sanitizeCssColor('red')).toBe('red');
  });

  it('accepts 3-digit and 6-digit hex colors unchanged', () => {
    expect(sanitizeCssColor('#abc')).toBe('#abc');
    expect(sanitizeCssColor('#aabbcc')).toBe('#aabbcc');
  });

  it('accepts well-formed functional notation unchanged', () => {
    expect(sanitizeCssColor('rgb(1,2,3)')).toBe('rgb(1,2,3)');
    expect(sanitizeCssColor('rgba(0,0,0,0.5)')).toBe('rgba(0,0,0,0.5)');
    expect(sanitizeCssColor('hsl(120,50%,50%)')).toBe('hsl(120,50%,50%)');
  });

  it('trims surrounding whitespace before matching', () => {
    // '  blue  ' trims to 'blue', which is a valid named color.
    expect(sanitizeCssColor('  blue  ')).toBe('blue');
  });

  it('rejects a style-injection payload (returns null)', () => {
    expect(sanitizeCssColor('red; --x: url(x)')).toBeNull();
  });

  it('rejects an attribute-breakout payload (returns null)', () => {
    expect(sanitizeCssColor('red"><script>')).toBeNull();
  });

  it('rejects the empty string (returns null)', () => {
    expect(sanitizeCssColor('')).toBeNull();
  });

  it('rejects non-string input via the typeof guard (returns null)', () => {
    // @ts-expect-error deliberately passing a non-string to exercise the guard
    expect(sanitizeCssColor(123)).toBeNull();
  });
});

describe('clampCalloutType', () => {
  it('lowercases an uppercase valid type', () => {
    expect(clampCalloutType('INFO')).toBe('info');
  });

  it('lowercases a mixed-case valid type', () => {
    expect(clampCalloutType('Warning')).toBe('warning');
  });

  it('passes through already-lowercase valid types', () => {
    expect(clampCalloutType('danger')).toBe('danger');
    expect(clampCalloutType('success')).toBe('success');
  });

  it('PRESERVES every editor-canonical type (note/default no longer flattened)', () => {
    // Regression for the QA "callout type -> [!info]" fidelity loss: `note` and
    // `default` are valid editor callout types and must survive the git
    // round-trip, not collapse to `info`.
    expect(clampCalloutType('note')).toBe('note');
    expect(clampCalloutType('default')).toBe('default');
    expect(clampCalloutType('info')).toBe('info');
    expect(clampCalloutType('warning')).toBe('warning');
    expect(clampCalloutType('danger')).toBe('danger');
    expect(clampCalloutType('success')).toBe('success');
  });

  it('maps GitHub/Obsidian alert ALIASES to the editor banner (not flatly info)', () => {
    // The editor schema has no tip/caution/important callout node — they are input
    // aliases the editor's own paste path maps onto the supported set
    // (GITHUB_ALERT_TYPE_MAP in editor-ext). git-sync mirrors that aliasing so an
    // ingested `> [!tip]` / `> [!caution]` lands on the closest real banner instead
    // of collapsing everything to `info`.
    expect(clampCalloutType('tip')).toBe('success');
    expect(clampCalloutType('TIP')).toBe('success');
    expect(clampCalloutType('caution')).toBe('danger');
    expect(clampCalloutType('important')).toBe('info');
  });

  it('falls back to "info" for genuinely unknown types', () => {
    expect(clampCalloutType('question')).toBe('info');
    expect(clampCalloutType('banana')).toBe('info');
  });

  it('falls back to "info" for empty string and null', () => {
    expect(clampCalloutType('')).toBe('info');
    expect(clampCalloutType(null)).toBe('info');
  });
});

// The htmlEmbed `source` rides the data-source attribute base64-encoded so the
// raw HTML/CSS/JS stays inert and double-encoding-free across a round trip.
// Encode/decode MUST be exact inverses (incl. UTF-8) or the embed body corrupts.
describe('encode/decodeHtmlEmbedSource', () => {
  it('round-trips ASCII HTML losslessly', () => {
    const src = '<b>hi</b>';
    expect(decodeHtmlEmbedSource(encodeHtmlEmbedSource(src))).toBe(src);
  });

  it('round-trips multi-byte UTF-8 (Cyrillic + emoji) losslessly', () => {
    const src = '<p>Привет, мир 🌍 — café</p>';
    const encoded = encodeHtmlEmbedSource(src);
    // It is actually encoded (not passed through verbatim).
    expect(encoded).not.toBe(src);
    expect(decodeHtmlEmbedSource(encoded)).toBe(src);
  });

  it('maps empty string to empty string both ways', () => {
    expect(encodeHtmlEmbedSource('')).toBe('');
    expect(decodeHtmlEmbedSource('')).toBe('');
  });
});
