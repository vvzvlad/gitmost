/**
 * BROWSER entry of `@docmost/prosemirror-markdown`.
 *
 * Selected via the package's `"browser"` exports condition (bundlers) so the
 * client gets the SAME public converter surface as the Node entry, but the
 * markdown-import DOM passes run on the native `window.DOMParser` instead of
 * jsdom. This module installs the native parser as a side effect BEFORE
 * re-exporting, and imports NO jsdom — so a client bundle that resolves this
 * entry carries no `jsdom` (nor any transitive jsdom import).
 *
 * The re-exported surface is identical to the default (Node) entry — the only
 * difference is which HTML-DOM parser is registered — so a browser consumer can
 * call `markdownToProseMirror` (and everything else) exactly as the server does.
 */
import "./lib/dom-parser.browser.js";

export * from "./lib/index.js";
