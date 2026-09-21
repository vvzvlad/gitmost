/**
 * Vitest setup: register the Node (jsdom) HTML parser for the whole suite.
 *
 * The package's tests import the converter through the RELATIVE `src/lib/*`
 * modules (or the `docmost-client`/`src/lib/index` barrel), NOT through the
 * top-level `index.ts` entry that a real Node consumer imports — so the entry's
 * side-effect registration of the jsdom parser never runs here. This setup file
 * performs the SAME registration the Node entry does, so `markdownToProseMirror`
 * has a DOM parser in the (node-environment) tests, matching production Node
 * behaviour. The browser path is covered separately by the client paste tests
 * (jsdom vitest env + native DOMParser) and the dedicated dom-parser test.
 */
import "../src/lib/dom-parser.node.js";
