/**
 * Injectable HTML-string -> DOM parser for the markdown import path.
 *
 * The markdown -> ProseMirror chain (`markdown-to-prosemirror.ts`) does three
 * post-`marked` DOM passes (task-list bridge, comment directives, footnote
 * assembly) that need a real DOM to query/mutate an HTML fragment. On the NODE
 * path that DOM comes from `jsdom`; in the BROWSER the platform already provides
 * a native `DOMParser` and `document`, and `jsdom` must NOT be bundled (size +
 * it is Node-only). So the concrete parser is INJECTED per environment rather
 * than imported statically here — this module carries no `jsdom` (or any DOM)
 * import, so nothing on the browser code path can transitively pull `jsdom` in.
 *
 * The Node entry (`./dom-parser.node.js`, loaded by the package's default
 * `index.js`) registers a jsdom-backed parser; the browser entry
 * (`./dom-parser.browser.js`, loaded by the `browser.js` barrel) registers a
 * `window.DOMParser`-backed one. A consumer that forgets to load an entry (e.g.
 * a raw deep import) gets a clear error instead of a silent wrong-environment
 * crash.
 */

/**
 * Parse an HTML string into a `Document`. The returned document must support the
 * standard query/mutation surface the import passes use: `querySelector(All)`,
 * `createElement`, `createTreeWalker` + `NodeFilter` (read off the document's
 * `defaultView`), and `body.innerHTML`.
 */
export type HtmlDocumentParser = (html: string) => Document;

/**
 * Convert an HTML string to a ProseMirror JSON doc against the given TipTap
 * extension set. This is `@tiptap/html`'s `generateJSON`, injected per
 * environment so the Node path binds its happy-dom `server` entry and the
 * browser path its native-`DOMParser` entry — neither leaking the other's DOM
 * lib into the wrong bundle.
 */
export type GenerateJsonFn = (html: string, extensions: any[]) => any;

let injectedParser: HtmlDocumentParser | null = null;
let injectedGenerateJson: GenerateJsonFn | null = null;

/**
 * Register the environment's HTML parser. Called ONCE at import time by the
 * Node or browser entry module. Idempotent-friendly: the last registration
 * wins, so a test harness can override it.
 */
export function setHtmlDocumentParser(parser: HtmlDocumentParser): void {
  injectedParser = parser;
}

/**
 * Parse `html` into a `Document` using the registered parser. Throws a clear
 * error when no environment entry has registered one (the caller imported the
 * converter without going through the Node/browser barrel).
 */
export function parseHtmlDocument(html: string): Document {
  if (!injectedParser) {
    throw new Error(
      "No HTML DOM parser registered. Import `@docmost/prosemirror-markdown` " +
        "(Node) or `@docmost/prosemirror-markdown/browser` (browser) so the " +
        "environment's DOM parser is installed before calling the converter.",
    );
  }
  return injectedParser(html);
}

/**
 * Register the environment's `generateJSON` (HTML -> ProseMirror JSON). Called
 * ONCE at import time by the Node or browser entry module.
 */
export function setGenerateJson(fn: GenerateJsonFn): void {
  injectedGenerateJson = fn;
}

/**
 * Run the registered `generateJSON`. Throws a clear error when no environment
 * entry has registered one (same cause as {@link parseHtmlDocument}).
 */
export function generateJsonWith(html: string, extensions: any[]): any {
  if (!injectedGenerateJson) {
    throw new Error(
      "No generateJSON registered. Import `@docmost/prosemirror-markdown` " +
        "(Node) or `@docmost/prosemirror-markdown/browser` (browser) so the " +
        "environment's generateJSON is installed before calling the converter.",
    );
  }
  return injectedGenerateJson(html, extensions);
}
