import { describe, it, expect } from "vitest";
import { isChunkLoadError } from "./chunk-load-error-boundary";

// The detector decides whether a caught render error is a stale-deploy chunk-404
// (→ auto-reload to fetch the new manifest) vs a genuine app error (→ generic
// recovery UI, no reload). A false negative on a real chunk failure re-blanks the
// app; a false positive would auto-reload on an ordinary error. Pin both sides.
describe("isChunkLoadError", () => {
  it("detects the ChunkLoadError name", () => {
    expect(isChunkLoadError({ name: "ChunkLoadError", message: "x" })).toBe(true);
  });

  it.each([
    "Failed to fetch dynamically imported module: https://x/assets/index-abc.js",
    "error loading dynamically imported module",
    "Importing a module script failed.",
  ])("detects the dynamic-import failure message %#", (message) => {
    expect(isChunkLoadError({ name: "TypeError", message })).toBe(true);
  });

  it("is case-insensitive on the message", () => {
    expect(
      isChunkLoadError({ message: "FAILED TO FETCH DYNAMICALLY IMPORTED MODULE" }),
    ).toBe(true);
  });

  it.each([
    null,
    undefined,
    {},
    { name: "TypeError", message: "Cannot read properties of undefined" },
    { message: "Network request failed" },
    new Error("some ordinary render error"),
  ])("returns false for a non-chunk error %#", (err) => {
    expect(isChunkLoadError(err)).toBe(false);
  });
});
