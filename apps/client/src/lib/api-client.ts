import axios, { AxiosInstance } from "axios";
import APP_ROUTE from "@/lib/app-route.ts";
import { isCloud, isLocalFirstEnabled } from "@/lib/config.ts";
import { clearPersistedTreeCaches } from "@/features/page/tree/atoms/tree-data-atom";
import { clearPersistedCurrentUser } from "@/features/user/atoms/current-user-atom";
import { purgePageYdocDatabases } from "@/features/editor/page-ydoc-eviction";

const api: AxiosInstance = axios.create({
  baseURL: "/api",
  withCredentials: true,
});

api.interceptors.response.use(
  (response) => {
    // we need the response headers for these endpoints
    const exemptEndpoints = ["/api/pages/export", "/api/spaces/export"];
    if (response.request.responseURL) {
      const path = new URL(response.request.responseURL)?.pathname;
      if (path && exemptEndpoints.includes(path)) {
        return response;
      }
    }

    return response.data;
  },
  (error) => {
    if (error.response) {
      switch (error.response.status) {
        case 401: {
          const url = new URL(error.request.responseURL)?.pathname;

          // #642, part 3 — a 401 means the session is dead. Purge the persisted
          // current-user BEFORE any early `return` below (the collab-token and
          // /share short-circuits here, AND redirectToLogin's own exempt-path
          // return, incl. /login). Otherwise a dead-session reload paints the
          // shell from the seed (#642 part 1) then redirects to /login, where
          // redirectToLogin early-returns WITHOUT clearing → the key survives →
          // /login seeds again → app → /me → 401: an infinite loop. Gated on the
          // flag so a flag-OFF deploy is byte-for-behavior unchanged (there is no
          // seed to clear, and today's 401 path never touched this key).
          if (isLocalFirstEnabled()) {
            clearPersistedCurrentUser();
          }

          if (url === "/api/auth/collab-token") return;
          if (window.location.pathname.startsWith("/share/")) return;

          // Handle unauthorized error
          redirectToLogin();
          break;
        }
        case 403:
          // Handle forbidden error
          break;
        case 404:
          // Handle not found error
          if (
            error.response.data.message
              .toLowerCase()
              .includes("workspace not found")
          ) {
            console.log("workspace not found");
            if (
              !isCloud() &&
              window.location.pathname != APP_ROUTE.AUTH.SETUP
            ) {
              window.location.href = APP_ROUTE.AUTH.SETUP;
            }
          }
          break;
        case 500:
          // Handle internal server error
          break;
        default:
          break;
      }
    }
    return Promise.reject(error);
  },
);

async function redirectToLogin() {
  const exemptPaths = [
    APP_ROUTE.AUTH.LOGIN,
    APP_ROUTE.AUTH.SIGNUP,
    APP_ROUTE.AUTH.FORGOT_PASSWORD,
    APP_ROUTE.AUTH.PASSWORD_RESET,
    "/invites",
  ];
  if (!exemptPaths.some((path) => window.location.pathname.startsWith(path))) {
    // Forced logout (401 / expired session) must purge the persisted sidebar
    // tree caches too: they contain page titles, and on a shared machine most
    // sessions end via cookie expiry — not the logout button — so this is the
    // only cleanup that runs on that path. It also disables further cache
    // persistence until the full page load below.
    clearPersistedTreeCaches();
    // #640, invariant 8 — ALSO purge the local page-body ydoc databases on a
    // forced 401 logout, AWAITED before the navigation below so `deleteDatabase`
    // actually finishes (a synchronous redirect would cut it short).
    //
    // FORWARD-COMPAT (reverses #626 review option-B, deliberately): this is safe
    // ONLY while the #564 write-guard forbids local edits, so a purged ydoc can
    // hold no unsent work. The moment offline-editing lands, this purge MUST
    // become "quarantine, not delete, if the ydoc has unsent updates" (see the
    // reconciledAt reservation in page-ydoc-reconciled), otherwise a returning
    // network → 401 → redirectToLogin() would delete the user's unsynced edits
    // with the very handler meant to protect a shared machine.
    await purgePageYdocDatabases();
    const redirectTo = window.location.pathname;
    if (redirectTo === APP_ROUTE.HOME) {
      window.location.href = APP_ROUTE.AUTH.LOGIN;
    } else {
      const params = new URLSearchParams({ redirect: redirectTo });
      window.location.href = `${APP_ROUTE.AUTH.LOGIN}?${params.toString()}`;
    }
  }
}

export default api;
