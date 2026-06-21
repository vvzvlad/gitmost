import { afterEach, describe, expect, it } from "vitest";
import {
  encodeHtmlEmbedSource,
  decodeHtmlEmbedSource,
  parseHtmlEmbedHeight,
  renderHtmlEmbedHeight,
} from "./html-embed";

// Unit coverage for the base64 codec used by the htmlEmbed node's
// data-source attribute (html-embed.ts). The codec has two branches:
//   - the BROWSER branch: btoa(encodeURIComponent(s)) / decodeURIComponent(atob(s));
//   - the NODE fallback: Buffer.from(..).toString("base64") / Buffer.from(s,"base64").
// Server-side schema parsing (htmlToJson with no global btoa/atob) hits the
// fallback, so both branches must round-trip identically; otherwise an embed
// encoded in the browser would decode wrong on the server (or vice versa).
//
// We force the fallback by temporarily DELETING globalThis.btoa/atob (jsdom
// provides them in this env), restoring them after each test so the suite stays
// hermetic.

const realBtoa = globalThis.btoa;
const realAtob = globalThis.atob;

function deleteBase64Globals(): void {
  // @ts-expect-error — intentionally removing the globals to exercise the
  // `typeof btoa !== "function"` Node fallback branch in the codec.
  delete globalThis.btoa;
  // @ts-expect-error — see above.
  delete globalThis.atob;
}

afterEach(() => {
  // Always restore so one test's stubbing never leaks into another.
  globalThis.btoa = realBtoa;
  globalThis.atob = realAtob;
});

describe("html-embed codec — browser btoa/atob branch", () => {
  it("round-trips ASCII source", () => {
    const src = "<script>alert(1)</script>";
    const enc = encodeHtmlEmbedSource(src);
    expect(enc).not.toBe("");
    // base64 of the encodeURIComponent form never contains a raw '<'.
    expect(enc).not.toContain("<");
    expect(decodeHtmlEmbedSource(enc)).toBe(src);
  });

  it("round-trips UTF-8 / non-Latin1 source (the reason for encodeURIComponent)", () => {
    const src = '<p>héllo → 世界 𝕏</p>';
    const enc = encodeHtmlEmbedSource(src);
    expect(decodeHtmlEmbedSource(enc)).toBe(src);
  });
});

describe("html-embed codec — Node Buffer fallback branch", () => {
  it("encode uses the Buffer fallback when btoa is unavailable and still round-trips (UTF-8)", () => {
    const src = '<div>héllo → 世界 𝕏</div>';

    deleteBase64Globals();
    // With the globals gone, encode must take the Buffer path...
    const encFallback = encodeHtmlEmbedSource(src);
    expect(encFallback).not.toBe("");
    // ...and decode (also via Buffer) must recover the exact source.
    expect(decodeHtmlEmbedSource(encFallback)).toBe(src);
  });

  it("the Buffer fallback produces the SAME bytes the browser branch does (cross-env parity)", () => {
    const src = '<span>café — 日本語</span>';

    // Browser branch (globals intact).
    const encBrowser = encodeHtmlEmbedSource(src);

    // Fallback branch.
    deleteBase64Globals();
    const encFallback = encodeHtmlEmbedSource(src);

    // Identical base64 => an embed encoded in either environment decodes
    // identically in the other (server <-> client losslessness).
    expect(encFallback).toBe(encBrowser);

    // And the fallback can decode what the browser produced.
    expect(decodeHtmlEmbedSource(encBrowser)).toBe(src);
  });

  it("empty string -> '' on both encode and decode in the fallback (early return, branch never reached)", () => {
    deleteBase64Globals();
    expect(encodeHtmlEmbedSource("")).toBe("");
    expect(decodeHtmlEmbedSource("")).toBe("");
  });

  it("decode of malformed base64 -> '' via the catch branch (fallback)", () => {
    // In the Buffer fallback, Buffer.from(..,'base64') is lenient and never
    // throws, so to hit the catch we need a payload whose DECODED bytes are an
    // invalid percent-escape, which makes decodeURIComponent throw. base64 of a
    // lone '%' decodes back to '%', and decodeURIComponent('%') is a URIError.
    const badBase64 = Buffer.from("%", "utf-8").toString("base64"); // "JQ=="

    deleteBase64Globals();
    // Sanity: the raw decode really does throw, so we're exercising the catch.
    expect(() =>
      decodeURIComponent(Buffer.from(badBase64, "base64").toString("utf-8")),
    ).toThrow();
    // The codec swallows it and returns "" rather than propagating.
    expect(decodeHtmlEmbedSource(badBase64)).toBe("");
  });
});

describe("html-embed codec — encode failure fallback", () => {
  it("returns '' (not raw source) when encoding throws", () => {
    // Force the catch branch: a btoa that throws (e.g. simulating the
    // Latin1-boundary error). The codec must NOT return the raw source —
    // raw markup in data-source would fail to decode and undermine inert
    // storage — it drops to "" symmetrically with the decode side.
    const src = "<script>alert(1)</script>";
    // @ts-expect-error — stub btoa with a throwing impl for this test.
    globalThis.btoa = () => {
      throw new Error("boom");
    };
    expect(encodeHtmlEmbedSource(src)).toBe("");
  });
});

describe("html-embed height — parseHtmlEmbedHeight (data-height -> px | null)", () => {
  it('parses a numeric string ("300" -> 300)', () => {
    expect(parseHtmlEmbedHeight("300")).toBe(300);
  });

  it("parses an absent value (null -> null = auto-resize)", () => {
    expect(parseHtmlEmbedHeight(null)).toBeNull();
    expect(parseHtmlEmbedHeight("")).toBeNull();
  });

  it('rejects a non-numeric value ("abc" -> null) — pins the NaN guard (BUG-2)', () => {
    // Without Number.isFinite this would be NaN (typeof "number"), disabling
    // auto-resize and yielding an unclamped iframe height downstream.
    expect(parseHtmlEmbedHeight("abc")).toBeNull();
  });

  it('parses a trailing-unit value ("120px" -> 120) via parseInt', () => {
    expect(parseHtmlEmbedHeight("120px")).toBe(120);
  });
});

describe("html-embed height — renderHtmlEmbedHeight (px -> data-height | {})", () => {
  it("renders a fixed height (120 -> { data-height: '120' })", () => {
    expect(renderHtmlEmbedHeight(120)).toEqual({ "data-height": "120" });
  });

  it("renders auto-resize as no attribute (null -> {})", () => {
    expect(renderHtmlEmbedHeight(null)).toEqual({});
  });

  it("renders 0 as no attribute (0 is auto -> {})", () => {
    expect(renderHtmlEmbedHeight(0)).toEqual({});
  });

  it("renders undefined as no attribute (absent -> {})", () => {
    expect(renderHtmlEmbedHeight(undefined)).toEqual({});
  });
});

describe("html-embed codec — decode of malformed input (browser branch)", () => {
  it("returns '' for input atob rejects (catch branch)", () => {
    // atob throws on characters outside the base64 alphabet; the codec catches
    // it and returns "" instead of throwing.
    expect(decodeHtmlEmbedSource("@@not-base64@@")).toBe("");
  });

  it("empty string short-circuits to '' (never calls atob)", () => {
    expect(decodeHtmlEmbedSource("")).toBe("");
  });
});
