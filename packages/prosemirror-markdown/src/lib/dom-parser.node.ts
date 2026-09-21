/**
 * NODE registration of the injectable HTML parser (jsdom-backed).
 *
 * Importing this module for its SIDE EFFECT installs a jsdom-backed
 * {@link HtmlDocumentParser}. It is loaded by the package's default entry
 * (`index.ts`) so every existing Node consumer (server, mcp, git-sync) keeps
 * the identical jsdom behaviour with no code change. This is the ONLY module in
 * the import chain that imports `jsdom`; the browser entry never loads it, so
 * `jsdom` cannot reach the client bundle.
 */
import { JSDOM } from "jsdom";
// Use @tiptap/html's EXPLICIT server entry (happy-dom backed): it builds its own
// DOM internally and needs NO ambient global `window`, so the Node path never
// depends on which of @tiptap/html's conditional exports a resolver picks (Jest
// selects the browser entry, which would throw without a global window). This
// avoids the old module-level `global.window` jsdom shim entirely — that shim
// was timing-fragile (it had to be installed AFTER prosemirror-view's
// import-time env detection, or prosemirror-view reads an undefined `navigator`).
import { generateJSON } from "@tiptap/html/server";
import { setHtmlDocumentParser, setGenerateJson } from "./dom-parser.js";

setHtmlDocumentParser((html: string): Document => {
  // A fresh JSDOM per call mirrors the previous `new JSDOM(html)` usage in each
  // import pass — no shared mutable document between conversions, so concurrent
  // conversions never interfere.
  const dom = new JSDOM(html);
  return dom.window.document as unknown as Document;
});

setGenerateJson(generateJSON);
