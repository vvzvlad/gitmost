import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { Button } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import i18n from "@/i18n.ts";
import {
  hasAutoReloaded,
  markAutoReloaded,
  recordReloadBreadcrumb,
  takeReloadBreadcrumb,
} from "@/lib/reload-guard";
import { decideVersionAction } from "@/features/user/version-coherence";

// Dirty shell around the pure `decideVersionAction`: it reads globals
// (APP_VERSION), touches sessionStorage via the shared reload-guard, drives the
// Mantine notification, and arms the router-navigation reload hook. Kept
// separate from the pure module so the decision stays unit-testable without a
// DOM.

// One fixed id so repeated app-version signals (e.g. every reconnect) update a
// single banner instead of stacking a new one each time.
const BANNER_ID = "app-version-reload";

// Module-level idempotency for the current tab-load: once a mismatch has been
// handled we don't re-arm the navigation reload or re-show the banner on
// subsequent app-version emits.
let handled = false;

// Variant C: on a real mismatch we do NOT reload the tab when it merely goes to
// the background (that would silently drop a half-written comment/form). Instead
// we arm a one-shot reload for the NEXT in-app router navigation — a point where
// the user is already leaving the current page, so an in-app navigation would
// discard that unsaved component-state anyway and the reload adds no extra loss.
let pendingNavReload = false;

// Remembered from the last detected mismatch for the pre-reload breadcrumb and
// the (already-visible) banner.
let lastServerVersion = "";
let lastClientVersion = "";

// Read the build version baked into THIS bundle. The `typeof` guard avoids a
// ReferenceError where the `APP_VERSION` global is absent (e.g. under vitest,
// where Vite's `define` did not run) — an unknown client version makes the
// pure decision no-op (fail-safe).
function readClientVersion(): string {
  return (typeof APP_VERSION !== "undefined" ? APP_VERSION : "").trim();
}

// Perform the actual reload — but only after the shared one-shot flag is
// persisted. If the write fails (storage unavailable) we must NOT reload
// (mirrors the reactive chunk-load boundary's `catch → return`), and fall back
// to the manual banner so the user can still recover.
function performAutoReload(): void {
  if (!markAutoReloaded()) {
    showReloadBanner();
    return;
  }
  // Trace right before the reload (which clears the console): a persistent
  // breadcrumb + a log line so the auto-reload is observable in a field report.
  recordReloadBreadcrumb({
    path: "proactive",
    serverVersion: lastServerVersion,
    clientVersion: lastClientVersion,
  });
  console.warn(
    `[version-coherence] auto-reloading: client=${lastClientVersion} -> server=${lastServerVersion}`,
  );
  window.location.reload();
}

function showReloadBanner(): void {
  notifications.show({
    id: BANNER_ID,
    title: i18n.t("A new version is available"),
    message: (
      <Button size="xs" mt="xs" onClick={() => performAutoReload()}>
        {i18n.t("Update")}
      </Button>
    ),
    autoClose: false,
    withCloseButton: true,
  });
}

/**
 * Handle a server `app-version` announcement: compare it to this bundle's
 * version and, on a real mismatch, show the banner and arm a guarded reload for
 * the next in-app navigation (variant C).
 *
 * - real mismatch (window budget available) → banner + arm navigation reload.
 *   The banner's "Update" button reloads immediately (same shared window guard).
 *   The tab is NOT reloaded on visibility change.
 * - auto-reload already used this window / storage error → banner only (no arm),
 *   so there is at most one automatic reload per RELOAD_WINDOW_MS window (loop
 *   safety).
 * - in sync / unknown version → noop (fail-safe).
 */
export function triggerGuardedReload(
  rawServerVersion: string | undefined | null,
): void {
  const serverVersion = (rawServerVersion ?? "").trim();
  const clientVersion = readClientVersion();

  // A storage read error surfaces as autoReloadUsed=true → fail toward NOT
  // reloading (banner only).
  const autoReloadUsed = hasAutoReloaded();

  const action = decideVersionAction({
    serverVersion,
    clientVersion,
    autoReloadUsed,
  });
  if (action === "noop") return;

  // Idempotent per tab-load: don't re-arm or re-stack the banner across repeated
  // emits (reconnects) once we've already acted.
  if (handled) return;
  handled = true;

  lastServerVersion = serverVersion;
  lastClientVersion = clientVersion;

  if (action === "banner") {
    // Entered banner-only (permanent skew, node oscillation, or the window's
    // auto-reload budget already spent). Log for diagnosability; show the banner.
    console.warn(
      `[version-coherence] server=${serverVersion} client=${clientVersion}: ` +
        "auto-reload budget already spent this window — showing manual banner",
    );
    showReloadBanner();
    return;
  }

  // action === "reload" (variant C): show the banner and defer the auto-reload
  // to the next in-app navigation instead of reloading now / on visibility.
  showReloadBanner();
  pendingNavReload = true;
}

/**
 * Consume the armed one-shot navigation reload, if any. Called by
 * `useVersionReloadOnNavigation` on each in-app router navigation.
 */
export function consumeNavigationReload(): void {
  if (!pendingNavReload) return;
  pendingNavReload = false;
  performAutoReload();
}

/**
 * Hook (mounted inside the Router) that fires the armed one-shot reload on the
 * NEXT in-app router navigation after a version mismatch. Skips the initial
 * render so it only reacts to real navigations, not the first location.
 */
export function useVersionReloadOnNavigation(): void {
  const location = useLocation();
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    consumeNavigationReload();
  }, [location.key]);
}

/**
 * Surface (log once) the breadcrumb left by an auto-reload in the previous page
 * load — the reload cleared the console, so this makes a "tab reloaded itself"
 * report diagnosable. Call once on app startup.
 */
export function surfacePreviousReloadBreadcrumb(): void {
  const crumb = takeReloadBreadcrumb();
  if (!crumb) return;
  console.info(
    `[version-coherence] previous auto-reload: path=${crumb.path} ` +
      `client=${crumb.clientVersion ?? ""} -> server=${crumb.serverVersion ?? ""} ` +
      `at=${new Date(crumb.at).toISOString()}`,
  );
}

// Test-only: reset module-level latches between cases.
export function __resetGuardedReloadForTests(): void {
  handled = false;
  pendingNavReload = false;
  lastServerVersion = "";
  lastClientVersion = "";
}
