import bytes from "bytes";
import { castToBoolean } from "@/lib/utils.tsx";
import { AvatarIconType } from "@/features/attachments/types/attachment.types.ts";
import { sanitizeUrl } from "@/lib/sanitize-url.ts";

declare global {
  interface Window {
    CONFIG?: Record<string, string>;
  }
}

export function getAppName(): string {
  return "Gitmost";
}

export function getAppUrl(): string {
  return `${window.location.protocol}//${window.location.host}`;
}

export function getServerAppUrl(): string {
  return getConfigValue("APP_URL");
}

export function getBackendUrl(): string {
  return getAppUrl() + "/api";
}

export function getCollaborationUrl(): string {
  const baseUrl =
    getConfigValue("COLLAB_URL") ||
    (import.meta.env.DEV ? process.env.APP_URL : getAppUrl());

  const collabUrl = new URL("/collab", baseUrl);
  collabUrl.protocol = collabUrl.protocol === "https:" ? "wss:" : "ws:";
  return collabUrl.toString();
}

export function getSubdomainHost(): string {
  return getConfigValue("SUBDOMAIN_HOST");
}

export function isCloud(): boolean {
  return castToBoolean(getConfigValue("CLOUD"));
}

export function isCompactPageTreeEnabled(): boolean {
  return castToBoolean(getConfigValue("COMPACT_PAGE_TREE", "true"));
}

// #355 — operator toggle for client perf-telemetry. DEFAULT OFF: the server
// mirrors CLIENT_TELEMETRY_ENABLED into window.CONFIG; when off the client
// installs no observers and sends nothing (the sink endpoint doesn't exist).
export function isClientTelemetryEnabled(): boolean {
  return castToBoolean(getConfigValue("CLIENT_TELEMETRY_ENABLED", "false"));
}

// #639 §4 — optional dev override of the telemetry sampling rate (0..1). When
// UNSET the default 25% session sampling applies. Set to "1" to force-collect on
// every reload while taking a baseline, so a stale "not sampled" tab-session
// decision cannot silently collect nothing. Returns the raw string ("" when
// unset); parsing/clamping lives in vitals.ts.
export function getClientTelemetrySampleRate(): string {
  return getConfigValue("CLIENT_TELEMETRY_SAMPLE_RATE", "");
}

// #563 — operator toggle for the local-first page boot cache. DEFAULT OFF: the
// server mirrors LOCAL_FIRST_ENABLED into window.CONFIG; when off the page-meta
// boot cache is neither written nor read and the page behaves exactly as before
// (skeleton until the network resolves). Rollback is a flag flip, not a deploy —
// a revert would not clean already-written localStorage.
export function isLocalFirstEnabled(): boolean {
  return castToBoolean(getConfigValue("LOCAL_FIRST_ENABLED", "false"));
}

// #640 — network-independent session boundary. After OFFLINE_GRACE has elapsed
// since the last successful `/me` (`sessionVerifiedAt`), the client refuses to
// draw ANY local content (chrome, tree, ydoc body) and purges it — offline or
// not. Default 30d, equal to JWT_TOKEN_EXPIRES_IN: the server treats the session
// dead after that, so drawing local content longer would show data beyond the
// session's life with nothing able to interrupt it. Env-override via
// OFFLINE_GRACE (mirrored into window.CONFIG by the server).
const DEFAULT_OFFLINE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

// Parse a duration like "30d" / "720h" / "43200m" / a bare-ms number. Kept
// inline (no `ms` dependency in the client bundle) and defensive: anything
// unparseable falls back to the 30-day default rather than throwing.
function parseDurationMs(raw: string | undefined): number {
  if (!raw) return DEFAULT_OFFLINE_GRACE_MS;
  const trimmed = raw.trim();
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?$/i.exec(trimmed);
  if (!match) return DEFAULT_OFFLINE_GRACE_MS;
  const value = parseFloat(match[1]);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_OFFLINE_GRACE_MS;
  const unit = (match[2] ?? "ms").toLowerCase();
  const factor: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  return value * (factor[unit] ?? 1);
}

export function getOfflineGraceMs(): number {
  return parseDurationMs(getConfigValue("OFFLINE_GRACE", "30d"));
}

