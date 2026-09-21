/**
 * BROWSER registration of the injectable HTML parser (native `DOMParser`).
 *
 * Importing this module for its SIDE EFFECT installs a `window.DOMParser`-backed
 * {@link HtmlDocumentParser}. It is loaded by the package's `browser.ts` barrel
 * (selected via the `"browser"` exports condition). It imports NO `jsdom`, so a
 * client bundle that resolves the browser entry never pulls jsdom in.
 *
 * The returned `Document` is a real browser document, so it exposes exactly the
 * same query/mutation surface the import passes use (`querySelector(All)`,
 * `createElement`, `createTreeWalker`/`NodeFilter` via `defaultView`,
 * `body.innerHTML`) as jsdom did on the Node path.
 */
// @tiptap/html's default (browser) entry: its `generateJSON` uses the native
// `window.DOMParser`, so it carries NO jsdom/happy-dom — keeping the client
// bundle free of Node-only DOM libs.
import { generateJSON } from "@tiptap/html";
import { setHtmlDocumentParser, setGenerateJson } from "./dom-parser.js";

setHtmlDocumentParser((html: string): Document => {
  // Native, always available in a browser (and in a jsdom/happy-dom test
  // environment, which is what the client vitest suite runs under). `text/html`
  // parsing matches jsdom's `new JSDOM(html)` behaviour for our fragments.
  return new DOMParser().parseFromString(html, "text/html");
});

setGenerateJson(generateJSON);
