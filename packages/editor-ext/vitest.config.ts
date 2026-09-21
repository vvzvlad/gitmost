import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.{test,spec}.ts"],
    // Coverage gate (issue #324). v8 provider avoids the istanbul AST-rewrite
    // that broke on this package's ESM barrel. Thresholds sit a few points
    // below the level measured on develop, over the files the suite exercises
    // (`all: false`), so the gate passes today and catches a real regression.
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text-summary", "text"],
      all: false,
      // functions lowered 60 -> 57 after issue #347 removed the editor-ext
      // markdown layer (src/lib/markdown) and its image/footnote round-trip
      // specs: that markdown behavior now lives in — and is tested by —
      // @docmost/prosemirror-markdown, so the editor-ext baseline shifts down.
      // Still a real gate (a few points below the post-removal measured level).
      thresholds: {
        statements: 54,
        branches: 44,
        functions: 57,
        lines: 54,
      },
    },
  },
});
