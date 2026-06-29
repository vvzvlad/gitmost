import { describe, it, expect } from "vitest";
import { sanitizeCaption } from "@/features/editor/components/common/use-caption-control.tsx";

/**
 * `sanitizeCaption` = collapse every whitespace run to a single space + trim +
 * cap at 500 chars. Captions are plain visible text, so this is a softer
 * normalization than alt-text sanitization.
 */
describe("sanitizeCaption", () => {
  it("trims leading and trailing whitespace", () => {
    expect(sanitizeCaption("  hello  ")).toBe("hello");
  });

  it("collapses internal whitespace runs to a single space", () => {
    expect(sanitizeCaption("a   b    c")).toBe("a b c");
  });

  it("treats tab, newline and CRLF as whitespace", () => {
    expect(sanitizeCaption("a\tb")).toBe("a b");
    expect(sanitizeCaption("a\nb")).toBe("a b");
    expect(sanitizeCaption("a\r\nb")).toBe("a b");
    expect(sanitizeCaption("line1\n\n\nline2")).toBe("line1 line2");
  });

  it("treats unicode whitespace (no-break space) as a separator", () => {
    // U+00A0 NO-BREAK SPACE is matched by the \s class.
    expect(sanitizeCaption("a b")).toBe("a b");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(sanitizeCaption("   ")).toBe("");
    expect(sanitizeCaption("")).toBe("");
  });

  it("keeps a caption at the 500-char limit unchanged", () => {
    const exact = "x".repeat(500);
    expect(sanitizeCaption(exact)).toHaveLength(500);
    expect(sanitizeCaption(exact)).toBe(exact);
  });

  it("slices a caption longer than 500 chars down to 500", () => {
    const tooLong = "y".repeat(600);
    const result = sanitizeCaption(tooLong);
    expect(result).toHaveLength(500);
    expect(result).toBe("y".repeat(500));
  });

  it("collapses whitespace before applying the 500-char cap", () => {
    // 120 "a  b " groups (600 raw chars) collapse to "a b a b ..." = 479 chars
    // after trimming the trailing space, which stays under the 500 cap — so only
    // the collapse is exercised here, no slice. (See the dedicated >500 test
    // above for the slice boundary.)
    const input = "a  b ".repeat(120); // lots of double spaces
    const result = sanitizeCaption(input);
    expect(result).toHaveLength(479);
    expect(result.length).toBeLessThanOrEqual(500);
    expect(result).not.toMatch(/\s{2,}/);
  });
});