// #641, part 5 — per-request timeout for the OFFLINE-CRITICAL requests (/me,
// /pages/info, /spaces/*) ONLY. It is deliberately NOT set on the axios instance
// (api-client.ts): uploads, imports and long exports share that instance and
// must stay untimed (they are already special-cased there). A hung connection —
// captive portal, half-open TCP after a laptop wake — otherwise never settles,
// so the page sticks in a skeleton forever with neither data nor error. 15s is
// well above a slow-mobile TTFB yet bounds such a hang so it resolves into a
// transport error the offline path can handle.
export const OFFLINE_CRITICAL_TIMEOUT_MS = 15_000;

/**
 * Axios per-request config for an offline-critical request. Returns the timeout
 * ONLY when local-first is enabled, so a flag-OFF deploy is byte-for-behavior
 * unchanged (axios default: no timeout, requests can hang indefinitely as today).
 */
export function offlineCriticalRequestConfig(): { timeout?: number } {
  return isLocalFirstEnabled() ? { timeout: OFFLINE_CRITICAL_TIMEOUT_MS } : {};
}

export function getAvatarUrl(
  avatarUrl: string,
  type: AvatarIconType = AvatarIconType.AVATAR,
) {
  if (!avatarUrl) return null;
  if (avatarUrl?.startsWith("http")) return avatarUrl;

  return getBackendUrl() + `/attachments/img/${type}/` + encodeURI(avatarUrl);
}

export function getSpaceUrl(spaceSlug: string) {
  return "/s/" + spaceSlug;
}

export function getFileUrl(src: string) {
  if (!src) return src;
  if (src.startsWith("http")) return src;
  if (src.startsWith("/api/")) {
    // Remove the '/api' prefix
    return getBackendUrl() + src.substring(4);
  }
  if (src.startsWith("/files/")) {
    return getBackendUrl() + src;
  }
  return sanitizeUrl(src);
}

export function getFileUploadSizeLimit() {
  const limit = getConfigValue("FILE_UPLOAD_SIZE_LIMIT", "50mb");
  return bytes(limit);
}

export function getFileImportSizeLimit() {
  const limit = getConfigValue("FILE_IMPORT_SIZE_LIMIT", "200mb");
  return bytes(limit);
}

export function getDrawioUrl() {
  return getConfigValue("DRAWIO_URL", "https://embed.diagrams.net");
}

// #629 — operator kill-switch for embedding a PNG raster into the saved
// .drawio.svg (Part A). DEFAULT OFF: the server mirrors DRAWIO_RASTER_ENABLED
// into window.CONFIG; when off the client saves an svg-only diagram exactly as
// before, so the added file-size is instantly reversible by a flag flip. This
// gates GENERATION only; consumption (Part B: server/mcp) is independent.
export function isDrawioRasterEnabled(): boolean {
  return castToBoolean(getConfigValue("DRAWIO_RASTER_ENABLED", "false"));
}

// #632 — operator kill-switch for embedding a PNG raster into the saved
// .excalidraw.svg (Part A), symmetric to DRAWIO_RASTER_ENABLED. DEFAULT OFF: the
// server mirrors EXCALIDRAW_RASTER_ENABLED into window.CONFIG; when off the
// client saves an svg-only excalidraw diagram exactly as before (byte-identical),
// so the added file-size is instantly reversible by a flag flip. This gates
// GENERATION only; consumption (Part B: server/mcp) is independent.
export function isExcalidrawRasterEnabled(): boolean {
  return castToBoolean(getConfigValue("EXCALIDRAW_RASTER_ENABLED", "false"));
}

export function getBillingTrialDays() {
  return getConfigValue("BILLING_TRIAL_DAYS");
}

export function getPostHogHost() {
  return getConfigValue("POSTHOG_HOST");
}

export function isPostHogEnabled(): boolean {
  return Boolean(getPostHogHost() && getPostHogKey());
}

export function getPostHogKey() {
  return getConfigValue("POSTHOG_KEY");
}

function getConfigValue(key: string, defaultValue: string = undefined): string {
  const rawValue = import.meta.env.DEV
    ? process?.env?.[key]
    : window?.CONFIG?.[key];
  return rawValue ?? defaultValue;
}
