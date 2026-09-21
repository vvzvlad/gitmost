/**
 * Pure markdown -> ProseMirror conversion.
 *
 * The converter path is `markdownToProseMirror` (marked -> HTML ->
 * generateJSON) plus the two pre/post processors it needs (`preprocessCallouts`,
 * `bridgeTaskLists`). The gitmost server writes the resulting page bodies
 * natively through the collab gateway, so no websocket/Yjs write-path lives
 * here.
 */
import { Marked, Tokenizer } from "marked";
import { parseHtmlDocument, generateJsonWith } from "./dom-parser.js";
import type { TokenizerExtension, RendererExtension } from "marked";
import { docmostExtensions } from "./docmost-schema.js";
import { parseAttachedComment } from "./attached-comment.js";
import { markInternalLinks } from "./internal-links.js";
import { splitFootnoteParagraphs } from "./footnote.js";
import {
  decodeInlineMathLatex,
  escapeMathAttr,
  inlineMathAnchoredRe,
} from "./math-inline.js";
import {
  attachmentToHtml,
  audioToHtml,
  diagramToHtml,
  embedToHtml,
  pageEmbedToHtml,
  pdfToHtml,
  transclusionReferenceToHtml,
  videoToHtml,
  youtubeToHtml,
} from "./media-html.js";

/**
 * #293 canon #7: `==text==` (Obsidian/GFM highlight) inline syntax.
 *
 * `==` is NOT standard markdown, so we teach the parser to turn `==text==` into
 * `<mark>text</mark>`, which the schema's Highlight extension parses back into a
 * color-less `highlight` mark (see docmost-schema.ts). This mirrors the
 * serializer's no-color highlight form, so a plain highlight round-trips.
 *
 * This is an INLINE extension (mid-line, must respect token precedence so it
 * never fires inside an inline code span). The tokenizer requires a non-empty,
 * non-space-leading inner and re-tokenizes that inner via `this.lexer.inline-
 * Tokens`, so nested marks (bold/italic/links inside a highlight) round-trip.
 * The renderer re-parses the inner tokens and wraps them in `<mark>`.
 *
 * It is registered on a DEDICATED `Marked` instance owned by this module
 * (below), NOT the global `marked` singleton, so the `==` behavior cannot leak
 * into unrelated callers that import `marked` elsewhere in the monorepo.
 */
interface HighlightMarkToken {
  type: "highlightMark";
  raw: string;
  text: string;
  tokens: any[];
}

const highlightMarkExtension: TokenizerExtension & RendererExtension = {
  name: "highlightMark",
  level: "inline",
  // Point marked at the next `==` so the tokenizer is invoked at that offset.
  start(src: string) {
    const i = src.indexOf("==");
    return i < 0 ? undefined : i;
  },
  tokenizer(src: string) {
    // Require a non-empty, non-space-leading inner and a closing `==`. The lazy
    // `+?` matches the SHORTEST inner, so `==a== ==b==` yields two marks. `====`
    // (empty) and `==x` (unbalanced) do not match and stay literal text.
    const match = /^==(?=\S)([\s\S]+?)==/.exec(src);
    if (!match) return undefined;
    const token: HighlightMarkToken = {
      type: "highlightMark",
      raw: match[0],
      text: match[1],
      tokens: [],
    };
    // Re-tokenize the inner so marks nested inside the highlight round-trip.
    token.tokens = this.lexer.inlineTokens(match[1]);
    return token as any;
  },
  renderer(token: any) {
    return `<mark>${this.parser.parseInline(token.tokens)}</mark>`;
  },
};

/**
 * #293 canon #6: Obsidian-native math — `$LaTeX$` (inline) and `$$…$$` (block).
 *
 * INLINE `$…$` uses the SHARED pandoc currency-safe rule (math-inline.ts), the
 * SAME rule the serializer's prose escaper uses, so currency (`$5`,
 * `$5 and $10`) is NEVER math and a would-be-math prose `$x$` (escaped `\$x\$`
 * on export) stays literal. The captured inner LaTeX is decoded (`\$`→`$`) and
 * emitted as the schema's `span[data-type="mathInline"]` carrying the LaTeX in a
 * `text="…"` attribute (the schema's default attribute parser reads it back).
 *
 * BLOCK `$$…$$` matches a `$$` fence on its own line(s), capturing multi-line
 * LaTeX up to the next `$$` line, and emits `div[data-type="mathBlock"]`.
 *
 * Both fail OPEN: an unbalanced `$`/`$$`, or a currency `$`, returns undefined
 * from the tokenizer and stays literal text with no crash. Registered on the
 * SAME dedicated instance as the highlight extension (never the global marked
 * singleton), so the `$`/`$$` behavior cannot leak into unrelated callers.
 */
const mathInlineExtension: TokenizerExtension & RendererExtension = {
  name: "mathInline",
  level: "inline",
  start(src: string) {
    const i = src.indexOf("$");
    return i < 0 ? undefined : i;
  },
  tokenizer(src: string) {
    const match = inlineMathAnchoredRe().exec(src);
    if (!match) return undefined; // currency / unbalanced -> literal
    return {
      type: "mathInline",
      raw: match[0],
      text: decodeInlineMathLatex(match[1]),
    } as any;
  },
  renderer(token: any) {
    return `<span data-type="mathInline" data-katex="true" text="${escapeMathAttr(token.text)}"></span>`;
  },
};

const mathBlockExtension: TokenizerExtension & RendererExtension = {
  name: "mathBlock",
  level: "block",
  start(src: string) {
    const m = /(?:^|\n)\$\$/.exec(src);
    if (!m) return undefined;
    return m.index + (m[0].startsWith("\n") ? 1 : 0);
  },
  tokenizer(src: string) {
    // A `$$` fence on its own line, then the SHORTEST run up to the next `$$`
    // line (non-greedy, so it never swallows across an unrelated later fence).
    // The inner may be empty (an empty mathBlock) or multi-line.
    const match = /^\$\$[^\S\n]*\n([\s\S]*?)\n\$\$[^\S\n]*(?:\n|$)/.exec(src);
    if (!match) return undefined; // no closing fence -> literal
    return {
      type: "mathBlock",
      raw: match[0],
      text: match[1],
    } as any;
  },
  renderer(token: any) {
    return `<div data-type="mathBlock" data-katex="true" text="${escapeMathAttr(token.text)}"></div>`;
  },
};

