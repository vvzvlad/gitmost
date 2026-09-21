// Shared parse rule for lucide-react's `dist/esm/dynamicIconImports.mjs`.
//
// ONE source of truth for "how a dynamicIconImports entry maps a picker key to
// its underlying icon module", used by BOTH the catalog generator
// (`gen-lucide-catalog.mjs`) and the guard test (`lucide-catalog.generated.test.ts`).
// The rule must never be written twice — if the two drifted, the guard test
// could pass against a catalog the generator would never produce.
//
// Each entry looks like:
//   "house": () => import('./icons/house.mjs'),
//   "home":  () => import('./icons/house.mjs'),   // an alias → same module
// so the map is (picker key) → (module basename). Grouping by module basename
// yields the canonical names; every other key pointing at a module is an alias.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Matches one `"key": () => import('./icons/<basename>.mjs')` entry.
const ENTRY_RE =
  /"([a-z0-9-]+)":\s*\(\)\s*=>\s*import\('\.\/icons\/([a-z0-9-]+)\.mjs'\)/g;

/**
 * Resolve the on-disk path of the installed lucide-react's
 * `dist/esm/dynamicIconImports.mjs`. `require.resolve` on the package's own
 * export map keeps this pinned to the version in node_modules.
 */
export function resolveDynamicImportsPath(fromUrl) {
  const require = createRequire(fromUrl ?? import.meta.url);
  const pkgJson = require.resolve("lucide-react/package.json");
  return join(dirname(pkgJson), "dist/esm/dynamicIconImports.mjs");
}

/**
 * Parse a `dynamicIconImports.mjs` source string into `{ key, module }` pairs.
 *
 * Throws when the number of parsed entries does not equal the number of raw
 * `=> import(` occurrences: a partial parse (a shape the regex missed) is a
 * fatal signal that lucide changed the generated file's format, never something
 * to silently work around.
 */
export function parseDynamicIconImports(source) {
  const pairs = [];
  for (const m of source.matchAll(ENTRY_RE)) {
    pairs.push({ key: m[1], module: m[2] });
  }
  const rawCount = (source.match(/=>\s*import\(/g) ?? []).length;
  if (pairs.length !== rawCount) {
    throw new Error(
      `dynamicIconImports parse mismatch: matched ${pairs.length} entries but ` +
        `found ${rawCount} \`=> import(\` occurrences — the generated file's ` +
        `shape changed, refusing a partial parse.`,
    );
  }
  return pairs;
}

/**
 * Read + parse the installed lucide-react's dynamicIconImports and derive the
 * canonical/alias model:
 *   - canonical: the set of module basenames (each maps to exactly one geometry)
 *   - aliases:   every key whose name differs from its module basename → basename
 *
 * `keys` (all picker names), `canonical` (sorted), and `aliases` (name→canonical)
 * are returned. Both the generator and the guard test build the model from HERE.
 */
export function loadIconModel(fromUrl) {
  const path = resolveDynamicImportsPath(fromUrl);
  const source = readFileSync(path, "utf8");
  const pairs = parseDynamicIconImports(source);

  const keys = pairs.map((p) => p.key).sort();
  const canonical = [...new Set(pairs.map((p) => p.module))].sort();
  const aliases = {};
  for (const { key, module } of pairs) {
    if (key !== module) aliases[key] = module;
  }
  return { keys, canonical, aliases };
}

// Re-export the path helper's dirname of THIS module for callers that want to
// locate sibling files without re-deriving import.meta.url handling.
export const scriptDir = dirname(fileURLToPath(import.meta.url));
