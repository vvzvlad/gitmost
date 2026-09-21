/**
 * Parse an integer-ish environment variable with a default fallback.
 *
 * Used to read PROPERTY_SEED / PROPERTY_NUM_RUNS in the generative property
 * suites. An unset/empty/non-numeric value falls back to `dflt`, but an explicit
 * `"0"` is honored (a valid fast-check seed) — `Number(x) || dflt` would wrongly
 * swallow 0. See flat-roundtrip.property.test.ts / nested-roundtrip.property.test.ts.
 */
export const envInt = (v: string | undefined, dflt: number): number =>
  v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : dflt;
