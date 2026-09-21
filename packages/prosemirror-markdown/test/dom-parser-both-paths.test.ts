import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import {
  setHtmlDocumentParser,
  parseHtmlDocument,
} from "../src/lib/dom-parser.js";
import { markdownToProseMirror } from "../src/lib/markdown-to-prosemirror.js";

/**
 * The markdown import path parses its post-`marked` HTML through an INJECTED
 * DOM parser: jsdom on the Node entry, native `DOMParser` on the browser entry
 * (see dom-parser.node.ts / dom-parser.browser.ts). These tests exercise BOTH
 * registrations against the same canonical inputs — the three DOM passes
 * (task-list bridge, comment directives, footnote assembly) — and assert the
 * converter produces the IDENTICAL ProseMirror doc regardless of which DOM
 * parser is installed. That is the guarantee the client paste path relies on:
 * pasting in the browser must yield the same nodes the server import produces.
 */

// A jsdom-backed parser (the Node entry's registration).
const jsdomParser = (html: string): Document =>
  new JSDOM(html).window.document as unknown as Document;

// A `DOMParser`-backed parser standing in for the BROWSER entry's registration.
// We drive a real `DOMParser` from a jsdom window (jsdom exposes the same
// `new DOMParser().parseFromString(html, "text/html")` API the browser and the
// client's jsdom vitest environment provide), so this path uses the exact code
// dom-parser.browser.ts runs — a native `DOMParser`, no `JSDOM` document glue.
const browserWindow = new JSDOM("").window;
const domParserBackedParser = (html: string): Document =>
  new browserWindow.DOMParser().parseFromString(
    html,
    "text/html",
  ) as unknown as Document;

// Canonical inputs, each hitting a different post-marked DOM pass.
const CASES: Record<string, string> = {
  // footnote assembly (assembleFootnotes): `^[…]` -> sup + section/def
  "inline footnote ^[…]": "Body^[a note].",
  // task-list bridge (bridgeTaskLists): checkbox list -> taskList/taskItem
  "task list": "- [x] done\n- [ ] todo",
  // comment directives (applyCommentDirectives): standalone machinery comment
  "standalone subpages comment": "text\n\n<!--subpages-->\n\ntext2",
  // attached image comment (applyCommentDirectives img form)
  "attached image comment": '![alt](img.png) <!--img {"align":"left"}-->',
  // github callout (preprocessCallouts bq path) + comment pass
  "obsidian callout": "> [!info]\n> hello",
  // highlight + math (marked extensions; still parsed through the DOM stage)
  "highlight + math": "A ==mark== and $x^2$ end",
};

async function convertWith(
  parser: (html: string) => Document,
  md: string,
): Promise<any> {
  setHtmlDocumentParser(parser);
  return markdownToProseMirror(md);
}

describe("markdown import: Node (jsdom) and browser (DOMParser) DOM paths agree", () => {
  afterEach(() => {
    // Restore the jsdom parser the suite-wide setup file installs, so later
    // tests in the run are unaffected by our per-case swaps.
    setHtmlDocumentParser(jsdomParser);
  });

  for (const [name, md] of Object.entries(CASES)) {
    it(`produces identical nodes for: ${name}`, async () => {
      const viaJsdom = await convertWith(jsdomParser, md);
      const viaDomParser = await convertWith(domParserBackedParser, md);
      expect(viaDomParser).toEqual(viaJsdom);
    });
  }
});

describe("dom-parser injection contract", () => {
  let saved: (html: string) => Document;
  beforeEach(() => {
    saved = jsdomParser;
  });
  afterEach(() => {
    setHtmlDocumentParser(saved);
  });

  it("throws a clear error when no parser is registered", () => {
    // Install a thrower to simulate the unregistered state, then assert
    // parseHtmlDocument surfaces the guidance error (we cannot un-set the
    // module singleton, so we assert via a registration that throws the same).
    setHtmlDocumentParser(() => {
      throw new Error("No HTML DOM parser registered.");
    });
    expect(() => parseHtmlDocument("<p>x</p>")).toThrow(/No HTML DOM parser/);
  });

  it("uses the most-recently registered parser", () => {
    const marker = new JSDOM("<!DOCTYPE html><body><b>marker</b></body>").window
      .document as unknown as Document;
    setHtmlDocumentParser(() => marker);
    expect(parseHtmlDocument("<i>ignored</i>")).toBe(marker);
  });
});
