import { describe, it, expect, beforeEach, vi } from "vitest";
import { AxiosError, AxiosHeaders } from "axios";
import {
  httpStatusOf,
  isAuthError,
  isTransportError,
  isServerError,
  reportOfflineCriticalServerError,
} from "./http-error";
import {
  getSafetyMetric,
  resetSafetyMetricsForTests,
} from "@/lib/telemetry/safety-metrics";

// Build a real axios-shaped error: a RESPONSE with a status (server answered).
function axiosResponseError(status: number): AxiosError {
  const err = new AxiosError(
    `Request failed with status code ${status}`,
    status >= 500 ? "ERR_BAD_RESPONSE" : "ERR_BAD_REQUEST",
  );
  err.response = {
    status,
    statusText: "",
    data: { message: "boom" },
    headers: {},
    config: { headers: new AxiosHeaders() },
  } as AxiosError["response"];
  // axios >= 1.5 mirrors response.status onto the error itself.
  (err as unknown as { status?: number }).status = status;
  return err;
}

// A real axios NETWORK error: no response, a transport `code`.
function axiosNetworkError(code: string): AxiosError {
  const err = new AxiosError("Network Error", code);
  err.response = undefined;
  return err;
}

describe("httpStatusOf", () => {
  it("reads response.status from a real axios error", () => {
    expect(httpStatusOf(axiosResponseError(403))).toBe(403);
    expect(httpStatusOf(axiosResponseError(500))).toBe(500);
  });

  it("reads a flattened .status (synthetic / re-thrown shape)", () => {
    expect(httpStatusOf({ status: 404 })).toBe(404);
  });

  it("is undefined for a transport error and non-errors", () => {
    expect(httpStatusOf(axiosNetworkError("ERR_NETWORK"))).toBeUndefined();
    expect(httpStatusOf(undefined)).toBeUndefined();
    expect(httpStatusOf(null)).toBeUndefined();
    expect(httpStatusOf(new Error("plain"))).toBeUndefined();
  });
});

describe("isAuthError — the server gave an access verdict", () => {
  it("is true for 401/403/404", () => {
    for (const s of [401, 403, 404]) {
      expect(isAuthError(axiosResponseError(s))).toBe(true);
      expect(isAuthError({ status: s })).toBe(true);
    }
  });

  it("is false for 5xx, other 4xx, transport, and non-errors", () => {
    expect(isAuthError(axiosResponseError(500))).toBe(false);
    expect(isAuthError(axiosResponseError(429))).toBe(false);
    expect(isAuthError(axiosNetworkError("ERR_NETWORK"))).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
  });
});

describe("isTransportError — unreachable network", () => {
  it("is true for each axios transport code with no response", () => {
    for (const code of ["ERR_NETWORK", "ECONNABORTED", "ETIMEDOUT"]) {
      expect(isTransportError(axiosNetworkError(code))).toBe(true);
    }
  });

  it("is true for an axios-shaped error with no code but no response", () => {
    // e.g. an aborted/cancelled axios request without a standard transport code.
    const err = new AxiosError("Something");
    err.response = undefined;
    expect(err.isAxiosError).toBe(true);
    expect(isTransportError(err)).toBe(true);
  });

  it("is FALSE for a non-axios throw (must NOT be masked as offline)", () => {
    // A bug / TypeError in a response transform has no HTTP response either, but
    // it is NOT a network failure: swallowing it into the offline render would
    // hide a real error with zero operator signal (the part-4 failure mode via a
    // non-5xx door). It must fall through to the error screen.
    expect(isTransportError(new Error("boom"))).toBe(false);
    expect(isTransportError(new TypeError("cannot read x of undefined"))).toBe(
      false,
    );
    expect(isTransportError({ message: "no response here" })).toBe(false);
  });

  it("is FALSE for any response with a status (5xx must not be swallowed)", () => {
    expect(isTransportError(axiosResponseError(500))).toBe(false);
    expect(isTransportError(axiosResponseError(503))).toBe(false);
    expect(isTransportError(axiosResponseError(403))).toBe(false);
  });

  it("is false for non-errors", () => {
    expect(isTransportError(undefined)).toBe(false);
    expect(isTransportError(null)).toBe(false);
  });
});

describe("isServerError — the server answered 5xx", () => {
  it("is true for 500..599 only", () => {
    expect(isServerError(axiosResponseError(500))).toBe(true);
    expect(isServerError(axiosResponseError(503))).toBe(true);
    expect(isServerError(axiosResponseError(499))).toBe(false);
    expect(isServerError(axiosResponseError(404))).toBe(false);
    expect(isServerError(axiosNetworkError("ERR_NETWORK"))).toBe(false);
  });
});

describe("success-with-undefined is classified as NEITHER error nor data", () => {
  // The 401 interceptor `return;`s on exempt paths, resolving with `undefined`
  // data and NO error. There is no error object to classify, so every predicate
  // is false — the taxonomy never mistakes it for an error (nor for data).
  it("every predicate is false for undefined/null", () => {
    for (const v of [undefined, null]) {
      expect(isAuthError(v)).toBe(false);
      expect(isTransportError(v)).toBe(false);
      expect(isServerError(v)).toBe(false);
      expect(httpStatusOf(v)).toBeUndefined();
    }
  });
});

describe("reportOfflineCriticalServerError (part 4)", () => {
  beforeEach(() => {
    resetSafetyMetricsForTests();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("counts a 5xx to the always-on safety metric and returns true", () => {
    expect(getSafetyMetric("http_server_error")).toBe(0);
    const reported = reportOfflineCriticalServerError(
      axiosResponseError(500),
      "/pages/info",
    );
    expect(reported).toBe(true);
    expect(getSafetyMetric("http_server_error")).toBe(1);
  });

  it("does NOT report a transport error (that is the normal offline mode)", () => {
    const reported = reportOfflineCriticalServerError(
      axiosNetworkError("ERR_NETWORK"),
      "/pages/info",
    );
    expect(reported).toBe(false);
    expect(getSafetyMetric("http_server_error")).toBe(0);
  });

  it("does NOT report an auth error", () => {
    expect(
      reportOfflineCriticalServerError(axiosResponseError(403), "/users/me"),
    ).toBe(false);
    expect(getSafetyMetric("http_server_error")).toBe(0);
  });
});
