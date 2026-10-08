import { describe, it, expect } from "vitest";
import { classifyPageError } from "./page-render-decision";

const authError = { status: 403 };
const transportError = { code: "ERR_NETWORK", response: undefined };
const serverError = { status: 500, response: { status: 500 } };
const other4xx = { status: 429, response: { status: 429 } };

describe("classifyPageError (#641 page taxonomy)", () => {
  it("auth → not-found even with a cache (acceptance 3)", () => {
    expect(
      classifyPageError({
        error: authError,
        hasChromeMeta: true,
        hasLocalBody: true,
      }),
    ).toBe("not-found");
    expect(
      classifyPageError({
        error: { status: 404 },
        hasChromeMeta: true,
        hasLocalBody: true,
      }),
    ).toBe("not-found");
  });

  it("transport + chrome + local body → offline-local (acceptance 1)", () => {
    expect(
      classifyPageError({
        error: transportError,
        hasChromeMeta: true,
        hasLocalBody: true,
      }),
    ).toBe("offline-local");
  });

  it("transport + chrome + NO local body → offline-empty (acceptance 2)", () => {
    expect(
      classifyPageError({
        error: transportError,
        hasChromeMeta: true,
        hasLocalBody: false,
      }),
    ).toBe("offline-empty");
  });

  it("transport + NO chrome → error-screen (nothing to fall back on)", () => {
    expect(
      classifyPageError({
        error: transportError,
        hasChromeMeta: false,
        hasLocalBody: false,
      }),
    ).toBe("error-screen");
  });

  it("5xx → error-screen even WITH a cache (acceptance 4: not 'offline')", () => {
    expect(
      classifyPageError({
        error: serverError,
        hasChromeMeta: true,
        hasLocalBody: true,
      }),
    ).toBe("error-screen");
  });

  it("non-axios throw → error-screen even WITH a cache (not masked as offline)", () => {
    // A bug / TypeError is not a network failure: it must NOT be swallowed into
    // the offline render (which would hide it with zero operator signal).
    expect(
      classifyPageError({
        error: new Error("bug in a transform"),
        hasChromeMeta: true,
        hasLocalBody: true,
      }),
    ).toBe("error-screen");
  });

  it("non-auth 4xx (429) → error-screen", () => {
    expect(
      classifyPageError({
        error: other4xx,
        hasChromeMeta: true,
        hasLocalBody: true,
      }),
    ).toBe("error-screen");
  });
});
