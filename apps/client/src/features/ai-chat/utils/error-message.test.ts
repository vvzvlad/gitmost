import { describe, it, expect } from "vitest";
import { describeChatError } from "./error-message";

// Identity translator: assert on the raw English key so the tests do not depend
// on the i18n catalog.
const t = (key: string) => key;

describe("describeChatError", () => {
  it('maps a {"statusCode":403} body to the disabled heading', () => {
    const body = '{"statusCode":403,"message":"Forbidden"}';
    expect(describeChatError(body, t)).toEqual({
      title: "AI chat is disabled",
      detail: "AI chat is disabled for this workspace.",
    });
  });

  it('maps a {"statusCode":503} body to the not-configured heading', () => {
    const body = '{"statusCode":503,"message":"Service Unavailable"}';
    expect(describeChatError(body, t)).toEqual({
      title: "AI provider not configured",
      detail:
        "The AI provider is not configured. Ask an administrator to set it up.",
    });
  });

  it("classifies an A_RUN_BEGIN_FAILED 503 as a temporary run-start failure, NOT provider-not-configured (#486)", () => {
    // The FULL real body the server writes for a beginRun failure: a
    // ServiceUnavailableException(object) whose response is serialized verbatim
    // onto the raw socket, self-describing statusCode 503 + the run-start code.
    const body =
      '{"message":"Could not start the agent run. This is usually temporary — please try again.","code":"A_RUN_BEGIN_FAILED","statusCode":503}';
    expect(describeChatError(body, t)).toEqual({
      title: "Could not start the run",
      detail:
        "The agent run could not be started. This is usually temporary — please try again.",
    });
    // ORDER GUARD: even though the body ALSO carries statusCode 503 (which the
    // generic branch matches), the A_RUN_BEGIN_FAILED branch runs first, so it is
    // never mislabeled "AI provider not configured".
    expect(describeChatError(body, t).title).not.toBe(
      "AI provider not configured",
    );
  });

  // #488 commit 5: the #487 concurrency-gate / supersede 409s. FULL real bodies:
  // a ConflictException(object) whose response is serialized verbatim, carrying a
  // `code` and statusCode 409. Each must classify to a human text, not raw JSON.
  it("classifies A_RUN_ALREADY_ACTIVE (409) as already-answering, not raw JSON", () => {
    const body =
      '{"message":"A run is already active for this chat","code":"A_RUN_ALREADY_ACTIVE","statusCode":409}';
    expect(describeChatError(body, t).title).toBe(
      "The agent is already answering",
    );
    // Never leaks the raw code as the detail.
    expect(describeChatError(body, t).detail).not.toContain("A_RUN_ALREADY_ACTIVE");
  });

  it("classifies SUPERSEDE_TARGET_MISMATCH (409) as run-changed", () => {
    // Real server body shape: the current run id is `activeRunId` (NOT `runId`) —
    // see ai-chat.controller.ts. describeChatError classifies off `code` only.
    const body =
      '{"message":"active run does not match the supersede target","code":"SUPERSEDE_TARGET_MISMATCH","activeRunId":"run-x","statusCode":409}';
    expect(describeChatError(body, t).title).toBe(
      "Couldn't interrupt — the run changed",
    );
  });

  it("classifies SUPERSEDE_TIMEOUT (409) as couldn't-interrupt-in-time", () => {
    const body =
      '{"message":"the run did not settle within the supersede window","code":"SUPERSEDE_TIMEOUT","statusCode":409}';
    expect(describeChatError(body, t).title).toBe("Couldn't interrupt in time");
  });

  it("classifies SUPERSEDE_INVALID (409) as couldn't-interrupt-that-run", () => {
    const body =
      '{"message":"supervise requires chatId","code":"SUPERSEDE_INVALID","statusCode":409}';
    expect(describeChatError(body, t).title).toBe(
      "Couldn't interrupt that run",
    );
  });

  it("ORDER GUARD: A_RUN_ALREADY_ACTIVE wins over any generic status branch", () => {
    // Even though the body could superficially look 4xx-ish, the code branch runs
    // first, so it is never mislabeled by a generic status heading.
    const body =
      '{"message":"conflict","code":"A_RUN_ALREADY_ACTIVE","statusCode":409}';
    const view = describeChatError(body, t);
    expect(view.title).not.toBe("Something went wrong");
    expect(view.title).not.toBe("AI provider not configured");
  });

  it("classifies a token-degeneration abort under the SAME 'Response stopped.' marker the live view shows (#495)", () => {
    // The exact reason the server persists in metadata.error on a degeneration
    // abort (ai-chat.service OUTPUT_DEGENERATION_ERROR). Live, this event shows
    // the neutral "Response stopped." notice; the persisted banner MUST match it
    // so live and refetch never disagree.
    const view = describeChatError(
      "Output degeneration detected (repeated token loop)",
      t,
    );
    expect(view.title).toBe("Response stopped.");
    expect(view.detail).toBe(
      "The answer was stopped automatically because the model fell into a repeated output loop.",
    );
    // Regression guard: it must NOT fall through to the generic heading.
    expect(view.title).not.toBe("Something went wrong");
  });

  it("classifies a dropped connection (ECONNRESET) as a lost-connection error", () => {
    expect(
      describeChatError("Cannot connect to API: read ECONNRESET", t).title,
    ).toBe("Lost connection to the AI provider");
  });

  it('classifies "fetch failed" as a lost-connection error', () => {
    expect(describeChatError("fetch failed", t).title).toBe(
      "Lost connection to the AI provider",
    );
  });

  it("classifies ETIMEDOUT as a timeout", () => {
    expect(describeChatError("ETIMEDOUT", t).title).toBe(
      "The AI provider timed out",
    );
  });

  it('classifies "504: Gateway Timeout" as a timeout', () => {
    expect(describeChatError("504: Gateway Timeout", t).title).toBe(
      "The AI provider timed out",
    );
  });

  it('classifies "429: Too Many Requests" as rate limited', () => {
    expect(describeChatError("429: Too Many Requests", t).title).toBe(
      "Rate limited by the AI provider",
    );
  });

  it('does NOT misclassify a body that merely contains "403" as disabled', () => {
    // Regression intent: a provider message mentioning the number 403 must never
    // be folded into the "AI chat is disabled" gating heading. Here the 429
    // signature wins (checked before any bare-403 logic exists), so it maps to
    // the rate-limit category instead.
    const view = describeChatError("429: rate limited after 403 attempts", t);
    expect(view.title).toBe("Rate limited by the AI provider");
    expect(view.title).not.toBe("AI chat is disabled");
  });

  it("classifies a context-window overflow as too-large", () => {
    expect(
      describeChatError(
        "This model's maximum context length is 128000 tokens",
        t,
      ).title,
    ).toBe("The conversation is too large");
  });

  it('classifies "402: Insufficient credits" as quota exceeded', () => {
    expect(describeChatError("402: Insufficient credits", t).title).toBe(
      "AI provider quota exceeded",
    );
  });

  it('classifies "401: Unauthorized" as an auth failure', () => {
    expect(describeChatError("401: Unauthorized", t).title).toBe(
      "AI provider authentication failed",
    );
  });

  it("falls back to the generic heading + detail for empty input", () => {
    expect(describeChatError("", t)).toEqual({
      title: "Something went wrong",
      detail: "The AI agent could not respond. Please try again.",
    });
  });

  it('falls back to the generic heading + detail for "An error occurred."', () => {
    expect(describeChatError("An error occurred.", t)).toEqual({
      title: "Something went wrong",
      detail: "The AI agent could not respond. Please try again.",
    });
  });

  it('falls back to the generic heading + detail for "Internal server error"', () => {
    expect(describeChatError("Internal server error", t)).toEqual({
      title: "Something went wrong",
      detail: "The AI agent could not respond. Please try again.",
    });
  });

  it("surfaces an unknown-but-informative provider detail verbatim under the generic heading", () => {
    expect(describeChatError("418: I'm a teapot", t)).toEqual({
      title: "Something went wrong",
      detail: "418: I'm a teapot",
    });
  });

  it("does NOT treat a number inside the response body as a leading status code (no auth)", () => {
    // The real status (500) leads the string; the "401" lives in the snippet and
    // must not trigger the auth category. The verbatim provider text is surfaced.
    const body =
      "500: Server error | response body: model gpt-4o-401-preview not found";
    expect(describeChatError(body, t)).toEqual({
      title: "Something went wrong",
      detail: body,
    });
  });

  it("does NOT treat a passing mention of billing as a quota error", () => {
    // "billing" is no longer a quota signature; the verbatim text is surfaced.
    const body = "502: Bad Gateway | response body: see our billing page";
    expect(describeChatError(body, t)).toEqual({
      title: "Something went wrong",
      detail: body,
    });
  });

  it('still rate-limits "429: rate limited after 403 attempts" and never disables', () => {
    const view = describeChatError("429: rate limited after 403 attempts", t);
    expect(view.title).toBe("Rate limited by the AI provider");
    expect(view.title).not.toBe("AI chat is disabled");
  });

  it('does NOT treat "rate limit" inside the response body as a rate-limit error', () => {
    // The textual rate-limit phrase lives only in the response-body snippet, and
    // the leading 500 is not a classified numeric code, so it must not leak into
    // the rate-limit category. (The detail itself falls back to the generic line
    // here because the leading message contains "Internal Server Error", which
    // providerDetail suppresses — the title is what this case pins.)
    const body =
      "500: Internal Server Error | response body: rate limit info: see our docs";
    expect(describeChatError(body, t).title).toBe("Something went wrong");
    expect(describeChatError(body, t).title).not.toBe(
      "Rate limited by the AI provider",
    );
  });

  it('does NOT treat ETIMEDOUT inside the response body as a timeout', () => {
    // The 503 leads the string but is not a classified numeric code, and the
    // ETIMEDOUT signature appears only in the body, so it must not leak into the
    // timeout category; the verbatim text is surfaced under the generic heading.
    const body = "503: x | response body: ETIMEDOUT appears in this log line";
    expect(describeChatError(body, t)).toEqual({
      title: "Something went wrong",
      detail: body,
    });
    expect(describeChatError(body, t).title).not.toBe(
      "The AI provider timed out",
    );
  });
});
