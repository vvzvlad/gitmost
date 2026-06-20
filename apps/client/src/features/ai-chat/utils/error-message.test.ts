import { describe, it, expect } from "vitest";
import { describeChatError } from "./error-message";

// Identity translator: assert on the raw English key so the tests do not depend
// on the i18n catalog.
const t = (key: string) => key;

describe("describeChatError", () => {
  it('surfaces a provider "402: ..." stream error verbatim', () => {
    expect(describeChatError("402: Insufficient credits", t)).toBe(
      "402: Insufficient credits",
    );
  });

  it('does NOT misclassify a body that merely contains "403" (no "statusCode":403)', () => {
    // A provider message mentioning the number 403 must be surfaced verbatim,
    // never folded into the "AI chat is disabled" gating message.
    const msg = "429: rate limited after 403 attempts";
    expect(describeChatError(msg, t)).toBe(msg);
  });

  it('maps a {"statusCode":403} body to the disabled message', () => {
    const body = '{"statusCode":403,"message":"Forbidden"}';
    expect(describeChatError(body, t)).toBe(
      "AI chat is disabled for this workspace.",
    );
  });

  it('maps a {"statusCode":503} body to the not-configured message', () => {
    const body = '{"statusCode":503,"message":"Service Unavailable"}';
    expect(describeChatError(body, t)).toBe(
      "The AI provider is not configured. Ask an administrator to set it up.",
    );
  });

  it('falls back to the generic message for "An error occurred."', () => {
    expect(describeChatError("An error occurred.", t)).toBe(
      "The AI agent could not respond. Please try again.",
    );
  });

  it('falls back to the generic message for "Internal server error"', () => {
    expect(describeChatError("Internal server error", t)).toBe(
      "The AI agent could not respond. Please try again.",
    );
  });

  it("falls back to the generic message for empty input", () => {
    expect(describeChatError("", t)).toBe(
      "The AI agent could not respond. Please try again.",
    );
  });
});
