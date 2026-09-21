import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CLIENT_CONFIG_KEYS,
  buildDefineEnv,
} from "@/lib/client-config-keys.ts";

/**
 * #638 finding 1 — the dev config plumbing, guarded by DERIVATION.
 *
 * In prod every client config value arrives through `window.CONFIG`, filled by
 * the server in `static.module.ts`. In DEV there is no server-rendered
 * `window.CONFIG`: `getConfigValue` reads `process.env[key]`, and vite replaces
 * `process.env` wholesale with the static object `vite.config.ts` builds. A key
 * absent from that object is not merely unset in dev — it is *unreachable*,
 * reading `undefined` forever and collapsing to `getConfigValue`'s default no
 * matter what `.env` says. That is why `isLocalFirstEnabled()` was ALWAYS false
 * in dev, so every dev verification of the local-first phases measured the old
 * path; the same held for OFFLINE_GRACE and the two raster flags.
 *
 * `vite.config.ts` now GENERATES that object via `buildDefineEnv`, so there is
 * one list instead of three. This test closes the remaining gap — that the list
 * still matches what `config.ts` actually reads — by DERIVING the required key
 * set from the `getConfigValue("…")` call sites rather than restating it. Adding
 * a `getConfigValue("NEW_KEY")` without listing NEW_KEY reds this suite.
 *
 * Note the trap this design avoids: under vitest `process.env` is the real Node
 * object and vite's substitution never runs, so a test that simply reads
 * `process.env.LOCAL_FIRST_ENABLED` passes vacuously and proves nothing about
 * the bundle. What a dev build actually sees is the output of `buildDefineEnv`,
 * so that function — the real one the config calls — is what is exercised here.
 */

// The client vitest runs with apps/client as cwd.
const CLIENT_ROOT = process.cwd();

const CONFIG_SOURCE = readFileSync(
  path.resolve(CLIENT_ROOT, "src/lib/config.ts"),
  "utf8",
);
const VITE_CONFIG_SOURCE = readFileSync(
  path.resolve(CLIENT_ROOT, "vite.config.ts"),
  "utf8",
);

/** Every key the client can ask `getConfigValue` for — the single source. */
function deriveConfigKeys(source: string): string[] {
  const keys = new Set<string>();
  const callSite = /getConfigValue\(\s*["']([A-Z][A-Z0-9_]*)["']/g;
  for (const match of source.matchAll(callSite)) keys.add(match[1]);
  return [...keys].sort();
}

const DERIVED_KEYS = deriveConfigKeys(CONFIG_SOURCE);

describe("dev config reachability (#638 finding 1)", () => {
  it("derives a non-trivial key set from config.ts", () => {
    // Guards the derivation itself: a regex that silently matched nothing would
    // make the drift assertion below vacuously true.
    expect(DERIVED_KEYS.length).toBeGreaterThanOrEqual(10);
    expect(DERIVED_KEYS).toContain("LOCAL_FIRST_ENABLED");
    expect(DERIVED_KEYS).toContain("APP_URL");
  });

  it("keeps getConfigValue module-private, so config.ts is the whole source", () => {
    // If it were exported, call sites outside config.ts could introduce keys the
    // derivation would never see, making this guard incomplete.
    expect(CONFIG_SOURCE).toContain("function getConfigValue(");
    expect(CONFIG_SOURCE).not.toContain("export function getConfigValue(");
  });

  it("makes EVERY key config.ts reads reachable in a dev build", () => {
    // A distinct sentinel per key: a key wired to the wrong source value fails
    // here too, not just a missing one.
    const env = Object.fromEntries(
      DERIVED_KEYS.map((key) => [key, `sentinel-${key}`]),
    );

    const devProcessEnv = buildDefineEnv(env);

    for (const key of DERIVED_KEYS) {
      expect(
        devProcessEnv[key],
        `${key} is readable via getConfigValue but is missing from CLIENT_CONFIG_KEYS, ` +
          `so it is baked into the dev bundle as undefined and unreachable in dev`,
      ).toBe(`sentinel-${key}`);
    }
  });

  it("lets a dev build actually see the local-first flag as enabled", () => {
    // The observable property the phase 1-2 dev verifications needed and never
    // had: with the flag configured, what `isLocalFirstEnabled()` reads in dev is
    // the literal "true" (castToBoolean maps it to true), not `undefined`
    // falling back to the "false" default.
    const devProcessEnv = buildDefineEnv({ LOCAL_FIRST_ENABLED: "true" });

    expect(devProcessEnv.LOCAL_FIRST_ENABLED).toBe("true");
  });

  it("keeps the define object generated from the single list", () => {
    // The generation is what makes the guard above meaningful: if vite.config
    // went back to hand-listing keys, CLIENT_CONFIG_KEYS could be correct while
    // the bundle still missed one.
    expect(VITE_CONFIG_SOURCE).toContain('"process.env": buildDefineEnv(env)');
  });

  it("does not leak non-allowlisted env into the browser bundle", () => {
    // `loadEnv(mode, dir, "")` returns the FULL server env, so the projection
    // must drop everything not on the list — otherwise secrets get inlined.
    const devProcessEnv = buildDefineEnv({
      APP_URL: "http://localhost:3000",
      DATABASE_URL: "postgres://user:pw@host/db",
      APP_SECRET: "super-secret",
    });

    expect(devProcessEnv.APP_URL).toBe("http://localhost:3000");
    expect(devProcessEnv).not.toHaveProperty("DATABASE_URL");
    expect(devProcessEnv).not.toHaveProperty("APP_SECRET");
    expect(Object.keys(devProcessEnv).sort()).toEqual([...CLIENT_CONFIG_KEYS].sort());
  });

  it("does not change any flag's default — reachable is not enabled", () => {
    // This change makes keys REACHABLE; it must not flip a default. The defaults
    // live in the `getConfigValue` call sites, untouched here, so an
    // unconfigured deploy (dev or prod) still reads exactly what it read before.
    expect(CONFIG_SOURCE).toContain(
      'getConfigValue("LOCAL_FIRST_ENABLED", "false")',
    );
    expect(CONFIG_SOURCE).toContain(
      'getConfigValue("DRAWIO_RASTER_ENABLED", "false")',
    );
    expect(CONFIG_SOURCE).toContain(
      'getConfigValue("EXCALIDRAW_RASTER_ENABLED", "false")',
    );
    expect(CONFIG_SOURCE).toContain('getConfigValue("OFFLINE_GRACE", "30d")');
  });
});
