import { describe, it, expect } from "vitest";
import { resolveUserGate } from "./user-provider-gate";

const transportError = { code: "ERR_NETWORK", response: undefined };
const serverError = { status: 500, response: { status: 500 } };
const authError = { status: 401, response: { status: 401 } };
const notFound = { status: 404, response: { status: 404 } };

describe("resolveUserGate (#641 /me gate, part 3)", () => {
  it("loading → loading regardless of anything else", () => {
    expect(
      resolveUserGate({
        localFirst: true,
        isLoading: true,
        error: transportError,
        hasData: true,
      }),
    ).toBe("loading");
  });

  it("404 → dedicated Error404 screen (unchanged)", () => {
    expect(
      resolveUserGate({
        localFirst: true,
        isLoading: false,
        error: notFound,
        hasData: true,
      }),
    ).toBe("error-404");
  });

  it("no error → children", () => {
    expect(
      resolveUserGate({
        localFirst: true,
        isLoading: false,
        error: undefined,
        hasData: true,
      }),
    ).toBe("children");
  });

  // Acceptance 6: transport error WITH data → app stays mounted (degraded).
  it("flag ON: transport error + data → degraded (app stays mounted)", () => {
    expect(
      resolveUserGate({
        localFirst: true,
        isLoading: false,
        error: transportError,
        hasData: true,
      }),
    ).toBe("degraded");
  });

  it("flag ON: 5xx + data → degraded (kept mounted, but 5xx is reported separately)", () => {
    expect(
      resolveUserGate({
        localFirst: true,
        isLoading: false,
        error: serverError,
        hasData: true,
      }),
    ).toBe("degraded");
  });

  it("401 + data → blocked (the interceptor redirects to login)", () => {
    expect(
      resolveUserGate({
        localFirst: true,
        isLoading: false,
        error: authError,
        hasData: true,
      }),
    ).toBe("blocked");
  });

  it("error + NO data → blocked (nothing to render)", () => {
    expect(
      resolveUserGate({
        localFirst: true,
        isLoading: false,
        error: transportError,
        hasData: false,
      }),
    ).toBe("blocked");
  });

  // Acceptance 8: flag OFF is byte-for-behavior identical — every error blocks.
  it("flag OFF: transport error + data → blocked (today's behavior)", () => {
    expect(
      resolveUserGate({
        localFirst: false,
        isLoading: false,
        error: transportError,
        hasData: true,
      }),
    ).toBe("blocked");
  });

  it("flag OFF: 404 still → Error404", () => {
    expect(
      resolveUserGate({
        localFirst: false,
        isLoading: false,
        error: notFound,
        hasData: true,
      }),
    ).toBe("error-404");
  });
});
