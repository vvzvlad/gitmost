import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Ported docmost-sync tests import the converter through the upstream package
// barrel specifier `docmost-client`. We vendored only the PURE half of that
// package into `src/lib`, so alias the barrel specifier to our local lib
// barrel; everything those tests use (converter, canonicalize, markdown
// envelope, markdownToProseMirror) is re-exported there.
const here = path.dirname(fileURLToPath(import.meta.url));
const libBarrel = path.resolve(here, 'src/lib/index.ts');

export default defineConfig({
  resolve: {
    alias: {
      'docmost-client': libBarrel,
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Register the Node (jsdom) HTML parser before any test runs. Tests import
    // the converter via relative src/lib modules, bypassing the top-level entry
    // that normally installs the parser as a side effect (see setup file).
    setupFiles: ['test/setup.dom-parser.ts'],
  },
});
