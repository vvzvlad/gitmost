/**
 * Dynamic ESM import bridge for a CommonJS build.
 *
 * The server compiles with `module: commonjs`, and TypeScript downlevels a
 * literal `import()` expression to `require()` — which cannot load an ESM-only
 * package (`@docmost/mcp`, `@docmost/git-sync`). Indirecting through `new
 * Function` hides the `import()` from the TS downleveler so the REAL dynamic
 * `import()` survives to runtime and can load ESM from CommonJS.
 *
 * This is the single shared copy of that bridge. The per-package typed loaders
 * (git-sync.loader.ts, docmost-client.loader.ts, mcp.service.ts) import this and
 * keep their own typed `loadX()` wrappers (require.resolve + pathToFileURL +
 * memoization) on top.
 */
export const esmImport = new Function(
  'specifier',
  'return import(specifier)',
) as (specifier: string) => Promise<unknown>;
