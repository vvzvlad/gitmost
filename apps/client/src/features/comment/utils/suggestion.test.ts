import { describe, it, expect } from "vitest";
import { computeSuggestionDiff, Segment } from "@/features/comment/utils/suggestion";

// Reconstruct the plain string from a segment stream — the diff must be
// lossless (concatenating every fragment yields the original input).
const join = (segments: Segment[]): string =>
  segments.map((s) => s.text).join("");

// The subset of segments (in order) that the UI would emphasise.
const changed = (segments: Segment[]): string[] =>
  segments.filter((s) => s.changed).map((s) => s.text);

// Find the segment that contains a substring, to assert its `changed` flag.
const segmentWith = (segments: Segment[], needle: string): Segment | undefined =>
  segments.find((s) => s.text.includes(needle));

describe("computeSuggestionDiff", () => {
  it("highlights only the single changed letter in a one-letter edit", () => {
    const { old, new: neu } = computeSuggestionDiff("заведем", "заведём");

    // Lossless.
    expect(join(old)).toBe("заведем");
    expect(join(neu)).toBe("заведём");

    // Old side: exactly the `е` is changed, the rest is common.
    expect(changed(old)).toEqual(["е"]);
    expect(old).toEqual([
      { text: "завед", changed: false },
      { text: "е", changed: true },
      { text: "м", changed: false },
    ]);

    // New side: exactly the `ё` is changed.
    expect(changed(neu)).toEqual(["ё"]);
    expect(neu).toEqual([
      { text: "завед", changed: false },
      { text: "ё", changed: true },
      { text: "м", changed: false },
    ]);
  });

  it("marks the differing words changed but keeps the shared word common", () => {
    const { old, new: neu } = computeSuggestionDiff(
      "привет мир",
      "здравствуй мир",
    );

    // Lossless.
    expect(join(old)).toBe("привет мир");
    expect(join(neu)).toBe("здравствуй мир");

    // The shared trailing word stays common on both sides (no per-letter noise
    // leaking across the differing words into `мир`).
    expect(segmentWith(old, "мир")?.changed).toBe(false);
    expect(segmentWith(neu, "мир")?.changed).toBe(false);

    // The differing words are emphasised somewhere on each side.
    expect(changed(old).length).toBeGreaterThan(0);
    expect(changed(neu).length).toBeGreaterThan(0);
    expect(changed(old).join("")).toContain("п"); // from `привет`
    expect(changed(neu).join("")).toContain("зд"); // from `здравствуй`

    // No changed fragment on either side touches the word `мир`.
    expect(changed(old).some((t) => t.includes("мир"))).toBe(false);
    expect(changed(neu).some((t) => t.includes("мир"))).toBe(false);
  });

  it("marks a whole inserted word changed and leaves the old line common", () => {
    const { old, new: neu } = computeSuggestionDiff("a c", "a b c");

    expect(join(old)).toBe("a c");
    expect(join(neu)).toBe("a b c");

    // Old line has no changed fragment (nothing was removed).
    expect(changed(old)).toEqual([]);
    // The inserted word is the only changed fragment on the new side.
    expect(neu).toContainEqual({ text: "b ", changed: true });
    expect(changed(neu)).toEqual(["b "]);
  });

  it("marks a whole deleted word changed and leaves the new line common", () => {
    const { old, new: neu } = computeSuggestionDiff("a b c", "a c");

    expect(join(old)).toBe("a b c");
    expect(join(neu)).toBe("a c");

    // The deleted word is the only changed fragment on the old side.
    expect(old).toContainEqual({ text: "b ", changed: true });
    expect(changed(old)).toEqual(["b "]);
    // New line has no changed fragment (nothing was added).
    expect(changed(neu)).toEqual([]);
  });

  it("marks everything common for identical strings", () => {
    const { old, new: neu } = computeSuggestionDiff("hello", "hello");

    expect(old).toEqual([{ text: "hello", changed: false }]);
    expect(neu).toEqual([{ text: "hello", changed: false }]);
    expect(changed(old)).toEqual([]);
    expect(changed(neu)).toEqual([]);
  });
});
