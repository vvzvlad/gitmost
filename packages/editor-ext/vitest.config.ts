import { defineConfig } from "vitest/config";

// Minimal vitest setup for @docmost/editor-ext (mirrors apps/client's config,
// trimmed to what the markdown/html-embed round-trip tests need). The markdown
// utils run in plain Node (marked + turndown), so no jsdom/react plugin is
// required here.
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.{test,spec}.ts"],
  },
});
