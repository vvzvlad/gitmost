import { defineConfig } from "vitest/config";

// Dedicated config for the issue #581 performance bench + CI regression guard.
// Kept separate from vitest.config.ts so the perf run: (a) does not drag coverage
// instrumentation over the hot path (which would skew every measurement), and
// (b) runs in a single fork with no parallelism, so the numbers are stable and
// the machine-independent ratio asserts are meaningful. It IS run in CI: the
// package "test" script chains `vitest run && vitest run -c vitest.bench.config.ts`.
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.bench.ts"],
    pool: "forks",
    // Vitest 4: run the bench serially in a single worker for stable numbers.
    fileParallelism: false,
    coverage: { enabled: false },
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
