/**
 * Public surface of `@docmost/prosemirror-markdown`.
 *
 * A headless, framework-free ProseMirror <-> Markdown converter plus the
 * Docmost schema mirror. Everything lives under `lib/` (the converter core);
 * this top-level barrel simply re-exports that surface so the package entry is
 * the converter surface.
 */
// DEFAULT (Node) entry: install the jsdom-backed HTML parser as a side effect
// BEFORE re-exporting the converter surface, so every Node consumer (server,
// mcp, git-sync) keeps the identical jsdom import behaviour with no code change.
// The browser entry (`./browser.js`) installs the native-`DOMParser` parser
// instead and never loads this module, so jsdom stays out of client bundles.
import "./lib/dom-parser.node.js";

export * from "./lib/index.js";
