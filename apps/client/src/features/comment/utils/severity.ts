// Severity of an agent suggested-edit, parsed CLIENT-SIDE from the importance
// tag the editorial role prompts emit at the head of the comment body
// (`[Критично]` / `[Существенно]` / `[Незначительно]`, or their English
// equivalents). It is a DISPLAY-ONLY signal: it drives the coloured dot on the
// edit card and the "M major" counter in a run header. It never gates an action.
//
// `unknown` is a first-class value, NOT a synonym for `minor`: any bracketed
// text that is not in the exact dictionary — a Fact-checker verdict
// (`[Неверно]`, `[Не проверено]`, `[Непроверяемо]`, `[Это мнение]`), a typo
// (`[Существенное]`), or the absence of a tag — resolves to `unknown` and draws
// a neutral dot. Passing an unrecognised tag off as `minor` would mis-label it.
export type Severity = "critical" | "major" | "minor" | "unknown";

// EXACT (case-insensitive) dictionary. Only these tokens map to a real severity;
// everything else falls through to `unknown` on purpose.
const SEVERITY_TAGS: Record<string, Severity> = {
  критично: "critical",
  существенно: "major",
  незначительно: "minor",
  critical: "critical",
  major: "major",
  minor: "minor",
};

// Parse the first RECOGNISED importance tag out of the flattened comment text
// (use `commentContentToText` to obtain it). Scans every `[...]` token so a tag
// that trails a verdict still counts; the first exact-dictionary hit wins. When
// no token matches the dictionary the result is `unknown`. PURE — no React/DOM.
export function parseSeverity(text: string): Severity {
  if (!text) return "unknown";
  const matches = text.matchAll(/\[([^\]]+)\]/g);
  for (const m of matches) {
    const tag = m[1].trim().toLowerCase();
    const sev = SEVERITY_TAGS[tag];
    if (sev) return sev;
  }
  return "unknown";
}

// Whether a severity counts toward the "M major" tally in a run header: only the
// genuinely significant ones (major + critical). `minor` and `unknown` do not.
export function isSignificant(severity: Severity): boolean {
  return severity === "major" || severity === "critical";
}