/**
 * #293 canon #2: Pandoc/Obsidian inline footnotes — `^[note body]`.
 *
 * The single canonical markdown form carries the note body AT the reference
 * point. The crux is the tokenizer: it BALANCES `[`/`]` (respecting
 * backslash-escaped brackets) from the opening `^[` to its MATCHING `]`, so a
 * body that itself contains a `[link](url)` is captured whole — a lazy
 * `^\[([^\]]+)\]` would cut at the first inner `]` and fragment the parse.
 *
 * The renderer emits the schema's `<sup data-footnote-ref>` marker carrying the
 * (still-encoded) body in a `data-fn-text` attribute and NO id. A later
 * post-`marked` pass (assembleFootnotes) collects those sups, dedups by the EXACT
 * body text, ASSIGNS sequential ids (fn-1, fn-2, … in first-seen order), and
 * builds one doc-level `<div data-footnote-def>` per unique body inside a single
 * `<section data-footnotes>`. Assigning ids from the exact text (rather than a
 * hash) makes collisions between DIFFERENT bodies impossible (F1) while staying
 * race-free — all ids are assigned inside that one call from the local DOM, no
 * module state — and byte-stable (ids are never written to markdown; `^[body]`
 * carries only text, so identical bodies still merge).
 *
 * Fail-open: an unbalanced `^[` with no matching `]` returns undefined from the
 * tokenizer and stays literal text (no crash). `^[]` is a footnote with an empty
 * body. The reference form `[^id]` / `[^id]: def` is NOT parsed (no `^[`), so it
 * stays literal (an accepted hand-authoring gap; no backward compat). Registered
 * on the SAME dedicated instance as the highlight/math extensions.
 */
const footnoteInlineExtension: TokenizerExtension & RendererExtension = {
  name: "footnoteInline",
  level: "inline",
  start(src: string) {
    const i = src.indexOf("^[");
    return i < 0 ? undefined : i;
  },
  tokenizer(src: string) {
    if (!src.startsWith("^[")) return undefined;
    // Balance-scan from just after `^[` to the matching `]`. A backslash escapes
    // the next character (so `\[` / `\]` do not affect the depth), matching the
    // serializer's balanceBrackets.
    let depth = 1;
    let i = 2;
    while (i < src.length) {
      const c = src[i];
      if (c === "\\" && i + 1 < src.length) {
        i += 2;
        continue;
      }
      if (c === "[") {
        depth++;
        i++;
        continue;
      }
      if (c === "]") {
        depth--;
        if (depth === 0) break;
        i++;
        continue;
      }
      i++;
    }
    if (depth !== 0) return undefined; // unbalanced -> literal text (fail-open)
    const inner = src.slice(2, i); // content between `^[` and the matching `]`
    return {
      type: "footnoteInline",
      raw: src.slice(0, i + 1), // includes the closing `]`
      text: inner,
    } as any;
  },
  renderer(token: any) {
    // No id here (F1): assembleFootnotes assigns ids by dedup-ing the exact body.
    return `<sup data-footnote-ref data-fn-text="${escapeFootnoteAttr(token.text)}"></sup>`;
  },
};

/**
 * Escape a value placed in a double-quoted HTML attribute (footnote id /
 * body). Only `&` and `"` are special in that context; escaping them keeps the
 * attribute well-formed and is idempotent (jsdom decodes them back).
 */
