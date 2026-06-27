import { describe, it, expect, beforeEach } from "vitest";
import {
  sortFrequentlyUsedEmoji,
  getFrequentlyUsedEmoji,
  LOCAL_STORAGE_FREQUENT_KEY,
} from "./utils";

describe("sortFrequentlyUsedEmoji", () => {
  it("orders known emoji by descending usage count", async () => {
    const result = await sortFrequentlyUsedEmoji({
      rocket: 1,
      joy: 9,
      heart_eyes: 5,
    });
    expect(result.map((e) => e.id)).toEqual(["joy", "heart_eyes", "rocket"]);
  });

  it("caps the result at the top 5 most frequent", async () => {
    const result = await sortFrequentlyUsedEmoji({
      rocket: 1,
      joy: 2,
      heart_eyes: 3,
      grinning: 4,
      laughing: 5,
      scream: 6,
      sweat_smile: 7,
    });
    expect(result).toHaveLength(5);
    // Highest counts retained, lowest (rocket:1, joy:2) dropped.
    expect(result.map((e) => e.id)).toEqual([
      "sweat_smile",
      "scream",
      "laughing",
      "grinning",
      "heart_eyes",
    ]);
  });

  it("drops ids that have no matching emoji in the index", async () => {
    const result = await sortFrequentlyUsedEmoji({
      __definitely_not_a_real_emoji_id__: 100,
      rocket: 1,
    });
    expect(result.map((e) => e.id)).toEqual(["rocket"]);
  });

  it("maps each entry to its native glyph and a command", async () => {
    const [entry] = await sortFrequentlyUsedEmoji({ rocket: 5 });
    expect(entry.id).toBe("rocket");
    expect(typeof entry.emoji).toBe("string");
    expect(entry.emoji.length).toBeGreaterThan(0);
    expect(typeof entry.command).toBe("function");
  });

  it("returns an empty list for empty input", async () => {
    expect(await sortFrequentlyUsedEmoji({})).toEqual([]);
  });
});

describe("getFrequentlyUsedEmoji", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("falls back to the default map when nothing is stored", () => {
    const result = getFrequentlyUsedEmoji();
    expect(result["+1"]).toBe(10);
    expect(result["rocket"]).toBe(1);
  });

  it("parses a valid stored JSON map", () => {
    localStorage.setItem(
      LOCAL_STORAGE_FREQUENT_KEY,
      JSON.stringify({ rocket: 42 }),
    );
    expect(getFrequentlyUsedEmoji()).toEqual({ rocket: 42 });
  });

  // BUG (issue #204, Phase 2): getFrequentlyUsedEmoji() does an unprotected
  // JSON.parse() of the raw localStorage value. A corrupt value (e.g. truncated
  // by a crash, or written by another tab/extension) makes the emoji menu throw
  // on open instead of degrading gracefully to the default set.
  //
  // Documented with it.fails: this asserts the DESIRED behavior (return a sane
  // default, never throw). It currently FAILS because the function throws —
  // flip to `it()` once utils.ts guards the JSON.parse.
  it.fails(
    "should degrade to a sane default on corrupt localStorage (currently throws)",
    () => {
      localStorage.setItem(LOCAL_STORAGE_FREQUENT_KEY, "{not valid json");
      let result: Record<string, number> | undefined;
      expect(() => {
        result = getFrequentlyUsedEmoji();
      }).not.toThrow();
      // Should hand back a usable, non-empty map rather than nothing.
      expect(result).toBeTruthy();
      expect(Object.keys(result ?? {}).length).toBeGreaterThan(0);
    },
  );
});
