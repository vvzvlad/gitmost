import { describe, it, expect } from "vitest";
import { markdownToHtml } from "./marked.utils";

/**
 * Data-integrity regression (issue #204, Phase 2): plain prose that mentions
 * prices like `$5 and $6` must NOT be misread as inline math. The inline-math
 * tokenizer mutates a global `marked` singleton at import time
 * (`marked.utils.ts`), so math behaviour can only be exercised safely through
 * the public `markdownToHtml`; importing the tokenizer in isolation would give
 * a different, non-representative result. These assertions therefore drive the
 * real conversion path.
 */
function html(md: string): string {
  const out = markdownToHtml(md);
  if (typeof out !== "string") throw new Error("expected sync string output");
  return out;
}

const MATH_MARKERS = ['data-type="mathInline"', 'data-katex="true"'];

function hasInlineMath(out: string): boolean {
  return MATH_MARKERS.some((m) => out.includes(m));
}

describe("markdownToHtml: inline-math false positives", () => {
  it("does not treat prices `$5 and $6` as inline math", () => {
    const out = html("It costs $5 and $6 today.");
    expect(hasInlineMath(out)).toBe(false);
    // The text survives verbatim (no katex span swallowing it).
    expect(out).toContain("$5 and $6");
  });

  it("does not treat a single trailing price `$5` as inline math", () => {
    const out = html("Lunch was $5.");
    expect(hasInlineMath(out)).toBe(false);
    expect(out).toContain("$5");
  });

  it("does not treat `$5, $6, $7` (multiple prices) as inline math", () => {
    const out = html("Choose $5, $6, $7 plans.");
    expect(hasInlineMath(out)).toBe(false);
  });

  it("STILL converts a genuine inline-math expression `$x + y$`", () => {
    // Guard the positive path so the false-positive guard above can't be
    // satisfied by simply disabling math entirely.
    const out = html("The sum $x + y$ is shown.");
    expect(hasInlineMath(out)).toBe(true);
  });
});