function escapeFootnoteAttr(value: string): string {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * Options controlling which of the two *layered* markdown extensions the
 * canonical importer applies. Both default to `true`, so the human editor,
 * file-import and git-sync paths keep their existing behavior byte-for-byte;
 * ONLY the MCP markdown-write path opts OUT (see #502).
 *
 * The extensions are optional because they are the SOURCE of two silent
 * corruptions when an AGENT writes plain prose/config as markdown:
 *   - `parseMath`: a `$…$` span becomes a `mathInline` node. An agent writing a
 *     config like `export A=$FOO and B=$BAR` gets `$FOO and B=$` silently turned
 *     into a formula. With `parseMath:false` the `$` stays literal text (real
 *     formulas go through `update_page_json` with `mathInline`/`mathBlock`).
 *   - `fuzzyLinkify`: marked's GFM autolinker turns a SCHEMELESS `www.foo.com`
 *     (and email) into a link. With `fuzzyLinkify:false` a schemeless domain
 *     stays literal text; an EXPLICIT `https://…` STILL becomes a link (only the
 *     fuzzy, schemeless autolink is suppressed).
 */
export interface MarkdownImportOptions {
  /** Apply the `$…$` / `$$…$$` math extensions (default true). */
  parseMath?: boolean;
  /** Apply marked's GFM schemeless (fuzzy) autolinker (default true). */
  fuzzyLinkify?: boolean;
}

/**
 * `fuzzyLinkify:false` override of marked's built-in GFM `url` inline tokenizer.
 *
 * The stock tokenizer autolinks THREE shapes: a schemeless `www.host` domain, a
 * bare email, and an EXPLICIT `scheme://…` URL. #502 wants only the last kept —
 * a schemeless domain/email an agent typed as prose must stay literal text, but
 * a deliberate `https://…` still links. We delegate to the original tokenizer
 * and, when it matched, DROP the token (returning `undefined`, so the run stays
 * literal text) unless the matched RAW text carries an explicit `scheme:` prefix.
 * `www.`/email matches have no scheme in their raw text, so they are dropped;
 * `https://…`/`ftp://…` keep their link.
 */
const SCHEME_PREFIX_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const noFuzzyUrlTokenizer = {
  url(this: any, src: string) {
    const token = Tokenizer.prototype.url.call(this, src) as any;
    if (!token) return token;
    // Keep only explicit-scheme URLs; schemeless `www.`/email matches -> literal.
    return SCHEME_PREFIX_RE.test(token.raw) ? token : undefined;
  },
};

/**
 * Build a dedicated `marked` instance for a given extension combination: default
 * (GFM) options plus the `==` highlight and `^[…]` footnote inline extensions
 * ALWAYS, the `$…$`/`$$…$$` math extensions only when `parseMath`, and the
 * schemeless-autolink suppressor only when `!fuzzyLinkify`. Built on a private
 * `Marked` instance so nothing leaks into the global `marked` singleton.
 */
function buildMarkedInstance(parseMath: boolean, fuzzyLinkify: boolean): Marked {
  const extensions: (TokenizerExtension & RendererExtension)[] = [
    highlightMarkExtension,
    footnoteInlineExtension,
  ];
  if (parseMath) {
    extensions.push(mathInlineExtension, mathBlockExtension);
  }
  const instance = new Marked().use({ extensions });
  if (!fuzzyLinkify) {
    instance.use({ tokenizer: noFuzzyUrlTokenizer as any });
  }
  return instance;
}

// Memoize one instance per (parseMath, fuzzyLinkify) combination so the
// extensions are registered exactly once per combo (never on the global
// singleton). The default `(true, true)` instance preserves the pre-#502
// behavior exactly for the editor/file-import/git-sync paths.
const markedInstanceCache = new Map<string, Marked>();
function getMarkedInstance(parseMath: boolean, fuzzyLinkify: boolean): Marked {
  const key = `${parseMath}:${fuzzyLinkify}`;
  let instance = markedInstanceCache.get(key);
  if (!instance) {
    instance = buildMarkedInstance(parseMath, fuzzyLinkify);
    markedInstanceCache.set(key, instance);
  }
  return instance;
}

// NOTE: this module no longer installs a module-level `global.window`/`document`
// jsdom shim. The HTML->DOM passes below (bridgeTaskLists / applyCommentDirectives
// / assembleFootnotes) parse via the INJECTED `parseHtmlDocument` (jsdom on the
// Node entry, native `DOMParser` on the browser entry), and `@tiptap/html`'s v3
// `generateJSON` supplies its OWN DOM per environment (happy-dom in Node, native
// `DOMParser` in the browser) — so no ambient global DOM is needed here, and
// nothing on the browser code path statically imports jsdom.

/**
 * Hard ceiling above which we skip callout preprocessing entirely. The linear
 * scanner below has no quadratic blow-up, but we still cap input defensively so
 * a pathological multi-megabyte payload cannot tie up the event loop; in that
 * case the markdown is passed through verbatim (callouts are simply not
 * detected) rather than risking a slow scan.
 */
const MAX_CALLOUT_PREPROCESS_BYTES = 4 * 1024 * 1024; // 4 MB

/** Matches an opening callout fence: `:::type` (type captured, lower-cased). */
const CALLOUT_OPEN_RE = /^:::\s*(\w+)\s*$/;
/** Matches a bare closing callout fence: `:::`. */
const CALLOUT_CLOSE_RE = /^:::\s*$/;
/**
 * Matches an Obsidian-native callout opener: `> [!type]` (type captured). An
 * optional title after the type is allowed but ignored (the Docmost callout
 * schema has no title). The body is the following contiguous blockquote lines.
 */
// The callout's own `>` marker may be preceded by an ENCLOSING container prefix:
// list-item indentation (`  `) and/or blockquote markers (`> `). Group 1 captures
// that prefix (lazily, so the LAST `>` before `[!type]` is the callout's own).
const CALLOUT_BQ_OPEN_RE = /^([>\s]*?)>\s*\[!(\w+)\]/;
/** Matches the start/end of a code fence (``` or ~~~), capturing the marker. */
const CODE_FENCE_RE = /^(\s*)(`{3,}|~{3,})/;

/**
 * Pre-process Docmost-flavoured markdown: convert `:::type ... :::`
 * callout blocks (the syntax our markdown export produces) into HTML
 * divs that the callout extension parses. The inner content is rendered
 * through marked as regular markdown.
 *
 * Implemented as a single linear pass over the lines (no quadratic regex
 * rescan). It:
 *   - tracks fenced code regions (```...``` and ~~~...~~~) and never treats a
 *     `:::` line that lives inside a code fence as a callout delimiter, so a
 *     callout body that itself contains a fenced code block with a `:::` line is
 *     no longer corrupted;
 *   - matches an opening `:::type` line with the next CLOSING `:::` at the SAME
 *     nesting level, supporting NESTED callouts via a depth counter (an inner
 *     `:::type` opens a deeper level and consumes a matching `:::`);
 *   - emits the same `<div data-type="callout" data-callout-type="TYPE">` output
 *     (inner rendered through marked) as the previous regex implementation.
 */
// SYNCHRONOUS by construction: the only formerly-awaited call is
// `markedInstance.parse`, which returns a string synchronously for this
// instance (no async marked extensions are registered), so the whole callout
// preprocess is sync. Keeping it sync lets a sync converter entry
// (`markdownToProseMirrorSync`, used by the client's chat renderer which must
// stay synchronous) share this exact logic with the async entry.
function preprocessCallouts(markdown: string, markedInstance: Marked): string {
  // Defensive cap: skip preprocessing for pathologically large inputs.
  if (markdown.length > MAX_CALLOUT_PREPROCESS_BYTES) {
    return markdown;
  }

  // Recursively transform a slice of lines, converting top-level callouts in
  // that slice into <div> blocks and rendering their inner content (which may
  // itself contain nested callouts) through this same function.
  const transform = (lines: string[]): string => {
    const out: string[] = [];
    let inCodeFence = false;
    let codeFenceMarker = ""; // the exact run of backticks/tildes that opened it
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Inside a code fence, only its matching closing fence is significant;
      // everything else (including `:::` lines) is copied through verbatim.
      if (inCodeFence) {
        out.push(line);
        const fence = line.match(CODE_FENCE_RE);
        if (fence && fence[2].startsWith(codeFenceMarker[0]) &&
            fence[2].length >= codeFenceMarker.length) {
          inCodeFence = false;
          codeFenceMarker = "";
        }
        i++;
        continue;
      }

      // A code fence opening outside any callout body: enter code-fence mode.
      const fenceOpen = line.match(CODE_FENCE_RE);
      if (fenceOpen) {
        inCodeFence = true;
        codeFenceMarker = fenceOpen[2];
        out.push(line);
        i++;
        continue;
      }

      // An opening callout fence: scan forward (with code-fence and nested
      // callout awareness) for its matching closing `:::` at the same level.
      const open = line.match(CALLOUT_OPEN_RE);
      if (open) {
        const type = open[1].toLowerCase();
        const bodyLines: string[] = [];
        let depth = 1;
        let innerInCodeFence = false;
        let innerCodeFenceMarker = "";
        let j = i + 1;
        for (; j < lines.length; j++) {
          const bl = lines[j];
          if (innerInCodeFence) {
            const f = bl.match(CODE_FENCE_RE);
            if (f && f[2].startsWith(innerCodeFenceMarker[0]) &&
                f[2].length >= innerCodeFenceMarker.length) {
              innerInCodeFence = false;
              innerCodeFenceMarker = "";
            }
            bodyLines.push(bl);
            continue;
          }
          const innerFence = bl.match(CODE_FENCE_RE);
          if (innerFence) {
            innerInCodeFence = true;
            innerCodeFenceMarker = innerFence[2];
            bodyLines.push(bl);
            continue;
          }
          if (CALLOUT_OPEN_RE.test(bl)) {
            depth++;
            bodyLines.push(bl);
            continue;
          }
          if (CALLOUT_CLOSE_RE.test(bl)) {
            depth--;
            if (depth === 0) break; // matching close for THIS callout
            bodyLines.push(bl);
            continue;
          }
          bodyLines.push(bl);
        }

        if (j < lines.length) {
          // Found the matching closing fence: render the body (recursively, so
          // nested callouts are handled) and emit the callout div.
          const inner = transform(bodyLines);
          const renderedInner = markedInstance.parse(inner) as string;
          out.push(
            `\n<div data-type="callout" data-callout-type="${type}">${renderedInner}</div>\n`,
          );
          i = j + 1; // skip past the closing `:::`
          continue;
        }
        // No matching close (unterminated callout): treat the opener as a
        // literal line and continue, preserving the original text.
        out.push(line);
        i++;
        continue;
      }

      // An Obsidian-native callout: `> [!type]` opener; the body is the following
      // CONTIGUOUS blockquote (`>`-prefixed) lines. Strip ONE blockquote level and
      // recurse so nested callouts (`> > [!type]`) are handled, then emit the same
      // callout div the `:::` path produces. A normal blockquote (no `[!type]` on
      // its first line) does not match and stays a blockquote.
      //
      // PREFIX-aware: a callout nested inside a list item and/or a blockquote is
      // serialized with the enclosing container prefix in front of its own `>`
      // marker — `  > [!type]` (list indent) or `> > [!type]` (blockquote). We
      // capture that prefix, take only continuation lines carrying `prefix>`, strip
      // it, and re-apply the prefix to the emitted HTML block so the callout div
      // stays WITHIN its container (an unprefixed div would escape and re-parse as
      // a top-level callout / plain blockquote — silent structure loss).
      const bqOpen = line.match(CALLOUT_BQ_OPEN_RE);
      if (bqOpen) {
        const prefix = bqOpen[1];
        const type = bqOpen[2].toLowerCase();
        const cont = prefix + ">"; // a body line = prefix + the callout's own `>`
        const bodyLines: string[] = [];
        let j = i + 1;
        for (; j < lines.length; j++) {
          if (!lines[j].startsWith(cont)) break;
          // Drop the prefix + `>` + one optional space, leaving the body content.
          bodyLines.push(lines[j].slice(prefix.length).replace(/^>\s?/, ""));
        }
        const inner = transform(bodyLines);
        const renderedInner = markedInstance.parse(inner) as string;
        const block = `<div data-type="callout" data-callout-type="${type}">${renderedInner}</div>`;
        if (prefix.length === 0) {
          // Top-level callout: blank lines isolate the HTML block.
          out.push(`\n${block}\n`);
        } else if (prefix.includes(">")) {
          // Enclosing BLOCKQUOTE: prefix every line and add NO surrounding blank
          // lines — a blank line would terminate the blockquote and split the
          // callout out of it.
          out.push(block.split("\n").map((l) => prefix + l).join("\n"));
        } else {
          // Pure LIST-ITEM indentation: re-indent and keep the blank-line
          // separators (a loose list item), so the div sits at the marker column.
          out.push(
            `\n${block
              .split("\n")
              .map((l) => (l.length ? prefix + l : l))
              .join("\n")}\n`,
          );
        }
        i = j;
        continue;
      }

      out.push(line);
      i++;
    }

    return out.join("\n");
  };

  return transform(markdown.split("\n"));
}

/**
 * Bridge marked's checkbox lists to TipTap task lists.
 *
 * marked renders GitHub task list items (`- [x] done`) as a plain
 * `<ul><li><p><input type="checkbox" checked> text</p></li></ul>` WITHOUT the
 * markup TipTap's TaskList/TaskItem extensions parse. This rewrites such lists
 * into the shape those extensions expect:
 *   TaskList parseHTML matches `ul[data-type="taskList"]`,
 *   TaskItem matches `li[data-type="taskItem"]`,
 *   the checked state is read from `data-checked === "true"`.
 *
 * A list is only converted when it has at least one `<li>` and EVERY direct
 * `<li>` contains a checkbox input. Both `<ul>` and `<ol>` are considered: a
 * numbered checklist (`1. [x] a`, which marked renders as an `<ol>` of checkbox
 * `<li>`s) would otherwise lose its task state. TipTap task lists are unordered,
 * so a matching `<ol>` is emitted as `data-type="taskList"` exactly like a
 * `<ul>`. Mixed or ordinary lists (including ordinary `<ol>` lists) are left
 * untouched so they keep rendering as bullet/numbered lists. The marked `<p>`
 * wrapper is kept inside the `<li>` because TaskItem content allows paragraphs.
 */
function bridgeTaskLists(html: string): string {
  // Cheap early-out: if the markup contains no checkbox input at all there is
  // nothing to bridge, so skip the expensive JSDOM parse entirely. This is the
  // common case (most pages have no task lists).
  if (!/type=["']?checkbox/i.test(html)) {
    return html;
  }
  // Defensive cap (consistent with preprocessCallouts): skip the bridge for
  // pathologically large inputs rather than running a second expensive JSDOM
  // parse on a multi-megabyte payload. The markup is passed through verbatim.
  if (html.length > MAX_CALLOUT_PREPROCESS_BYTES) {
    return html;
  }
  const document = parseHtmlDocument(html);
  // Collect the checkbox(es) that belong to THIS <li> directly: either direct
  // child <input type="checkbox"> elements or ones inside the <li>'s direct <p>
  // child (the shape marked emits: `<li><p><input type="checkbox"> text</p></li>`).
  // Checkboxes nested deeper (e.g. inside a child <ul>/<ol>) are excluded so a
  // bullet <li> that merely contains a nested task sublist is not misdetected.
  // Raw inline HTML can put more than one checkbox in a single <li>; we gather
  // ALL of them so none survive into the converted item.
  const directCheckboxes = (li: Element): Element[] => {
    const found: Element[] = [];
    for (const child of Array.from(li.children)) {
      if (
        child.tagName === "INPUT" &&
        child.getAttribute("type") === "checkbox"
      ) {
        found.push(child);
        continue;
      }
      if (child.tagName === "P") {
        for (const inp of Array.from(
          child.querySelectorAll(":scope > input[type='checkbox']"),
        )) {
          found.push(inp);
        }
      }
    }
    return found;
  };
  // Both <ul> and <ol> are candidates: an <ol> whose every direct <li> carries
  // its own checkbox is a numbered checklist that must also become a taskList.
  const lists = Array.from(document.querySelectorAll("ul, ol"));
  for (const list of lists) {
    // Only consider DIRECT child <li> elements; nested lists are handled by
    // their own iteration of the outer loop.
    const items = Array.from(list.children).filter(
      (child) => child.tagName === "LI",
    );
    if (items.length === 0) continue;
    const itemCheckboxes = items.map((li) => directCheckboxes(li));
    // Convert only when every direct <li> carries at least one OWN checkbox.
    if (!itemCheckboxes.every((boxes) => boxes.length > 0)) continue;

    // A numbered checklist arrives as an <ol>. We must NOT leave the tag as
    // <ol> while tagging it data-type="taskList": generateJSON would then match
    // BOTH the orderedList rule (tag ol) and the taskList rule (data-type),
    // emitting a phantom empty orderedList beside the real taskList. So rename a
    // qualifying <ol> to a <ul> — move its <li> children over and replace it —
    // leaving only the taskList rule to match. Already-<ul> lists are unchanged.
    let target: Element = list;
    if (list.tagName === "OL") {
      const ul = document.createElement("ul");
      // Carry over existing attributes (e.g. class) so nothing is silently lost.
      for (const attr of Array.from(list.attributes)) {
        ul.setAttribute(attr.name, attr.value);
      }
      // Move every child node (including the <li>s we collected) into the <ul>.
      while (list.firstChild) {
        ul.appendChild(list.firstChild);
      }
      list.replaceWith(ul);
      target = ul;
    }

    target.setAttribute("data-type", "taskList");
    items.forEach((li, index) => {
      const boxes = itemCheckboxes[index];
      // The first checkbox determines the checked state (matches the previous
      // single-checkbox behaviour); any extras only need removing.
      const input = boxes[0] ?? null;
      li.setAttribute("data-type", "taskItem");
      const checked =
        input != null &&
        (input.hasAttribute("checked") || (input as any).checked);
      li.setAttribute("data-checked", checked ? "true" : "false");
      // Remove ALL direct checkbox inputs so none survive into the content
      // (a raw-inline-HTML <li> may carry more than one).
      for (const box of boxes) {
        box.remove();
      }
    });
  }
  return document.body.innerHTML;
}

/**
 * Re-apply ATTACHED HTML comments (#293 canon) before the DOM/generateJSON
 * stage drops them.
 *
 * The serializer appends attributes that have no native markdown syntax as a
 * trailing `<!--name {json}-->` comment on the block's line (see
 * attached-comment.ts). `marked` keeps that comment as an HTML comment NODE
 * inside the block element (`<p>text <!--attrs {…}--></p>`), but the next stage
 * (parse5/jsdom via generateJSON) discards comment nodes, so the attributes
 * would be lost. This pass runs on the post-`marked` HTML: for every attached
 * comment it re-expresses the encoded attributes in a form the schema's
 * parseHTML already understands, then removes the comment so it cannot leak.
 *
 * This pass materializes BOTH comment conventions, discriminated by position:
 *
 *   - ATTACHED comments (#9 `attrs`): a comment sitting INSIDE a `<p>`/`<hN>`
 *     (same rendered line as visible content). The only handled key is
 *     `textAlign`, re-expressed as an inline `text-align` style on the parent,
 *     which the docmost-schema textAlign global attribute reads back.
 *   - ATTACHED image comments (#4 `img`): a comment bound to an `<img>` (its
 *     previous element sibling), e.g. `![](src) <!--img {"align":"left"}-->`
 *     rendered as `<p><img> <!--img …--></p>`. Each decoded key is written as
 *     the DOM attribute the image schema's parseHTML reads back (align/width/
 *     height/data-size/data-aspect-ratio/data-attachment-id/data-caption/title).
 *     An `img` comment with no adjacent <img> is INERT.
 *   - STANDALONE machinery comments (#5 `subpages`/`pagebreak`): a lone comment
 *     line, which `marked` renders as an HTML block so jsdom makes it a DIRECT
 *     child of `<body>`. These are replaced with the schema-matching block div
 *     (`<div data-type="pageBreak">` / `<div data-type="subpages" [data-recursive]>`)
 *     that the schema's parseHTML rebuilds into the atom.
 *   - MEDIA DISCRIMINATOR comments (#8): the comment NAME selects the node type.
 *     IMAGE-FORM (`youtube`/`video`/`audio`/`drawio`/`excalidraw`) binds to the
 *     preceding `<img>` (`![](src)<!--name …-->`); LINK-FORM (`pdf`/`attachment`/
 *     `embed`) binds to the preceding `<a>` (`[text](src)<!--name …-->`);
 *     STANDALONE (`pageembed`/`transclusion`) is a lone comment line. Each is
 *     re-expressed as the SAME schema HTML the serializer's raw-HTML path emits
 *     (media-html.ts) — the img's `src`/the anchor's `href`+text plus the decoded
 *     comment attrs — then swapped in for the `<img>`/`<a>`/comment. A bare
 *     `![](url)`/`[text](src)` with NO following discriminator stays an `image`/
 *     plain link (never sniffed by URL).
 *
 * Position determines legality: an `attrs` comment is honored only in attached
 * position, `subpages`/`pagebreak`/`pageembed`/`transclusion` only in standalone
 * position, an image-form comment only next to an `<img>` and a link-form comment
 * only next to an `<a>`; a comment in the wrong position/next to the wrong element
 * is left INERT (generateJSON drops it). Fail-open everywhere: a malformed comment
 * (null from parseAttachedComment), an unknown name, a wrong-position comment, or
 * an unknown/empty attr value is ignored.
 */
/**
 * A directive comment is in ATTACHED position when it sits inside a `<p>`/`<hN>`
 * textblock — bound to that block's text (the `attrs`/`img` conventions). Every
 * other parent (body, document level, a block container like blockquote/details/
 * li/column div) is STANDALONE position, where a lone-block directive
 * (subpages/pagebreak/pageembed/transclusion) is materialized. Broadening
 * standalone beyond body/document is what lets these nodes survive NESTED inside
 * a blockquote/callout/details/list item (previously dropped -> silent data loss).
 */
function isAttachedPosition(tag: string): boolean {
  return tag === "p" || /^h[1-6]$/.test(tag);
}

/**
 * Place a materialized standalone-directive element in the DOM: replace the
 * comment IN PLACE when it has a real element parent inside <body> (body itself
 * or a nested block container), preserving document order; queue it as a leading
 * div only when the comment is at document level (no parentElement) or directly
 * under `<html>` (outside <body>, which `document.body.innerHTML` would drop).
 */
function placeStandalone(
  comment: any,
  el: any,
  tag: string,
  leadingDivs: any[],
): void {
  if (comment.parentElement && tag !== "html") {
    comment.replaceWith(el);
  } else {
    comment.remove();
    leadingDivs.push(el);
  }
}

function applyCommentDirectives(html: string): string {
  // Cheap early-out: no comments at all -> nothing to intercept.
  if (!html.includes("<!--")) return html;
  const document = parseHtmlDocument(html);
  // `SHOW_COMMENT` (128) is a stable DOM constant. Read it from whichever holder
  // exists — the document's window (jsdom: `defaultView`), the ambient global
  // `NodeFilter` (browsers / test envs), else the literal — because a document
  // produced by `DOMParser.parseFromString` has NO browsing context, so its
  // `defaultView` is `null` (unlike a jsdom `new JSDOM(html).window.document`).
  // `createTreeWalker` takes the numeric `whatToShow` mask directly.
  const SHOW_COMMENT =
    (document.defaultView as any)?.NodeFilter?.SHOW_COMMENT ??
    (globalThis as any).NodeFilter?.SHOW_COMMENT ??
    0x80;
  // Walk the WHOLE document, not just <body>: when a standalone machinery
  // comment is the FIRST thing in the output (before any body content), the
  // HTML parser places it at document level (a child of `#document`, before
  // `<html>`), where it is outside `document.body` and would be lost. Attached
  // attrs comments always live inside body, so this wider walk still finds them.
  const walker = document.createTreeWalker(document, SHOW_COMMENT);
  const comments: any[] = [];
  let current: any;
  while ((current = walker.nextNode())) comments.push(current);

  // Standalone machinery comments that were parsed at document level (leading,
  // before body content) must be MOVED into body — in document order — since we
  // return `document.body.innerHTML`. Because the parser only puts LEADING
  // comments at document level, prepending them to body preserves global order.
  const leadingDivs: any[] = [];

  // #293 canon #8 discriminator NAME -> node form. The comment NAME alone selects
  // the node type; a bare `![](url)`/`[text](src)` with NO following comment is an
  // `image`/plain link (never sniffed). These are materialized below by rebuilding
  // the SAME schema HTML the serializer's raw-HTML path emits (media-html.ts), so
  // serialize and parse cannot drift.
  const IMAGE_FORM_NAMES = new Set([
    "youtube",
    "video",
    "audio",
    "drawio",
    "excalidraw",
  ]);
  const LINK_FORM_NAMES = new Set(["pdf", "attachment", "embed"]);

  // Parse a schema-HTML string (from a media-html builder) into its top-level
  // element so it can be swapped in for the <img>/<a>/comment it replaces.
  const buildElement = (htmlStr: string): any => {
    const tmp = document.createElement("div");
    tmp.innerHTML = htmlStr;
    return tmp.firstElementChild;
  };

  // Build the image-form schema HTML for a given discriminator name, using the
  // <img>'s src as the node src plus the decoded comment attrs.
  const imageFormHtml = (name: string, attrs: Record<string, any>): string => {
    switch (name) {
      case "video":
        return videoToHtml(attrs);
      case "audio":
        return audioToHtml(attrs);
      case "youtube":
        return youtubeToHtml(attrs);
      default: // drawio | excalidraw
        return diagramToHtml(name as "drawio" | "excalidraw", attrs);
    }
  };

  for (const comment of comments) {
    const parsed = parseAttachedComment(comment.data);
    if (!parsed) continue; // malformed -> inert (dropped by generateJSON)
    const parent = comment.parentElement as any;
    const tag = String(parent?.tagName || "").toLowerCase();

    if (parsed.name === "subpages" || parsed.name === "pagebreak") {
      // #293 canon #5 STANDALONE machinery. A lone comment line is rendered by
      // marked as its own HTML block; the parser places it under <body>, at
      // document level (leading), or — when the directive is NESTED — inside a
      // block CONTAINER (`<blockquote>` for blockquote/callout, `<details>`,
      // `<li>`, a column `<div>`, …). All of those are STANDALONE position. Only a
      // comment ATTACHED inside a `<p>`/`<hN>` (bound to that block's text) is
      // attached position -> INERT.
      if (isAttachedPosition(tag)) continue; // wrong position -> inert
      const div = document.createElement("div");
      if (parsed.name === "pagebreak") {
        div.setAttribute("data-type", "pageBreak");
      } else {
        div.setAttribute("data-type", "subpages");
        if (parsed.attrs.recursive === true) {
          div.setAttribute("data-recursive", "true");
        }
      }
      placeStandalone(comment, div, tag, leadingDivs);
      continue;
    }

    if (parsed.name === "pageembed" || parsed.name === "transclusion") {
      // #293 canon #8 STANDALONE media. Like subpages/pagebreak: a lone comment
      // line placed under <body>, at document level (leading), or NESTED inside a
      // block container (blockquote/callout/details/li/column). An ATTACHED-
      // position comment (inside a `<p>`/`<hN>`) is INERT. We rebuild the schema
      // div the raw-HTML path emits (media-html.ts) from the decoded attrs so
      // serialize/parse stay in sync.
      if (isAttachedPosition(tag)) continue; // wrong position -> inert
      const el = buildElement(
        parsed.name === "pageembed"
          ? pageEmbedToHtml({ sourcePageId: parsed.attrs.sourcePageId })
          : transclusionReferenceToHtml({
              sourcePageId: parsed.attrs.sourcePageId,
              transclusionId: parsed.attrs.transclusionId,
            }),
      );
      if (!el) continue; // defensive: builder always yields an element
      placeStandalone(comment, el, tag, leadingDivs);
      continue;
    }

    if (IMAGE_FORM_NAMES.has(parsed.name)) {
      // #293 canon #8 IMAGE-FORM media (youtube/video/audio/drawio/excalidraw).
      // `![](src)<!--name {…}-->` renders as `<p><img …><!--name …--></p>`, so
      // the target is the comment's previous element sibling and it MUST be an
      // <img>. We rebuild the schema element from the img's src + decoded attrs
      // and swap it in for the <img>. No adjacent <img> -> INERT.
      const prev = comment.previousElementSibling as any;
      const target =
        prev && String(prev.tagName || "").toLowerCase() === "img"
          ? prev
          : null;
      if (!target) continue; // no adjacent <img> -> inert
      const attrs = { ...parsed.attrs, src: target.getAttribute("src") || "" };
      const el = buildElement(imageFormHtml(parsed.name, attrs));
      if (!el) continue;
      target.replaceWith(el);
      comment.remove();
      continue;
    }

    if (LINK_FORM_NAMES.has(parsed.name)) {
      // #293 canon #8 LINK-FORM media (pdf/attachment/embed).
      // `[text](src)<!--name {…}-->` renders as `<p><a href="src">text</a>
      // <!--name …--></p>`, so the target is the previous element sibling and it
      // MUST be an <a>. src = a.href; the visible text is the filename/provider.
      // Not an <a> -> INERT.
      const prev = comment.previousElementSibling as any;
      const target =
        prev && String(prev.tagName || "").toLowerCase() === "a" ? prev : null;
      if (!target) continue; // no adjacent <a> -> inert
      const src = target.getAttribute("href") || "";
      const text = target.textContent || "";
      let htmlStr: string;
      if (parsed.name === "pdf") {
        // pdf: src standard attr, filename in data-name (null when empty).
        htmlStr = pdfToHtml({ ...parsed.attrs, src, name: text || null });
      } else if (parsed.name === "attachment") {
        // attachment: the schema field is `url`, filename in data-attachment-name.
        htmlStr = attachmentToHtml({
          ...parsed.attrs,
          url: src,
          name: text || null,
        });
      } else {
        // embed: the visible text is the provider (schema default "").
        htmlStr = embedToHtml({ ...parsed.attrs, src, provider: text });
      }
      const el = buildElement(htmlStr);
      if (!el) continue;
      target.replaceWith(el);
      comment.remove();
      continue;
    }

    if (parsed.name === "img") {
      // #293 canon #4 ATTACHED image attrs. `![](src) <!--img {…}-->` renders
      // as `<p><img …> <!--img …--></p>`, so the comment's target is the nearest
      // preceding <img> — its previousElementSibling. An `img` comment with no
      // adjacent <img> (e.g. a standalone `<!--img-->` at body level, or one
      // whose previous sibling is not an image) is INERT.
      const prev = comment.previousElementSibling as any;
      const target =
        prev && String(prev.tagName || "").toLowerCase() === "img"
          ? prev
          : null;
      if (!target) continue; // no adjacent <img> -> inert
      // Re-express each decoded key as the DOM attribute the schema's image
      // parseHTML reads back (docmost-schema.ts image attrs). Unknown keys are
      // ignored (fail-open); a bad JSON body already returned null above.
      const a = parsed.attrs;
      if (typeof a.align === "string" && a.align)
        target.setAttribute("align", a.align);
      if (a.width != null) target.setAttribute("width", String(a.width));
      if (a.height != null) target.setAttribute("height", String(a.height));
      if (a.size != null) target.setAttribute("data-size", String(a.size));
      if (a.aspectRatio != null)
        target.setAttribute("data-aspect-ratio", String(a.aspectRatio));
      if (a.attachmentId != null)
        target.setAttribute("data-attachment-id", String(a.attachmentId));
      if (a.caption != null)
        target.setAttribute("data-caption", String(a.caption));
      if (a.title != null) target.setAttribute("title", String(a.title));
      comment.remove();
      continue;
    }

    if (!parent) continue; // attrs comment must have an element parent
    if (parsed.name !== "attrs") continue; // unknown name -> inert
    const align = parsed.attrs.textAlign;
    // #293 canon #9 ATTACHED attrs: honored only in attached position.
    if (tag === "p" || /^h[1-6]$/.test(tag)) {
      // A real <p>/<hN> host (loose list item, top-level block, …): re-express as
      // an inline style; the schema's textAlign parseHTML reads `el.style.textAlign`
      // back onto the paragraph/heading node.
      if (typeof align === "string" && align) parent.style.textAlign = align;
      comment.remove();
    } else if (tag === "li" || tag === "td" || tag === "th") {
      // TIGHT list item / GFM table cell: marked emits the paragraph's inline
      // content DIRECTLY inside the <li>/<td>/<th> with NO <p> wrapper, so there
      // is no element to carry the style — generateJSON materializes the
      // paragraph later. Wrap the host's LEADING inline content (everything up to
      // the comment; any trailing block child such as a nested list stays put) in
      // a <p> carrying the alignment, so the materialized paragraph re-reads it.
      if (typeof align === "string" && align) {
        const p = document.createElement("p");
        p.style.textAlign = align;
        while (parent.firstChild && parent.firstChild !== comment) {
          p.appendChild(parent.firstChild);
        }
        parent.insertBefore(p, comment);
      }
      comment.remove();
    } else {
      // Misplaced `attrs` comment (not a textblock/li/cell host): inert. Consume
      // it anyway so no attached marker ever survives into the parsed body
      // (matches the pre-existing "consume regardless" behaviour).
      comment.remove();
    }
  }
  // Prepend any document-level (leading) standalone divs into body, preserving
  // their document order relative to each other and ahead of existing content.
  for (let i = leadingDivs.length - 1; i >= 0; i--) {
    document.body.insertBefore(leadingDivs[i], document.body.firstChild);
  }
  return document.body.innerHTML;
}

/**
 * #293 canon #2: assemble the doc-level footnote list from the `<sup>` markers.
 *
 * The `^[…]` inline extension (and the raw-HTML column path) leave every
 * footnote reference as `<sup data-footnote-ref data-fn-text>`, carrying the
 * (encoded) note body ON the marker but NO id. This post-`marked` pass — a
 * sibling of applyCommentDirectives, run before generateJSON — turns those into
 * the schema's three-node model:
 *
 *   - collect every `<sup data-footnote-ref>` that carries a `data-fn-text`;
 *   - DEDUP by the EXACT body text (first-seen order) and assign SEQUENTIAL ids
 *     `fn-1`, `fn-2`, …; set `data-id` on each sup (matched by its body). This is
 *     the F1 fix: distinct bodies get distinct ids, so DIFFERENT notes can never
 *     merge (a hash-derived id could collide and silently drop one body), while
 *     identical bodies still key to the same entry and MERGE (identical `^[text]`
 *     merge; a column footnote and an inline one with the same body collapse to
 *     one def);
 *   - build one `<div data-footnote-def data-id>` per unique body — the decoded
 *     `data-fn-text` split on the literal `\n` separator into `<p>`s, each parsed
 *     as INLINE markdown so links/marks in the note round-trip;
 *   - append those defs into a single doc-level `<section data-footnotes>` at the
 *     END of `<body>` — reusing an existing one if the HTML already has a
 *     footnotes section (F4: never emit a duplicate `<section>`);
 *   - STRIP `data-fn-text` from every sup, leaving `<sup data-footnote-ref
 *     data-id>` for the schema's FootnoteReference parseHTML.
 *
 * NESTED footnotes (N1): a body can itself contain a `^[…]` (Pandoc/Obsidian
 * allow it, and the schema's `footnoteDefinition` body is `paragraph+` → inline →
 * footnoteReference), so `parseInline` of a def body SPAWNS a new inner
 * `<sup data-fn-text>` INSIDE the just-built definition. A single scan would
 * leave that inner sup unassigned (dangling `footnoteReference{id:null}`, inner
 * body lost). So the pass runs to a FIXED POINT: after each round it RE-SCANS for
 * any `sup[data-footnote-ref][data-fn-text]` still lacking a `data-id` and
 * processes those too, reusing the SAME exact-body dedup map so an inner body
 * identical to another still merges. A large round cap bounds pathological input
 * (fail-open: leftover sups stay inert rather than looping forever).
 *
 * Race-free by construction: ids are assigned inside this one call from the local
 * DOM, so concurrent conversions share no mutable state. Fail-open: a sup without
 * `data-fn-text` (e.g. a legacy `<sup data-footnote-ref data-id>` from the old
 * `<section>` HTML form) is left untouched.
 */
// Hard cap on fixed-point rounds. Each round peels ONE nesting level, so this is
// far above any realistic footnote nesting; it exists only so an adversarial
// input can never spin unbounded. On hitting it we stop (leftover deeply-nested
// sups stay inert) rather than hang.
const MAX_FOOTNOTE_ROUNDS = 10000;

function assembleFootnotes(html: string, markedInstance: Marked): string {
  // Cheap early-out: nothing carries a footnote body -> nothing to assemble.
  if (!html.includes("data-fn-text")) return html;
  const document = parseHtmlDocument(html);
  if (document.querySelector("sup[data-footnote-ref][data-fn-text]") == null) {
    return html;
  }

  // F4: reuse an existing footnotes section if the HTML already has one (e.g. a
  // legacy `<section data-footnotes>` from the old HTML form, or a footnotesList
  // that landed inside a column via the raw-HTML path) so we never emit a
  // duplicate. Otherwise create one at the END of <body>.
  let section = document.querySelector("section[data-footnotes]");
  if (!section) {
    section = document.createElement("section");
    section.setAttribute("data-footnotes", "");
    // Attach it NOW (at the end of body), BEFORE the fixed-point loop: each def
    // is appended into this section, and a def body's `parseInline` may spawn a
    // nested `<sup data-fn-text>`. The re-scan below uses `document.query…`,
    // which only sees ATTACHED nodes — so the section must live in the document
    // for those inner sups to be found (N1). A detached section would hide them.
    document.body.appendChild(section);
  }

  // N2: seed the sequential id counter PAST the highest `fn-<N>` id already
  // present ANYWHERE in the document (a reused legacy section's defs, or existing
  // refs), so a generated id can never collide with a pre-existing one and
  // produce two defs sharing an id (ambiguous ref↔def).
  let counter = 0;
  for (const el of Array.from(document.querySelectorAll("[data-id]"))) {
    const m = /^fn-(\d+)$/.exec(el.getAttribute("data-id") || "");
    if (m) counter = Math.max(counter, parseInt(m[1], 10));
  }

  // Dedup by the EXACT body text (first-seen order) -> sequential id. Keyed on
  // the string itself, so two DIFFERENT bodies can NEVER share an id (F1). The
  // map persists ACROSS rounds so a nested inner body that equals an outer/other
  // body merges to the same def (N1).
  const idByBody = new Map<string, string>(); // exact body -> assigned id

  for (let round = 0; round < MAX_FOOTNOTE_ROUNDS; round++) {
    const pending = Array.from(
      document.querySelectorAll("sup[data-footnote-ref][data-fn-text]"),
    );
    if (pending.length === 0) break;
    for (const sup of pending) {
      const body = sup.getAttribute("data-fn-text") || "";
      let id = idByBody.get(body);
      const isNew = id === undefined;
      if (id === undefined) {
        id = `fn-${++counter}`;
        idByBody.set(body, id);
      }
      // Pin the id on the sup so the reference matches its definition, and strip
      // the transient body attribute so it never re-matches / reaches generateJSON.
      sup.setAttribute("data-id", id);
      sup.removeAttribute("data-fn-text");
      if (!isNew) continue; // this body already has its definition
      // Build the definition. `parseInline` may inject a NEW inner
      // `<sup data-fn-text>` into this def body — that is caught on the next
      // round's re-scan (the fixed-point loop).
      const def = document.createElement("div");
      def.setAttribute("data-footnote-def", "");
      def.setAttribute("data-id", id);
      // Split the encoded body into paragraph markdown strings, then parse each
      // inline so links/marks survive. An empty body yields one empty paragraph
      // (the schema's footnoteDefinition requires `paragraph+`).
      for (const paraMd of splitFootnoteParagraphs(body)) {
        const p = document.createElement("p");
        p.innerHTML = markedInstance.parseInline(paraMd) as string;
        def.appendChild(p);
      }
      section.appendChild(def);
    }
  }

  return document.body.innerHTML;
}

/**
 * Recursively strip content-less paragraph nodes from a generated doc.
 *
 * A block-level atom whose markdown form is INLINE (e.g. the block `image`'s
 * `![](url)`, or a bare media element) is wrapped by marked in a <p>; the schema
 * then HOISTS the block atom out of that paragraph, leaving an EMPTY paragraph
 * sibling. On the next export that empty `<p>` renders to "" and the doc "\n\n"
 * join injects a phantom blank gap, so the markdown is not byte-stable.
 *
 * Markdown blank lines are separators, never content, so generateJSON only ever
 * produces an empty paragraph as such a hoist artifact — removing them is safe
 * and general (it also subsumes the <div>-wrapper workaround the `video` case
 * uses). We remove ONLY `type === 'paragraph'` nodes whose `content` is absent
 * or an empty array; every other node (including atoms without `content`) is
 * preserved, and we recurse into the content of any node that has children.
 */
function stripEmptyParagraphs(node: any): any {
  if (!node || !Array.isArray(node.content)) {
    // Atom / leaf node (no children to recurse into): keep as-is.
    return node;
  }
  const mapped = node.content.map((child: any) => stripEmptyParagraphs(child));
  const isEmptyParagraph = (child: any): boolean =>
    !!child &&
    child.type === "paragraph" &&
    (!Array.isArray(child.content) || child.content.length === 0);
  const filtered = mapped.filter((child: any) => !isEmptyParagraph(child));
  // Schema-validity guard: several nodes require NON-empty block content
  // (`content: "block+"` — tableCell, tableHeader, blockquote, column, callout,
  // and the doc root). For an empty one of those, generateJSON materializes a
  // single empty paragraph as its OBLIGATORY content — that is not a hoist
  // artifact. If stripping would empty the container, keep ONE empty paragraph
  // so the result stays schema-valid (an empty cell/quote must not become `[]`).
  const cleaned =
    filtered.length === 0 && mapped.length > 0 ? [mapped[0]] : filtered;
  return { ...node, content: cleaned };
}

/**
 * Convert markdown to a ProseMirror doc using the full Docmost schema
 * (SYNCHRONOUS core). Every stage — callout preprocess, `marked` parse, the
 * three DOM passes, and generateJSON — is synchronous for this configuration
 * (no async marked extensions), so the conversion needs no `await`. The async
 * `markdownToProseMirror` below delegates here (its Promise return is preserved
 * for every existing Node consumer). A sync entry is REQUIRED by the client's
 * chat renderer, which runs inside a React render/useMemo and cannot await.
 */
export function markdownToProseMirrorSync(
  markdownContent: string,
  options?: MarkdownImportOptions,
): any {
  // Select the marked instance for this call's extension combination. Defaults
  // (math + fuzzy autolink ON) preserve the editor/file-import/git-sync paths;
  // the MCP markdown-write path passes both false (#502).
  const markedInstance = getMarkedInstance(
    options?.parseMath ?? true,
    options?.fuzzyLinkify ?? true,
  );
  const withCallouts = preprocessCallouts(markdownContent, markedInstance);
  const html = markedInstance.parse(withCallouts) as string;
  // Materialize comment directives (#293 #9 attached textAlign; #5 standalone
  // subpages/pageBreak) while the comment nodes still exist, before generateJSON
  // drops them.
  const withAttrs = applyCommentDirectives(html);
  // #293 canon #2: assemble the doc-level footnote list from the `<sup
  // data-fn-text>` markers (from `^[…]` or the raw-HTML column form) before
  // generateJSON, so references + definitions materialize into the schema model.
  const withFootnotes = assembleFootnotes(withAttrs, markedInstance);
  const bridged = bridgeTaskLists(withFootnotes);
  const doc = generateJsonWith(bridged, docmostExtensions);
  // Promote unambiguously-internal wiki-page links (`[t](/s/<space>/p/<slug>)`)
  // to their native internal form (`internal:true, target:null, rel:null`) so
  // they get same-tab SPA navigation, hover-preview, and backlink participation.
  // Every markdown import path funnels through here, so all of them are fixed at
  // once; external links are left untouched (#522).
  return markInternalLinks(stripEmptyParagraphs(doc));
}

/**
 * Convert markdown to a ProseMirror doc (async entry, unchanged contract). Kept
 * async so every existing Node consumer (server, mcp, git-sync) that `await`s
 * it is untouched; it simply delegates to the synchronous core.
 */
export async function markdownToProseMirror(
  markdownContent: string,
  options?: MarkdownImportOptions,
): Promise<any> {
  return markdownToProseMirrorSync(markdownContent, options);
}
