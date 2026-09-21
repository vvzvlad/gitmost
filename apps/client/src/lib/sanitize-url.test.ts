import { describe, it, expect } from "vitest";
import { sanitizeUrl } from "./sanitize-url";

// `sanitizeUrl` is a byte-identical client-local copy of editor-ext's wrapper
// around @braintree/sanitize-url: it maps the sanitizer's "about:blank" XSS
// sentinel to "". These assertions mirror editor-ext's own security-contract
// test so the extracted copy keeps the same guarantees.
describe("sanitizeUrl", () => {
  it("blocks dangerous schemes (returns empty string)", () => {
    expect(sanitizeUrl("javascript:alert(1)")).toBe("");
    expect(sanitizeUrl("data:text/html,<script>alert(1)</script>")).toBe("");
    expect(sanitizeUrl("vbscript:msgbox(1)")).toBe("");
    // Case / whitespace obfuscation must not slip past the sanitizer.
    expect(sanitizeUrl("  JaVaScRiPt:alert(1)")).toBe("");
  });

  it("returns empty string for empty / undefined input", () => {
    expect(sanitizeUrl(undefined)).toBe("");
    expect(sanitizeUrl("")).toBe("");
  });

  it("allows safe https, relative file and mailto URLs", () => {
    expect(sanitizeUrl("https://example.com/page")).toMatch(
      /^https:\/\/example\.com\/page/,
    );
    expect(sanitizeUrl("/api/files/abc-123")).toBe("/api/files/abc-123");
    expect(sanitizeUrl("mailto:user@example.com")).toBe(
      "mailto:user@example.com",
    );
  });
});
