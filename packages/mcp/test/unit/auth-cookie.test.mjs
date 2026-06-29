// Cookie parsing for the login flow.
//
// `performLogin` in auth-utils.ts does a real network POST and then extracts the
// auth token from the response's Set-Cookie header. The cookie-parsing logic was
// extracted into the pure, exported helper `extractAuthTokenFromSetCookie` so it
// can be tested without network I/O; `performLogin` now delegates to it, so these
// tests cover the exact parsing path the login uses.
import { test } from "node:test";
import assert from "node:assert/strict";

import { extractAuthTokenFromSetCookie } from "../../build/lib/auth-utils.js";

// ---------------------------------------------------------------------------
// Happy path: a single authToken cookie with attributes.
// ---------------------------------------------------------------------------
test("extracts the authToken value, ignoring trailing attributes", () => {
  const cookies = [
    "authToken=abc123; Path=/; HttpOnly; Secure; SameSite=Lax",
  ];
  assert.equal(extractAuthTokenFromSetCookie(cookies), "abc123");
});

// ---------------------------------------------------------------------------
// A base64/JWT value containing "=" padding must NOT be truncated: only the
// FIRST "=" separates name from value.
// ---------------------------------------------------------------------------
test("preserves an '=' inside the value (base64 padding is not truncated)", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0=";
  const cookies = [`authToken=${jwt}; Path=/`];
  assert.equal(extractAuthTokenFromSetCookie(cookies), jwt);
});

// ---------------------------------------------------------------------------
// Exact-name match: a different cookie whose name merely STARTS WITH "authToken"
// (e.g. authTokenRefresh) must not be picked up; the real authToken wins.
// ---------------------------------------------------------------------------
test("matches the cookie name exactly, not by prefix (authTokenRefresh ignored)", () => {
  const cookies = [
    "authTokenRefresh=refreshvalue; Path=/; HttpOnly",
    "authToken=realtoken; Path=/; HttpOnly",
  ];
  assert.equal(extractAuthTokenFromSetCookie(cookies), "realtoken");
});

// ---------------------------------------------------------------------------
// Picks the authToken out of several unrelated cookies regardless of order.
// ---------------------------------------------------------------------------
test("selects authToken among multiple unrelated cookies", () => {
  const cookies = [
    "session=xyz; Path=/",
    "authToken=tok-7; Path=/; HttpOnly",
    "theme=dark",
  ];
  assert.equal(extractAuthTokenFromSetCookie(cookies), "tok-7");
});

// ---------------------------------------------------------------------------
// An empty value is valid and returns "".
// ---------------------------------------------------------------------------
test("returns an empty string when authToken has an empty value", () => {
  assert.equal(extractAuthTokenFromSetCookie(["authToken=; Path=/"]), "");
});

// ---------------------------------------------------------------------------
// Missing Set-Cookie header -> documented error.
// ---------------------------------------------------------------------------
test("throws when there is no Set-Cookie header", () => {
  assert.throws(
    () => extractAuthTokenFromSetCookie(undefined),
    /No Set-Cookie header/,
  );
});

// ---------------------------------------------------------------------------
// Set-Cookie present but no authToken cookie -> documented error.
// ---------------------------------------------------------------------------
test("throws when no authToken cookie is present", () => {
  assert.throws(
    () => extractAuthTokenFromSetCookie(["session=xyz; Path=/", "theme=dark"]),
    /No authToken cookie/,
  );
});

// ---------------------------------------------------------------------------
// An empty cookie array also yields the "no authToken" error (header exists but
// is empty), distinct from the "no Set-Cookie header" case above.
// ---------------------------------------------------------------------------
test("throws 'no authToken' (not 'no header') for an empty cookie array", () => {
  assert.throws(
    () => extractAuthTokenFromSetCookie([]),
    /No authToken cookie/,
  );
});
