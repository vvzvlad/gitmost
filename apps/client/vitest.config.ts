import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import * as path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    // Coverage gate (issue #324). v8 provider (not istanbul) so ESM barrels
    // like `@docmost/editor-ext` are not re-parsed/instrumented. Thresholds are
    // set a few points below the level measured on develop, scoped to the files
    // the suite exercises (`all: false`) rather than the whole app, so the gate
    // passes today but fails on a genuine coverage regression.
    //
    // The editor component graph is scored SEPARATELY from the rest of the app
    // (#564). Any test that touches the editor drags in every node view, menu and
    // toolbar under `src/features/editor/components/**` — `extensions.ts` imports
    // them statically, so BOTH `page-editor.local-first.test.tsx` (which mounts the
    // real PageEditor) and `extensions.code-yjs-key.test.ts` (which only imports
    // `mainExtensions`) load the whole graph. With `all: false` the DENOMINATOR is
    // "files loaded during the run", so ~3.5k statements that no test EXECUTES
    // joined it: that directory alone sits at ≈23% and drags the whole-app ratio
    // from ≈61% down to ≈49%. The suite covers MORE code in absolute terms; only
    // the ratio fell. Rather than weaken one gate for the whole app, each half
    // gets the threshold it can actually hold: the app (≈61%) keeps the original
    // 55/53/44/55, the loaded-but-unexercised component graph (≈23%) gets a floor
    // that still fails if it rots.
    //
    // The two globs PARTITION the report — note the LEADING `!` on the first key.
    // Vitest matches threshold globs with picomatch (negation supported) against the
    // path RELATIVE TO `config.root`, i.e. these globs assume the suite runs with
    // `apps/client` as root (as `pnpm -r test` does). Since v2 the `global` set is
    // "all files, even those matched by a glob" (see `resolveThresholds` in
    // vitest/dist/chunks/coverage.*.js), so a plain glob key does NOT take its files
    // out of the global tally — a global 55 would be checked against the diluted
    // ≈49% and fail. Keying the app-wide gate on the COMPLEMENT glob is what actually
    // scopes it; the global keys are therefore omitted (a threshold set with no
    // values is skipped).
    coverage: {
      enabled: true,
      provider: 'v8',
      reporter: ['text-summary', 'text'],
      all: false,
      thresholds: {
        // Everything EXCEPT the editor component graph — the real gate.
        '!src/features/editor/components/**': {
          statements: 55,
          branches: 53,
          functions: 44,
          lines: 55,
        },
        // Loaded by any editor test, exercised only where a test opts in. Measured
        // ≈23/17/22/23; the floors sit a few points below that. `branches` gets the
        // widest margin on purpose: with `all: false` this ratio moves when a test
        // merely IMPORTS another node view (denominator up, numerator flat), so a
        // tight floor would red the build for a change that added no untested code.
        'src/features/editor/components/**': {
          statements: 20,
          branches: 12,
          functions: 20,
          lines: 20,
        },
      },
    },
  },
});
