/**
 * The single source of truth for "which env keys the client can read at runtime".
 *
 * Why this file exists (#638 finding 1). In prod every value here reaches the
 * browser through `window.CONFIG`, filled server-side in `static.module.ts`. In
 * DEV there is no server-rendered `window.CONFIG`, so `getConfigValue` (config.ts)
 * falls back to `process.env[key]` — and vite replaces `process.env` wholesale
 * with a STATIC object built in `vite.config.ts`'s `define`. A key missing from
 * that object is therefore not merely unset in dev, it is *unreachable*: it reads
 * `undefined` forever and silently collapses to `getConfigValue`'s default no
 * matter what `.env` says.
 *
 * That allowlist used to be hand-maintained, listing each key TWICE (a `loadEnv`
 * destructuring plus the `define` object). It drifted exactly as AGENTS invariant
 * #7 predicts: `LOCAL_FIRST_ENABLED` was absent, so `isLocalFirstEnabled()` was
 * ALWAYS false in dev and every dev verification of the local-first phases
 * measured the old code path (#639); `OFFLINE_GRACE`, `DRAWIO_RASTER_ENABLED` and
 * `EXCALIDRAW_RASTER_ENABLED` were still absent after that.
 *
 * So the `define` object is now GENERATED from this list by `buildDefineEnv`
 * below — there is one copy, not three — and `config-keys.test.ts` derives the
 * required set from the `getConfigValue("…")` call sites in `config.ts` and FAILS
 * when this list drifts from them. Adding a `getConfigValue("NEW_KEY")` without
 * adding NEW_KEY here reds the suite instead of silently shipping a dev-dead flag.
 *
 * This module is imported by `vite.config.ts`, i.e. it is evaluated in Node
 * during config load. Keep it dependency-free and free of any browser or
 * `import.meta` reference.
 */
export const CLIENT_CONFIG_KEYS = [
  "APP_URL",
  "BILLING_TRIAL_DAYS",
  "CLIENT_TELEMETRY_ENABLED",
  // Dev override of the telemetry sampling rate, so a dev taking a baseline by
  // reloading does not silently collect nothing 3/4 of the time (#639 §4).
  "CLIENT_TELEMETRY_SAMPLE_RATE",
  "CLOUD",
  "COLLAB_URL",
  "COMPACT_PAGE_TREE",
  "DRAWIO_RASTER_ENABLED",
  "DRAWIO_URL",
  "EXCALIDRAW_RASTER_ENABLED",
  "FILE_IMPORT_SIZE_LIMIT",
  "FILE_UPLOAD_SIZE_LIMIT",
  "LOCAL_FIRST_ENABLED",
  "OFFLINE_GRACE",
  "POSTHOG_HOST",
  "POSTHOG_KEY",
  "SUBDOMAIN_HOST",
] as const;

export type ClientConfigKey = (typeof CLIENT_CONFIG_KEYS)[number];

/**
 * Build the object vite bakes in as `process.env` for a dev build, by projecting
 * the resolved env onto the allowlist above.
 *
 * Only these keys are projected: `loadEnv(mode, dir, "")` returns the FULL
 * environment (an empty prefix matches every key), so handing it to `define`
 * verbatim would inline server secrets — DATABASE_URL, APP_SECRET, provider API
 * keys — into a public browser bundle. The allowlist is what keeps that from
 * happening, which is why it stays an explicit list rather than a passthrough.
 */
export function buildDefineEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return Object.fromEntries(CLIENT_CONFIG_KEYS.map((key) => [key, env[key]]));
}
