import { describe, it, expect } from "vitest";
import { sanitizeUrl, isInternalFileUrl } from "./utils";

// Security contract tests for the editor URL helpers (utils.ts).
// `sanitizeUrl` wraps @braintree/sanitize-url and maps its "about:blank" XSS
// sentinel to "" so callers can treat empty as "blocked". `isInternalFileUrl`
// decides whether a URL points at our own file-serving routes (used to skip
// external-link affordances). A regression here is a stored-XSS or SSRF vector.

describe("sanitizeUrl", () => {
  it("blocks dangerous schemes (returns empty string)", () => {
    expect(sanitizeUrl("javascript:alert(1)")).toBe("");
    expect(sanitizeUrl("data:text/html,<script>alert(1)</script>")).toBe("");
    expect(sanitizeUrl("vbscript:msgbox(1)")).toBe("");
    // case-insensitive + leading whitespace must not bypass the filter
    expect(sanitizeUrl("  JaVaScRiPt:alert(1)")).toBe("");
  });

  it("returns empty string for empty / undefined input", () => {
    expect(sanitizeUrl(undefined)).toBe("");
    expect(sanitizeUrl("")).toBe("");
  });

  it("allows safe https, relative file and mailto URLs", () => {
    // braintree normalises https URLs (may add a trailing slash); just assert
    // the scheme survives and it is not blanked out.
    expect(sanitizeUrl("https://example.com/page")).toMatch(/^https:\/\/example\.com\/page/);
    expect(sanitizeUrl("/api/files/abc-123")).toBe("/api/files/abc-123");
    expect(sanitizeUrl("mailto:user@example.com")).toBe("mailto:user@example.com");
  });
});

describe("isInternalFileUrl", () => {
  it("is true only for /api/files/ and /files/ prefixes", () => {
    expect(isInternalFileUrl("/api/files/abc")).toBe(true);
    expect(isInternalFileUrl("/files/abc")).toBe(true);
  });

  it("trims whitespace before matching the prefix", () => {
    expect(isInternalFileUrl("   /api/files/abc")).toBe(true);
    expect(isInternalFileUrl("\t/files/abc")).toBe(true);
  });

  it("is false for external URLs and other paths", () => {
    expect(isInternalFileUrl("https://example.com/api/files/abc")).toBe(false);
    expect(isInternalFileUrl("/other/files/abc")).toBe(false);
    expect(isInternalFileUrl("/apifiles/abc")).toBe(false);
  });

  it("is false for empty / undefined input", () => {
    expect(isInternalFileUrl(undefined)).toBe(false);
    expect(isInternalFileUrl("")).toBe(false);
  });
});
