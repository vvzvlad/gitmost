import { encodeHtmlEmbedSource } from "./docmost-schema.js";
import {
  attachedCommentFor,
  standaloneCommentFor,
} from "./attached-comment.js";
import {
  encodeInlineMathLatex,
  inlineMathGlobalRe,
  inlineMathSerializable,
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
 * Hard cap on processNode recursion depth (see the depth guard below).
 *
 * Chosen well above any realistic document (the deepest legitimate nesting the
 * editor can produce is far shallower) yet far below the point where the
 * converter's own call stack overflows. The heaviest shape (deeply nested
 * lists) costs ~5 JS frames per level and the runtime stack holds ~10k frames,
 * so the measured overflow is around level ~650 (deeply nested lists); 400
 * leaves a comfortable margin while still rendering pathological-but-bounded
 * docs in full (the 200-level stress fixture reaches depth ~204).
 */
const MAX_NODE_DEPTH = 400;

/**
 * Thrown by {@link convertProseMirrorToMarkdown} in `strict` mode when it hits a
 * node or mark type it has no lossless markdown form for (the serializer would
 * otherwise silently degrade it — drop an unknown mark, flatten an unknown node
 * to its children). Carries the offending kind/name so a caller (git-sync) can
 * surface exactly what would have been lost.
 */
export class ConverterLossError extends Error {
  readonly kind: "node" | "mark";
  readonly typeName: string;
  constructor(kind: "node" | "mark", typeName: string) {
    super(
      `convertProseMirrorToMarkdown: unknown ${kind} type "${typeName}" has no lossless markdown representation (strict mode)`,
    );
    this.name = "ConverterLossError";
    this.kind = kind;
    this.typeName = typeName;
  }
}

/**
 * Options for {@link convertProseMirrorToMarkdown}.
 */
export interface ConvertProseMirrorToMarkdownOptions {
  /**
   * When true, an inline comment anchor whose Comment mark is `resolved`
   * emits its BARE text (no `<span data-comment-id …>` wrapper), so an agent
   * reading the page never sees resolved-comment anchors. ACTIVE (unresolved)
   * anchors still emit their wrapper. Defaults to false — a zero-behavior
   * change for every existing caller, including the lossless git-sync export
   * path where resolved anchors MUST be preserved for round-tripping.
   */
  dropResolvedCommentAnchors?: boolean;
  /**
   * Optional sink for LOSS warnings. When the serializer reaches a node or mark
   * type it has no dedicated case for, it degrades gracefully (flattens an
   * unknown node to its children, drops an unknown mark) — historically a SILENT
   * data loss. When this array is provided, one human-readable message per such
   * event is pushed here so the caller can observe (and log) what was degraded.
   * Not provided by default -> behavior is byte-identical to before for existing
   * callers.
   */
  warnings?: string[];
  /**
   * When true, THROW a {@link ConverterLossError} on the FIRST unknown node/mark
   * instead of degrading silently — a warning becomes a hard error. Used by the
   * lossless git-sync export path and the converter tests, where an unmapped
   * type is a bug to surface, not data to quietly drop.
   */
  strict?: boolean;
}

/**
 * Adjacent sibling lists that share a markdown MARKER FAMILY re-parse as ONE
 * merged list — bulletList and taskList both emit `- ` markers (→ a single
 * `<ul>`), and two orderedLists both emit `1.` markers (→ a single `<ol>`). The
 * cross-type case is real data loss the editor CAN produce (e.g. a taskList
 * followed by a bulletList: the merged `<ul>` has a mix of checkbox and plain
 * items, so `bridgeTaskLists` refuses to convert it and every taskItem loses its
 * checkbox). Between two such adjacent list children we emit an empty HTML comment
 * `<!-- -->`: marked renders it as its own HTML block that interrupts the list, so
 * the two lists stay distinct; on import the comment is inert (parseAttachedComment
 * → null) and dropped by generateJSON, and re-export re-inserts it, so the marker
 * is byte-stable. It fires ONLY between two adjacent same-family list nodes — no
 * separator is emitted for any other join, so non-list output is unchanged.
 */
const LIST_MARKER_SEPARATOR = "<!-- -->";

/**
 * Backslash-escape a leading markdown BLOCK trigger so a serialized paragraph
 * line re-parses as a PARAGRAPH, not another block. Without this, a paragraph
 * whose text begins at column 0 with an ATX heading `#`, a blockquote/callout
 * `>`, a bullet marker `-`/`*`/`+`, an ordered marker `N.`/`N)`, a code fence
 * (```` ``` ````/`~~~`), a table `|`, or a thematic break (`---`/`***`/`___`,
 * solid or spaced) silently becomes a heading/list/quote/code block/table/rule
 * on the next markdown -> ProseMirror import — a known data-loss class (the
 * thematic-break case drops the text entirely, since a horizontalRule carries
 * none). CommonMark's escape tokenizer decodes the inserted `\` back to the
 * literal character on import AND stops the block interpretation, so the line
 * round-trips byte-exact as paragraph text. Only the FIRST offending character
 * is escaped (the minimum needed to break block recognition); a line that does
 * NOT open a block — emphasis `**x**`, an inline code span, ordinary prose — is
 * returned verbatim, so there is no backslash churn for the common case.
 *
 * Applied ONLY to paragraph text, once per `\n`-separated LINE (the paragraph
 * case splits on `\n` — each hardBreak emits `  \n` — so a trigger on a
 * continuation line is escaped too): headings/lists/blockquotes legitimately
 * open with these markers and render them from their own cases. This is the
 * single, canonical fix for the class the client bridge worked around with a
 * ZWSP (`gitmost-recording.ts`) and the generative suite self-censored around
 * (`text-arbitraries.ts`) — both now removed.
 */
function escapeLeadingBlockTrigger(line: string): string {
  // ATX heading: 1..6 `#` then whitespace/EOL.
  if (/^#{1,6}(?:\s|$)/.test(line)) return "\\" + line;
  // Blockquote / Docmost callout opener (`>` or `> [!info]`).
  if (line.startsWith(">")) return "\\" + line;
  // Bullet list marker then whitespace/EOL. Emphasis (`*x*`, `**x**`) has no
  // space after the leading marker and is intentionally left verbatim.
  if (/^[-*+](?:\s|$)/.test(line)) return "\\" + line;
  // Ordered list marker `N.` / `N)`: escape the DELIMITER so the digits stay
  // literal (`1. x` -> `1\. x`, which imports back as the text `1. x`).
  const ordered = line.match(/^(\d+)[.)](?:\s|$)/);
  if (ordered) {
    const digits = ordered[1].length;
    return line.slice(0, digits) + "\\" + line.slice(digits);
  }
  // Fenced code block: 3+ backticks or tildes. A single/double backtick is an
  // inline code span and is left verbatim.
  if (/^(?:`{3,}|~{3,})/.test(line)) return "\\" + line;
  // Thematic break: a WHOLE line of 3+ identical `-`/`*`/`_`, optionally spaced.
  if (/^([-*_])(?:\s*\1){2,}\s*$/.test(line)) return "\\" + line;
  // Setext underline: a continuation line (after a hardBreak) that is ONLY `-`
  // or ONLY `=` (any count, trailing spaces allowed). Under a paragraph line
  // such a line re-parses as a SETEXT HEADING and SILENTLY DROPS its own text
  // (`a\n--` -> heading "a", the `--` is LOST; `a\n=` -> heading "a", `=` LOST).
  // The bullet arm above catches a lone `-` (via its `$`) and the thematic arm
  // catches 3+ dashes, but exactly TWO dashes (`--`) fall through both; and no
  // arm covers a lone `=` at all (a `==` pair is neutralized earlier by the
  // inline `==`->`\=\=` escape, so only a single `=` line reaches here). Escaping
  // the leading char (`\--`, `\=`) breaks the setext interpretation so the line
  // round-trips as paragraph text. The WHOLE line must be the marker (anchored
  // `^-+`/`^=+` to EOL), so a mid-content `-`/`=` is never spuriously escaped;
  // and a `---`/`----` already handled by the thematic arm never reaches here,
  // so there is no double-escape.
  if (/^-+[ \t]*$/.test(line) || /^=+[ \t]*$/.test(line)) return "\\" + line;
  // GFM table row opener.
  if (line.startsWith("|")) return "\\" + line;
  return line;
}

function listMarkerFamily(type: string | undefined): "ul" | "ol" | null {
  if (type === "bulletList" || type === "taskList") return "ul";
  if (type === "orderedList") return "ol";
  return null;
}
function adjacentListsMerge(
  prevType: string | undefined,
  curType: string | undefined,
): boolean {
  const a = listMarkerFamily(prevType);
  return a !== null && a === listMarkerFamily(curType);
}
/**
 * Render each block child, inserting a `<!-- -->` separator entry between any two
 * adjacent same-marker-family list nodes (see LIST_MARKER_SEPARATOR). Callers
 * join the returned strings with their own context separator.
 */
function renderBlockChildren(
  children: any[],
  render: (n: any) => string,
): string[] {
  const out: string[] = [];
  let prevType: string | undefined;
  for (const child of children) {
    if (adjacentListsMerge(prevType, child?.type)) out.push(LIST_MARKER_SEPARATOR);
    out.push(render(child));
    prevType = child?.type;
  }
  return out;
}

/**
 * Convert ProseMirror/TipTap JSON content to Markdown
 * Supports all Docmost-specific node types and extensions
 */
export function convertProseMirrorToMarkdown(
  content: any,
  options: ConvertProseMirrorToMarkdownOptions = {},
): string {
  if (!content || !content.content) return "";

  // Closure flag read by both `case "comment"` emitters (the top-level marks
  // loop and the raw-HTML inlineToHtml path). Off by default; the agent-read
  // callers (mcp getPage / in-app AI chat) pass it true.
  const dropResolvedCommentAnchors = options.dropResolvedCommentAnchors === true;

  // Loss reporting for node/mark types with no dedicated serializer case. In
  // `strict` mode the FIRST such type throws (git-sync, tests); otherwise the
  // serializer degrades gracefully (as it always has) but records one warning
  // per unmapped type into the optional sink so the loss is observable, not
  // silent. Deduped per type so a document with many unknown nodes of one type
  // produces one message.
  const strict = options.strict === true;
  const warningsSink = options.warnings;
  const seenLossTypes = new Set<string>();
  const warnLoss = (kind: "node" | "mark", typeName: string): void => {
    if (strict) throw new ConverterLossError(kind, typeName);
    if (!warningsSink) return;
    const key = `${kind}:${typeName}`;
    if (seenLossTypes.has(key)) return;
    seenLossTypes.add(key);
    warningsSink.push(
      `Unknown ${kind} type "${typeName}" has no lossless markdown form; it was degraded on export.`,
    );
  };

  // Escape a value interpolated into an HTML double-quoted attribute value
  // (textAlign, colors, image src, math `text`, all data-* attrs, etc.). In the
  // ATTRIBUTE context only the quote that delimits the value and the ampersand
  // that starts an entity are special, so we escape ONLY & " (and ' for safety
  // when single-quoted delimiters are used). We deliberately do NOT escape < or
  // >: the HTML re-parser (parse5/jsdom via @tiptap/html) does NOT decode
  // &lt;/&gt; back inside attribute values, so escaping them would corrupt the
  // stored data (e.g. a math node's LaTeX `a < b`) and ACCUMULATE escapes on
  // every round-trip (`a < b` -> `a &lt; b` -> `a &amp;lt; b`). Escaping & "
  // keeps the value inert against attribute-injection while staying idempotent.
  // NOTE: escape ONLY & and " here. The value is always wrapped in double
  // quotes, so " is the only delimiter; ' is NOT special in a double-quoted
  // value, and parse5 does not decode &#39; back inside attribute values, so
  // escaping ' would (like < >) corrupt the value and accumulate &amp; on every
  // round-trip. Escaping & and " is idempotent (parse5 decodes them back).
  const escapeAttr = (value: unknown): string =>
    String(value)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;");

  // Escape a value placed as HTML element TEXT content (between tags), where
  // <, >, and & are all significant. Used for text rendered inside raw-HTML
  // blocks (table cells / columns) so stored characters cannot inject markup.
  const escapeHtmlText = (value: unknown): string =>
    String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  // Percent-encode characters that would break out of a markdown URL target
  // (...) — whitespace/newlines and parentheses — so a stored src stays a
  // single inert token (used for image/video/youtube srcs).
  const encodeMdUrl = (value: unknown): string =>
    String(value || "")
      .replace(/\s/g, (c: string) => (c === " " ? "%20" : encodeURIComponent(c)))
      .replace(/\(/g, "%28")
      .replace(/\)/g, "%29");

  // Backslash-escape every character that would be INTERPRETED inside a markdown
  // label re-parsed as inline content — used for a link-form media node's visible
  // text (`attrs.name`/`attrs.provider`, #293 canon #8) AND for an image `![alt]`
  // (canon #4) — so the value round-trips byte-exact. Two overlapping trigger
  // sets must be escaped:
  //   1. Stock CommonMark inline: emphasis (`* _`), code (`` ` ``), strikethrough
  //      (`~`), autolinks/raw-HTML (`<`), HTML entities (`&`), image markers (`!`),
  //      brackets (`[ ]`), and `( )` — even with `[ ]` escaped, an unescaped
  //      `](x)` forms a false nested-link destination and fragments the parse.
  //   2. The Docmost inline EXTENSIONS this package registers on its marked
  //      instance: highlight `==x==` (canon #7), math `$x$` (canon #6), and
  //      footnote `^[x]` (canon #2). Their triggers `= $ ^` are NOT CommonMark
  //      punctuation the stock lexer would treat specially, but the extension
  //      tokenizers fire on them — so an alt/name like `x $A$ y`, `use ==b==`, or
  //      `^[fn]` would be silently turned into a math/highlight/footnote node on
  //      import unless the trigger is escaped. `\= \$ \^` decode back to literals
  //      (all ASCII punctuation) and, being escape tokens, stop the extension
  //      tokenizer from matching — verified lossless round-trip.
  const escapeLinkText = (value: unknown): string =>
    String(value ?? "").replace(/[\\`*_~[\]<&!()=$^]/g, (c: string) => `\\${c}`);

  // #293 canon #6: the schema-HTML forms for math. These are the LOSSLESS forms
  // the raw-HTML path (columns/cells) and the mathInline fallback emit, and the
  // SAME shape the importer's schema parseHTML rebuilds (span/div carrying the
  // LaTeX in a `text="…"` attribute). Kept as small helpers so the readable
  // `$…$`/`$$…$$` markdown forms and the raw-HTML forms cannot drift apart.
  const mathInlineHtml = (latex: string): string =>
    `<span data-type="mathInline" data-katex="true" text="${escapeAttr(latex)}"></span>`;
  const mathBlockHtml = (latex: string): string =>
    `<div data-type="mathBlock" data-katex="true" text="${escapeAttr(latex)}"></div>`;

  // #293 canon #6: neutralize a would-be inline-math `$…$` span sitting in PROSE
  // text so it re-imports as literal text (never a phantom math node). We escape
  // ONLY the two delimiting `$` of a span the inline-math tokenizer WOULD match
  // (shared rule, math-inline.ts), leaving the inner untouched. A currency `$`
  // (`$5`, `$5 and $10`) has no VALID closing under the rule, so it never
  // matches and is emitted CLEAN (no backslash churn). On re-import marked's
  // escape tokenizer turns each `\$` back into a literal `$`, so `the set $A$`
  // round-trips as text while `$5 and $10` stays exactly as written.
  const escapeProseMath = (value: string): string =>
    value.replace(inlineMathGlobalRe(), (_m, inner) => `\\$${inner}\\$`);

  // #293 canon #2 inline footnotes. PRE-SCAN the whole tree once: map every
  // footnote DEFINITION by its id (first-wins) and collect every REFERENCED id.
  // The canonical markdown form inlines a note's body AT its reference point as
  // `^[body]`, so the serializer needs the body keyed by id when it reaches a
  // `footnoteReference`, and needs to know which definitions are orphaned (no
  // ref) so their bodies are not silently dropped (appended at the doc end).
  const footnoteDefs = new Map<string, any>();
  const referencedFootnoteIds = new Set<string>();
  // ITERATIVE walk (explicit stack, not recursion): a pathologically deep
  // document must not overflow the call stack here — the same reason processNode
  // has its depth guard. This scan is unbounded but stack-safe.
  const scanStack: any[] = [content];
  while (scanStack.length) {
    const n = scanStack.pop();
    if (!n || typeof n !== "object") continue;
    if (
      n.type === "footnoteDefinition" &&
      n.attrs?.id &&
      !footnoteDefs.has(n.attrs.id)
    ) {
      footnoteDefs.set(n.attrs.id, n);
    }
    if (n.type === "footnoteReference" && n.attrs?.id) {
      referencedFootnoteIds.add(n.attrs.id);
    }
    if (Array.isArray(n.content)) {
      for (const child of n.content) scanStack.push(child);
    }
  }

  // Balance `[`/`]` in a rendered footnote body so the whole thing stays a
  // parseable `^[…]` capture (the importer's tokenizer counts brackets from `^[`
  // to the matching `]`). A markdown link's `[text](url)` is already balanced
  // and is left intact; only a STRAY unmatched `]` (or `[`) — e.g. a literal
  // bracket in prose — is backslash-escaped so it cannot open/close the footnote
  // early. Already backslash-escaped pairs are passed through untouched.
  const balanceBrackets = (s: string): string => {
    const out: string[] = [];
    const openIndices: number[] = []; // positions in `out` of unmatched `[`
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === "\\" && i + 1 < s.length) {
        out.push(c + s[i + 1]); // keep an existing escaped pair verbatim
        i += 2;
        continue;
      }
      if (c === "[") {
        openIndices.push(out.length);
        out.push("[");
        i++;
        continue;
      }
      if (c === "]") {
        if (openIndices.length > 0) {
          openIndices.pop();
          out.push("]");
        } else {
          out.push("\\]"); // stray close -> escape
        }
        i++;
        continue;
      }
      out.push(c);
      i++;
    }
    for (const idx of openIndices) out[idx] = "\\["; // stray opens -> escape
    return out.join("");
  };

  // While TRUE, `case "text"` DOUBLES every RAW user backslash (`\` -> `\\`) in a
  // text run BEFORE the intentional markdown/balance escapes are layered on (see
  // the text case). This is the F2 fix: a body ending in `\` (Windows path,
  // LaTeX, regex) must survive `^[…]`. Without it a trailing `\` serialized to
  // `^[…\]`, whose `\]` the import tokenizer reads as an ESCAPED `]`, so the
  // balance never closed and the whole footnote degraded to literal prose (and
  // the `\` was lost). Doubling raw backslashes makes `parseInline` restore each
  // (`\\`->`\`) on import while the serializer's OWN single escapes (`\[` `\]`
  // `\=` `\$`, the `\n` paragraph separator) stay intact. It is a closure flag
  // (per-conversion, not module state), so concurrent conversions never share it.
  let inFootnoteBody = false;

  // Render a footnote DEFINITION's `paragraph+` body to INLINE markdown suitable
  // to sit inside `^[…]`. Each paragraph is rendered inline (so links/marks in
  // the note round-trip) with raw backslashes doubled (via inFootnoteBody) and
  // its brackets balanced; paragraphs are then joined with the literal two-char
  // separator `\n`. Because raw backslashes are already doubled, a real
  // backslash-n in the text is `\\n` and never mistaken for the separator (the
  // only unescaped `\n` is the join inserted here). Footnotes are inline (single
  // line) in markdown, so an embedded hard break collapses to a space.
  const renderFootnoteBody = (def: any): string => {
    const paras = (def?.content || []).filter(
      (p: any) => p?.type === "paragraph",
    );
    // A definition with no paragraph still yields one (empty) segment so an
    // empty note serializes as `^[]` and round-trips.
    const segments = (paras.length ? paras : [{ content: [] }]).map(
      (p: any) => {
        const prev = inFootnoteBody;
        inFootnoteBody = true;
        let s: string;
        try {
          s = renderInlineChildren(p.content || []);
        } finally {
          inFootnoteBody = prev;
        }
        // Collapse any real newline (e.g. a hard break) so `^[…]` stays on one
        // logical line for the inline tokenizer.
        s = s.replace(/\r?\n/g, " ");
        s = balanceBrackets(s);
        return s;
      },
    );
    return segments.join("\\n");
  };

  // Recursion depth guard. processNode is mutually recursive (directly and via
  // processListItem/processTaskItem/blockToHtml), and a pathologically nested
  // document (e.g. tens of thousands of nested blockquotes) would otherwise
  // overflow the call stack and throw a RangeError, which would abort the sync
  // and prevent the page from ever being written. We track the live nesting
  // depth in a closure counter (the wrapper below) so we NEVER throw: past the
  // limit we stop recursing and emit the node's own text (or nothing) instead.
  // Normal documents never approach MAX_NODE_DEPTH, so their output is byte-
  // identical. NOTE: the wrapper signature is (node) only — several callers use
  // `.map(processNode)`, which would otherwise pass the array index as a second
  // argument; the wrapper ignores extra arguments so that is harmless.
  let nodeDepth = 0;

  // A table cell whose content is NOT a single plain paragraph — a list, code
  // block, blockquote, multiple paragraphs, etc. A GFM pipe cell can only hold
  // inline content on one line, so such a cell must force the HTML <table> form
  // or its structure is flattened/lost on round trip (review #8).
  const cellIsMultiBlock = (cell: any): boolean => {
    const blocks = cell.content || [];
    if (blocks.length > 1) return true;
    const only = blocks[0];
    return only != null && only.type !== "paragraph";
  };

  // Render a whole table as raw HTML `<table>` (round-trips via the schema's
  // table-family parseHTML). Used when a GFM pipe table would be wrong: merged
  // cells (colspan/rowspan), multi-block cells (#8), OR the table sits inside a
  // raw-HTML container like a column (marked does not parse markdown inside raw
  // HTML, so a GFM pipe table there becomes literal "| a | b |" text — #7).
  // `blockToHtml` is referenced lazily (defined below; only called at runtime).
  const tableToHtml = (tableRows: any[]): string => {
    const renderHtmlCell = (cell: any): string => {
      const tag = cell.type === "tableHeader" ? "th" : "td";
      const a = cell.attrs || {};
      const cellParts: string[] = [];
      if ((a.colspan ?? 1) > 1)
        cellParts.push(`colspan="${escapeAttr(a.colspan)}"`);
      if ((a.rowspan ?? 1) > 1)
        cellParts.push(`rowspan="${escapeAttr(a.rowspan)}"`);
      if (a.align) cellParts.push(`align="${escapeAttr(a.align)}"`);
      const open = cellParts.length
        ? `<${tag} ${cellParts.join(" ")}>`
        : `<${tag}>`;
      const inner = (cell.content || [])
        .map((block: any) => blockToHtml(block))
        .join("");
      return `${open}${inner}</${tag}>`;
    };
    const htmlRows = tableRows
      .map(
        (row: any) =>
          `<tr>${(row.content || []).map(renderHtmlCell).join("")}</tr>`,
      )
      .join("");
    return `<table><tbody>${htmlRows}</tbody></table>`;
  };

  // ---------------------------------------------------------------------------
  // #515 inline helpers. `case "text"` used to inline both of these; they are
  // factored out so the code-emphasis run emitter (renderInlineChildren) can
  // reuse the EXACT same escaping and mark-rendering logic when it factors a
  // shared mark out of several adjacent runs. Behaviour is unchanged: the escape
  // gate still runs only for NON-code runs, and the mark switch still wraps the
  // text in the order the marks array lists them (first mark = innermost).
  // ---------------------------------------------------------------------------

  /**
   * Intentional markdown escapes for a NON-code text run. A run carrying the
   * `code` mark must NOT go through here: a code span's content is literal
   * (marked does not decode escapes inside backticks), so `==`, `$…$`, `^[` and
   * `<br>` stay verbatim there.
   */
  const escapeInlineText = (raw: string): string => {
    let textContent = raw;
    // #293 canon #2 (F2): inside a footnote body, DOUBLE every RAW user
    // backslash FIRST, so it survives `^[…]` (the import tokenizer treats
    // `\<char>` as an escape when balancing brackets, and `parseInline`
    // decodes escapes). Doing it before the intentional escapes below keeps
    // the serializer's own single escapes (`\=` `\$` `^\[`, and the `\[`/
    // `\]` balanceBrackets adds) single; only genuine user backslashes are
    // doubled.
    if (inFootnoteBody) {
      textContent = textContent.replace(/\\/g, "\\\\");
    }
    // #293 canon #7: `==` is now a LIVE inline highlight syntax on import (a
    // marked inline extension turns `==text==` into a color-less highlight
    // mark). A LITERAL `==` in a text run would therefore be misparsed as a
    // highlight on the next import, so backslash-escape each `=` of a `==`
    // pair; marked's escape tokenizer decodes `\=` back to a literal `=`, so
    // a literal `==` round-trips as text (never materializes a phantom mark).
    // A highlight run's own `==` delimiters are appended AFTER this by the mark
    // switch, so they are never escaped; only the run's inner text is.
    textContent = textContent.replace(/==/g, "\\=\\=");
    // #293 canon #6: escape a would-be inline-math `$…$` span so it stays
    // literal text on re-import (currency `$5` is left clean — see
    // escapeProseMath).
    textContent = escapeProseMath(textContent);
    // #293 canon #2: `^[` opens a LIVE inline-footnote span on import
    // (`^[text]` -> a footnote reference). A LITERAL `^[` in prose text
    // would therefore materialize a phantom footnote on the next import, so
    // backslash-escape the bracket (`^[` -> `^\[`); marked's escape
    // tokenizer decodes `\[` back to `[`, so a literal `^[…]` round-trips
    // as text and never opens a footnote. Only the OPENING `^[` needs
    // breaking (the tokenizer requires it), so this is a minimal, idempotent
    // escape. A real footnoteReference node emits `^[body]` from its own
    // case, never through here.
    textContent = textContent.replace(/\^\[/g, "^\\[");
    // #554: a LITERAL inline-HTML break tag typed as prose text (`<br>`,
    // `<br/>`, `<br />`, case-insensitive / optional whitespace) would be
    // parsed by marked as an inline-HTML line break on re-import, silently
    // turning the user's literal text into a hardBreak node. HTML-entity-
    // encode only the angle brackets of a break-tag sequence so it lands
    // in the markdown as `&lt;br&gt;`: marked passes the entities through
    // and the importer decodes them back to the literal characters `<br>`,
    // so the run round-trips as text and NEVER materializes a hardBreak.
    // Scoped strictly to the `<br…>` pattern (not every `<`/`>`), so stray
    // angle brackets in ordinary prose (`a < b > c`) are untouched. This
    // is the text-content path ONLY; a real hardBreak node serializes from
    // its own case (`  \n`, or `<br>` via inlineToHtml on the raw-HTML
    // path), so the serializer's own emitted breaks are never escaped.
    textContent = textContent.replace(/<(\s*br\s*\/?\s*)>/gi, "&lt;$1&gt;");
    return textContent;
  };

  /**
   * Wrap already-rendered inline content in ONE mark's markdown (or HTML) form.
   * Called in marks-array order, so the first mark of the array ends up
   * innermost — exactly as the historical in-place loop did.
   */
  const applyInlineMark = (mark: any, inner: string): string => {
    let textContent = inner;
    switch (mark.type) {
      case "bold":
        textContent = `**${textContent}**`;
        break;
      case "italic":
        textContent = `*${textContent}*`;
        break;
      case "code":
        // #515: `code` is applied FIRST (innermost) by the callers, never
        // through this switch — a backtick span must sit INSIDE any emphasis
        // (CommonMark: `**`x`**` is <strong><code>x</code></strong>). Kept as a
        // defensive fallback for any caller that passes the mark through.
        textContent = `\`${textContent}\``;
        break;
      case "link": {
        const href = mark.attrs?.href || "";
        const title = mark.attrs?.title;
        if (title) {
          // Emit the optional markdown link title; escape an embedded
          // double-quote so it cannot terminate the title string early.
          const safeTitle = String(title).replace(/"/g, '\\"');
          textContent = `[${textContent}](${href} "${safeTitle}")`;
        } else {
          textContent = `[${textContent}](${href})`;
        }
        break;
      }
      case "strike":
        textContent = `~~${textContent}~~`;
        break;
      case "underline":
        textContent = `<u>${textContent}</u>`;
        break;
      case "subscript":
        textContent = `<sub>${textContent}</sub>`;
        break;
      case "superscript":
        textContent = `<sup>${textContent}</sup>`;
        break;
      case "highlight": {
        // #293 canon #7: a highlight WITHOUT a color serializes as the
        // Obsidian/GFM `==text==` syntax (the importer's marked inline
        // `==` extension parses it back to a color-less highlight mark).
        // A highlight WITH a color keeps the `<mark style="background-
        // color: …">` HTML form (the condition is deterministic on the
        // `color` attr), so a colored highlight is not flattened. The
        // inner textContent already had any literal `==` backslash-
        // escaped above, so a highlight over text containing `==` still
        // round-trips.
        const color = mark.attrs?.color;
        textContent = color
          ? `<mark style="background-color: ${escapeAttr(color)}">${textContent}</mark>`
          : `==${textContent}==`;
        break;
      }
      case "textStyle":
        if (mark.attrs?.color) {
          textContent = `<span style="color: ${escapeAttr(mark.attrs.color)}">${textContent}</span>`;
        }
        break;
      case "spoiler":
        // Markdown has no native spoiler syntax, so emit the same raw
        // inline HTML the editor-ext/MCP stack uses. The schema's Spoiler
        // mark parses span[data-spoiler] back on import, so the mark
        // survives the PM -> MD -> PM round-trip.
        textContent = `<span data-spoiler="true">${textContent}</span>`;
        break;
      case "comment": {
        // Emit the inline comment anchor so highlights round-trip. The
        // schema's Comment mark parses span[data-comment-id] (attrs
        // commentId/resolved).
        const cid = mark.attrs?.commentId;
        if (cid) {
          // Hide resolved anchors from agent reads: drop the wrapper and
          // keep only the bare text. Active anchors keep their wrapper.
          if (mark.attrs?.resolved && dropResolvedCommentAnchors) {
            break;
          }
          const resolvedAttr = mark.attrs?.resolved
            ? ` data-resolved="true"`
            : "";
          textContent = `<span data-comment-id="${escapeAttr(cid)}"${resolvedAttr}>${textContent}</span>`;
        }
        break;
      }
      default:
        // Unknown mark: no dedicated case, so it has no markdown form and
        // is dropped from the run. Report the loss (throws in strict
        // mode) then leave the text unwrapped — the historical behavior.
        warnLoss("mark", String(mark.type));
        break;
    }
    return textContent;
  };

  const processNode = (node: any): string => {
    if (nodeDepth >= MAX_NODE_DEPTH) {
      // Bail out of deeper recursion without throwing. A text node still has
      // its own content worth keeping; a container at the limit collapses to
      // "" (its already-too-deep subtree is dropped) rather than overflowing.
      return typeof node?.text === "string" ? node.text : "";
    }
    nodeDepth++;
    try {
      return processNodeInner(node);
    } finally {
      nodeDepth--;
    }
  };

  const processNodeInner = (node: any): string => {
    const type = node.type;
    const nodeContent = node.content || [];

    switch (type) {
      case "doc": {
        // #293 canon #2: the `footnotesList` is NOT emitted in markdown — every
        // note body is inlined at its `^[…]` reference. Skip the list entirely
        // (emitting "" would inject a phantom blank gap via the "\n\n" join),
        // then append any ORPHAN definition (one no reference points at) as its
        // own `^[body]` line so its body is never silently lost.
        // F3 (accepted, intentional): on re-import that orphan `^[body]` line
        // becomes a reference + definition (an orphan def gains a ref). This is
        // lossless (the body survives) and byte-stable (it re-exports identically),
        // so it is deliberately not treated as data loss.
        const parts: string[] = [];
        let prevDocType: string | undefined;
        for (const child of nodeContent) {
          if (child?.type === "footnotesList") continue;
          // Keep adjacent same-family sibling lists distinct (see renderBlockChildren).
          if (adjacentListsMerge(prevDocType, child?.type)) {
            parts.push(LIST_MARKER_SEPARATOR);
          }
          parts.push(processNode(child));
          prevDocType = child?.type;
        }
        for (const [id, def] of footnoteDefs) {
          if (!referencedFootnoteIds.has(id)) {
            parts.push(`^[${renderFootnoteBody(def)}]`);
          }
        }
        return parts.join("\n\n");
      }

      case "paragraph": {
        // Escape a leading block trigger on EVERY line of the paragraph, not
        // just the first: a hardBreak serializes as `  \n`, so a `#`/`-`/`>`/
        // `1.`/`|`/fence/`---` at the start of a CONTINUATION line would also
        // re-parse into another block on the next import (a heading/list/table/
        // setext-`---`), and for the text-less thematic/setext case would LOSE
        // that line's text entirely. Escaping each `\n`-separated line closes
        // the class for multi-line paragraphs too.
        const text = renderInlineChildren(nodeContent)
          .split("\n")
          .map(escapeLeadingBlockTrigger)
          .join("\n");
        const align = node.attrs?.textAlign;
        // Non-default alignment round-trips as an ATTACHED HTML comment at the
        // END of the block line (#293 canon #9):
        //   `some text <!--attrs {"textAlign":"center"}-->`
        // This replaces the old `<p style="text-align:…">` wrapper (review #10,
        // itself a replacement for the never-parsed `<div align>`). The schema's
        // textAlign default is `null`; "left" is the visual default the editor
        // renders identically to null — neither emits a marker (no churn). The
        // importer's applyAttachedComments step reads the comment back before the
        // DOM stage drops it. We only attach when there is text to attach to: a
        // lone comment on a blank line has no block to bind to on re-import.
        if (align && align !== "left" && text) {
          return `${text} ${attachedCommentFor("attrs", { textAlign: align })}`;
        }
        return text || "";
      }

      case "heading": {
        const level = node.attrs?.level || 1;
        const headingText = renderInlineChildren(nodeContent);
        const headingLine = "#".repeat(level) + " " + headingText;
        const headingAlign = node.attrs?.textAlign;
        // A non-default heading alignment attaches the same trailing comment
        // (#293 canon #9), keeping the readable `## text` markdown form:
        //   `## Title <!--attrs {"textAlign":"center"}-->`
        // Bare `## text` carries no alignment, so without this an aligned heading
        // would silently drop textAlign on export. Replaces the old
        // `<hN style="text-align:…">` HTML form. "left"/null stay bare (no churn).
        // Require headingText so an empty aligned heading stays bare `##` rather
        // than emitting a comment with no visible element to attach to (matches
        // the paragraph guard's `text` check — a lone comment has no block to
        // bind on re-import).
        if (headingAlign && headingAlign !== "left" && headingText) {
          return `${headingLine} ${attachedCommentFor("attrs", { textAlign: headingAlign })}`;
        }
        return headingLine;
      }

      case "text": {
        const marks: any[] = node.marks || [];
        // #515: a run may now carry `code` TOGETHER with other marks (the schema's
        // `code` mark no longer declares `excludes: "_"`, matching CommonMark:
        // ``**`x`**`` is <strong><code>x</code></strong>). Serialize `code` FIRST
        // so the backtick span is the INNERMOST wrapper, then apply the remaining
        // marks in the SAME array order as before — so a run WITHOUT `code` is
        // byte-identical to the historical output.
        const hasCode = marks.some((m: any) => m.type === "code");
        // The escape gate stays scoped to NON-code runs: a code span's content is
        // literal (`==`, `$…$`, `^[`, `<br>` are not re-parsed inside backticks),
        // so escaping it would permanently stamp backslashes into the code.
        let textContent = hasCode
          ? node.text || ""
          : escapeInlineText(node.text || "");
        if (hasCode) {
          textContent = `\`${textContent}\``;
        }
        // Apply the remaining marks (bold, italic, link, …), `code` already done.
        for (const mark of marks) {
          if (mark.type === "code") continue;
          textContent = applyInlineMark(mark, textContent);
        }
        return textContent;
      }

      case "codeBlock":
        const language = node.attrs?.language || "";
        // Strip ALL trailing newlines so the export is idempotent: marked
        // re-adds exactly one trailing "\n" on import, so trimming only one
        // here would let the text grow by "\n" on each round-trip. Removing
        // every trailing newline makes repeated cycles stable.
        //
        // Read the child text RAW (schema codeBlock is `content: "text*"`), NOT
        // through processNode: code-fence content is literal and markdown escapes
        // do not apply inside a fence. In particular the canon #7 `==` -> `\=\=`
        // escape (in `case "text"`) must NOT reach code — marked leaves `\=`
        // verbatim inside a fence, so routing code through `case "text"` would
        // permanently stamp backslashes into any `==` (a `==` comparison is
        // extremely common in source), corrupting the block on the git-sync data
        // path.
        const code = nodeContent
          .map((child: any) => (typeof child?.text === "string" ? child.text : ""))
          .join("")
          .replace(/\n+$/, "");
        // CommonMark: an inner ``` run inside the code would prematurely close
        // a 3-backtick fence (corrupting the block on re-import). Use an outer
        // fence one backtick longer than the longest backtick run in the code
        // (minimum 3) so the inner fence is always content.
        const longestBacktickRun = (code.match(/`+/g) || []).reduce(
          (max: number, run: string) => Math.max(max, run.length),
          0,
        );
        const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
        return fence + language + "\n" + code + "\n" + fence;

      case "bulletList":
        return nodeContent
          .map((item: any) => processListItem(item, "-"))
          .join("\n");

      case "orderedList": {
        // Honor a non-1 `start`: CommonMark expresses it as the first marker
        // ("5." starts the list at 5), and marked parses that back into
        // <ol start="5">. Emitting `${start + index}.` keeps a start=5 list as
        // "5.","6.",… while a default (start=1) list stays "1.","2.",… See #351.
        // Only an INTEGER ≥ 2 is a valid explicit start; collapse everything else
        // (absent, non-number, 0, negative, fractional) to 1. A negative/fractional
        // start would otherwise emit an untokenizable marker (e.g. "-3.", "2.5.")
        // that marked cannot parse, re-importing the whole list as a PARAGRAPH.
        const raw = node.attrs?.start;
        const start = Number.isInteger(raw) && (raw as number) > 1 ? (raw as number) : 1;
        return nodeContent
          .map((item: any, index: number) =>
            processListItem(item, `${start + index}.`),
          )
          .join("\n");
      }

      case "taskList":
        return nodeContent.map((item: any) => processTaskItem(item)).join("\n");

      case "taskItem":
        // Delegate to the same helper used by taskList so multi-block and
        // nested task items render and indent consistently.
        return processTaskItem(node);

      case "listItem":
        // Direct-listItem path (lists normally render via processListItem, which
        // handles the marker + indentation). Blank line between block children so
        // multiple paragraphs do not merge on re-parse; a `<!-- -->` entry
        // (renderBlockChildren) separates adjacent sibling lists.
        return renderBlockChildren(nodeContent, processNode).join("\n\n");

      case "blockquote": {
        // Prefix EVERY line of EVERY child with "> " and separate block-level
        // children with a blank ">" line so code blocks / multi-paragraph
        // quotes round-trip correctly. A `> <!-- -->` separator line is inserted
        // between two adjacent same-family sibling lists (renderBlockChildren)
        // so they stay distinct inside the quote.
        const bqParts: string[] = [];
        let prevBqType: string | undefined;
        for (const n of nodeContent) {
          if (adjacentListsMerge(prevBqType, n?.type)) {
            bqParts.push(`> ${LIST_MARKER_SEPARATOR}`);
          }
          bqParts.push(
            processNode(n)
              .split("\n")
              .map((line: string) => (line.length ? `> ${line}` : ">"))
              .join("\n"),
          );
          prevBqType = n?.type;
        }
        return bqParts.join("\n>\n");
      }

      case "horizontalRule":
        return "---";

      case "hardBreak":
        // Two trailing spaces before the newline encode a markdown hard break;
        // a bare "\n" would be reimported as a soft break and lost.
        return "  \n";

      case "image": {
        const imgAttrs = node.attrs || {};
        // #293 canon #4: a top-level image ALWAYS serializes as `![alt](src)`.
        // Non-default layout/identity attrs (which markdown `![](src)` cannot
        // express — width/height/align/size/attachmentId/aspectRatio/caption/
        // title) are carried in an attached `<!--img {…}-->` comment on the SAME
        // line, materialized back onto the <img> by markdown-to-prosemirror's
        // applyCommentDirectives before generateJSON drops the comment.
        // Escape the alt text: it sits in the `![alt]` label, which the importer
        // re-parses as CommonMark inline content, so a markdown-active char in a
        // realistic description ("Figure [1]", "the *new* logo") would break the
        // round-trip — the image node vanishes / emphasis collapses. Same reason
        // the link-form media (attachment/pdf/embed) escape their visible text.
        const imgAlt = escapeLinkText(imgAttrs.alt ?? "");
        // Neutralize characters that could break out of the markdown image
        // URL: spaces/newlines and parentheses would terminate the (...) target
        // and let a stored src inject following markdown/HTML. Percent-encode
        // them so the URL stays a single inert token.
        const imgSrc = encodeMdUrl(imgAttrs.src);
        const base = `![${imgAlt}](${imgSrc})`;
        // Build the img-comment JSON from the NON-DEFAULT attrs only, in a
        // STABLE key order so the output is deterministic. An attr equal to its
        // schema default is NOT emitted (predicate over the canonicalized attrs).
        const json: Record<string, unknown> = {};
        // Numeric sizing attrs are coerced to string in the payload: the import
        // side (applyCommentDirectives) writes them as DOM attributes and the
        // schema's parseHTML reads them back as strings, so a numeric value would
        // otherwise round-trip as `420 -> "420"` and produce a one-time spurious
        // git diff. Emitting the string form up front keeps the round-trip
        // byte-stable whether the source attr was a number or a string (mirrors
        // the legacy imageToHtml, which stringified via `width="…"`).
        if (imgAttrs.width != null) json.width = String(imgAttrs.width);
        if (imgAttrs.height != null) json.height = String(imgAttrs.height);
        // align default is unified to "center" (#293 canon #4): treat BOTH null
        // and "center" as the default and omit them, so a bare/center image stays
        // clean `![](src)` and only left/right emits `"align"`.
        if (imgAttrs.align != null && imgAttrs.align !== "center")
          json.align = imgAttrs.align;
        if (imgAttrs.size != null) json.size = String(imgAttrs.size);
        if (imgAttrs.aspectRatio != null)
          json.aspectRatio = String(imgAttrs.aspectRatio);
        if (imgAttrs.attachmentId) json.attachmentId = imgAttrs.attachmentId;
        if (imgAttrs.caption) json.caption = imgAttrs.caption;
        if (imgAttrs.title) json.title = imgAttrs.title;
        // No non-default attrs -> bare image, no trailing space, no comment.
        if (Object.keys(json).length === 0) return base;
        // attachedCommentFor defuses any `--` in a value (e.g. a caption that
        // contains the comment-closing `-->`) so the payload can never close the
        // HTML comment early; JSON.parse on the import side restores it verbatim.
        return `${base} ${attachedCommentFor("img", json)}`;
      }

      case "video": {
        // #293 canon #8 (image-form): a top-level video serializes as
        // `![](src)<!--video {…}-->`. The bare `![](src)` is ALWAYS followed by
        // the `video` discriminator comment — a bare image with NO comment is an
        // `image`, never sniffed by URL — so the comment is REQUIRED even when
        // there are no extra attrs (emitted name-only as `<!--video-->`). src
        // lives in the markdown target; every OTHER non-default attr rides in the
        // comment JSON (stable key order, numerics stringified for byte-stability
        // exactly like canon #4). align default "center" is omitted. The schema
        // `<div><video>` form is still emitted on the raw-HTML path (blockToHtml)
        // via videoToHtml, since comment nodes are dropped inside columns/cells.
        const attrs = node.attrs || {};
        const src = encodeMdUrl(attrs.src);
        const json: Record<string, unknown> = {};
        if (attrs.alt) json.alt = attrs.alt;
        if (attrs.attachmentId) json.attachmentId = attrs.attachmentId;
        if (attrs.width != null) json.width = String(attrs.width);
        if (attrs.height != null) json.height = String(attrs.height);
        if (attrs.size != null) json.size = String(attrs.size);
        if (attrs.align != null && attrs.align !== "center")
          json.align = attrs.align;
        if (attrs.aspectRatio != null)
          json.aspectRatio = String(attrs.aspectRatio);
        return `![](${src})${standaloneCommentFor("video", json)}`;
      }

      case "youtube": {
        // #293 canon #8 (image-form): `![](url)<!--youtube {…}-->`. Same rules as
        // video — src in the target, other non-default attrs (width/height/align,
        // align!=center) in the ALWAYS-emitted discriminator comment. The
        // div[data-type="youtube"] form stays on the raw-HTML path (youtubeToHtml).
        const attrs = node.attrs || {};
        const src = encodeMdUrl(attrs.src);
        const json: Record<string, unknown> = {};
        if (attrs.width != null) json.width = String(attrs.width);
        if (attrs.height != null) json.height = String(attrs.height);
        if (attrs.align != null && attrs.align !== "center")
          json.align = attrs.align;
        return `![](${src})${standaloneCommentFor("youtube", json)}`;
      }

      case "table": {
        // A GFM pipe table cannot represent merged cells. If ANY cell carries
        // colspan>1 or rowspan>1, a pipe table would corrupt the grid on
        // re-import, so emit the WHOLE table as raw HTML <table> instead: the
        // schema's table family parseHTML (tag table/tr/td/th, with colspan/
        // rowspan read from the same-named HTML attrs and align via parseHTML)
        // round-trips it faithfully. Otherwise keep the lighter GFM pipe table.
        const tableRows: any[] = nodeContent;
        if (tableRows.length === 0) return "";
        const hasSpan = tableRows.some((row: any) =>
          (row.content || []).some(
            (cell: any) =>
              (cell.attrs?.colspan ?? 1) > 1 || (cell.attrs?.rowspan ?? 1) > 1,
          ),
        );
        // A GFM pipe table also cannot hold a cell with block content (a list,
        // code block, paragraphs) — it would be flattened to one line and lost
        // (review #8). Force the HTML form for those too.
        const hasMultiBlockCell = tableRows.some((row: any) =>
          (row.content || []).some((cell: any) => cellIsMultiBlock(cell)),
        );

        if (hasSpan || hasMultiBlockCell) {
          return tableToHtml(tableRows);
        }

        // No merged cells: emit a GFM table (header row + separator) so the
        // markdown can be parsed back into a table on re-import.
        const rows = tableRows.map(processNode);
        const headerCells = tableRows[0]?.content || [];
        const columns = headerCells.length || 1;
        // Derive alignment markers (:--, :-:, --:) from each header cell.
        const markers = Array.from({ length: columns }, (_, i) => {
          const align = headerCells[i]?.attrs?.align;
          switch (align) {
            case "left":
              return ":--";
            case "center":
              return ":-:";
            case "right":
              return "--:";
            default:
              return "---";
          }
        });
        const separator = "| " + markers.join(" | ") + " |";
        return [rows[0], separator, ...rows.slice(1)].join("\n");
      }

      case "tableRow":
        return "| " + nodeContent.map(processNode).join(" | ") + " |";

      case "tableCell":
      case "tableHeader": {
        // Join multiple block children with a space (not "") so adjacent blocks
        // like a paragraph followed by a list don't collide into "line1- a".
        // Then collapse newlines and escape pipes so a cell containing "|" or a
        // line break cannot corrupt the surrounding GFM row.
        // #549: a GFM pipe cell is single-line — the generic `  \n`/newline
        // collapse below flattens a hardBreak into a space, dropping it. Convert
        // the two-space hardBreak marker to `<br>` FIRST (GFM cells allow inline
        // `<br>`, which re-imports to a hardBreak) so intra-cell breaks survive.
        return nodeContent
          .map(processNode)
          .join(" ")
          .replace(/ {2}\n/g, "<br>")
          .replace(/\r?\n/g, " ")
          .replace(/\|/g, "\\|");
      }

      case "callout": {
        // Obsidian-native callout: `> [!type]` opener + a blockquote (`>`-prefixed)
        // body, so it renders as a callout in Obsidian. The importer parses both
        // this and the legacy `:::type` fence (existing vaults). Each body line is
        // blockquote-prefixed; a blank line becomes a bare `>` so the callout is
        // not split.
        const calloutType = (node.attrs?.type || "info").toLowerCase();
        const calloutBody = renderBlockChildren(nodeContent, processNode)
          // Blank line between block children (rendered as a bare `>` after the
          // prefix pass below) so multiple paragraphs stay separate nodes instead
          // of merging on re-parse — same rule blockquote already uses. A
          // `<!-- -->` entry (renderBlockChildren) separates adjacent sibling lists.
          .join("\n\n")
          .split("\n")
          .map((l: string) => (l.length ? `> ${l}` : ">"))
          .join("\n");
        return `> [!${calloutType}]\n${calloutBody}`;
      }

      case "details": {
        // The `open` (collapsed/expanded) state lives on the details node, NOT on
        // the summary, so emit the <details> wrapper HERE carrying it — otherwise
        // the open state is dropped on a round trip. The schema's details node
        // parses `open` back from the attribute.
        const open = node.attrs?.open ? " open" : "";
        return `<details${open}>\n${nodeContent.map(processNode).join("")}</details>`;
      }

      case "detailsSummary":
        return `<summary>${renderInlineChildren(nodeContent)}</summary>\n\n`;

      case "detailsContent":
        // Blank line between block children so multiple paragraphs in a details
        // body survive as separate nodes (a single "\n" merges them on re-parse);
        // a `<!-- -->` entry (renderBlockChildren) separates adjacent sibling lists.
        return `${renderBlockChildren(nodeContent, processNode).join("\n\n")}\n`;

      case "mathInline": {
        // #293 canon #6: inline math serializes as Obsidian-native `$LaTeX$`
        // (readable, re-parsed by the importer's marked inline extension). A
        // literal `$` inside the LaTeX is escaped `\$` so it cannot close the
        // span early (the importer decodes `\$`→`$`). When the LaTeX cannot be
        // safely fenced (empty, whitespace-edged, multi-line, or an ambiguous
        // backslash-before-`$`), fall back to the LOSSLESS schema-HTML `<span>`
        // form (inlineMathSerializable). A following-sibling digit — which would
        // also break the pandoc closing rule — is handled by renderInlineChildren
        // (this case cannot see siblings).
        const inlineMath = node.attrs?.text || "";
        if (!inlineMathSerializable(inlineMath)) {
          return mathInlineHtml(inlineMath);
        }
        return `$${encodeInlineMathLatex(inlineMath)}$`;
      }

      case "mathBlock": {
        // #293 canon #6: block math serializes as a `$$` fence on its own lines
        // (`$$\n<latex>\n$$`), so multi-line LaTeX is preserved. If the LaTeX
        // itself contains a `$$` (which would close the fence early — essentially
        // never valid inside a single math node), fall back to the lossless
        // schema-HTML `<div>` form.
        const blockMath = node.attrs?.text || "";
        if (blockMath.includes("$$")) {
          return mathBlockHtml(blockMath);
        }
        return `$$\n${blockMath}\n$$`;
      }

      case "mention": {
        // Emit span[data-type="mention"] with the schema's data-* attributes so
        // generateJSON rebuilds the mention node instead of leaving "@label"
        // plain text that cannot re-parse.
        const attrs = node.attrs || {};
        const parts: string[] = [`data-type="mention"`];
        if (attrs.id) parts.push(`data-id="${escapeAttr(attrs.id)}"`);
        if (attrs.label)
          parts.push(`data-label="${escapeAttr(attrs.label)}"`);
        if (attrs.entityType)
          parts.push(`data-entity-type="${escapeAttr(attrs.entityType)}"`);
        if (attrs.entityId)
          parts.push(`data-entity-id="${escapeAttr(attrs.entityId)}"`);
        if (attrs.slugId)
          parts.push(`data-slug-id="${escapeAttr(attrs.slugId)}"`);
        if (attrs.creatorId)
          parts.push(`data-creator-id="${escapeAttr(attrs.creatorId)}"`);
        if (attrs.anchorId)
          parts.push(`data-anchor-id="${escapeAttr(attrs.anchorId)}"`);
        // Keep the label as visible text content too; the schema reads attrs
        // from data-*, so the inner text is purely cosmetic and harmless.
        const mentionLabel = attrs.label || attrs.id || "";
        // The label is visible element TEXT content here (the data-* attrs above
        // carry the real values), so escape it for the text context, not attrs.
        return `<span ${parts.join(" ")}>@${escapeHtmlText(mentionLabel)}</span>`;
      }

      case "attachment": {
        // #293 canon #8 (link-form): `[filename](src)<!--attachment {…}-->`. The
        // schema's `url` is the markdown target; the VISIBLE text is the filename
        // (`attrs.name`, escaped so `[`/`]` cannot break the label). Every OTHER
        // non-default attr (mime/size/attachmentId) rides in the ALWAYS-emitted
        // discriminator comment — a bare `[text](src)` with no comment is a plain
        // link, never an attachment. The div[data-type="attachment"] form stays
        // on the raw-HTML path (attachmentToHtml) for columns/cells.
        const attrs = node.attrs || {};
        const src = encodeMdUrl(attrs.url);
        const text = escapeLinkText(attrs.name ?? "");
        const json: Record<string, unknown> = {};
        if (attrs.mime) json.mime = attrs.mime;
        if (attrs.size != null) json.size = String(attrs.size);
        if (attrs.attachmentId) json.attachmentId = attrs.attachmentId;
        return `[${text}](${src})${standaloneCommentFor("attachment", json)}`;
      }

      case "drawio":
      case "excalidraw": {
        // #293 canon #8 (image-form): `![](src)<!--drawio|excalidraw {…}-->`. src
        // in the target; title/alt/width/height/size/aspectRatio/align(!=center)/
        // attachmentId in the ALWAYS-emitted discriminator comment (the NAME
        // selects drawio vs excalidraw). The div[data-type=…] form stays on the
        // raw-HTML path (diagramToHtml).
        const attrs = node.attrs || {};
        const src = encodeMdUrl(attrs.src);
        const json: Record<string, unknown> = {};
        if (attrs.title != null) json.title = attrs.title;
        if (attrs.alt != null) json.alt = attrs.alt;
        if (attrs.width != null) json.width = String(attrs.width);
        if (attrs.height != null) json.height = String(attrs.height);
        if (attrs.size != null) json.size = String(attrs.size);
        if (attrs.aspectRatio != null)
          json.aspectRatio = String(attrs.aspectRatio);
        if (attrs.align != null && attrs.align !== "center")
          json.align = attrs.align;
        if (attrs.attachmentId) json.attachmentId = attrs.attachmentId;
        return `![](${src})${standaloneCommentFor(type, json)}`;
      }

      case "embed": {
        // #293 canon #8 (link-form): `[provider](src)<!--embed {…}-->`. src in
        // the target; the VISIBLE text is the provider (`attrs.provider`). align/
        // width/height ride in the discriminator comment only when non-default
        // (align "center", width 800, height 600 are the schema defaults). The
        // div[data-type="embed"] form stays on the raw-HTML path (embedToHtml).
        const attrs = node.attrs || {};
        const src = encodeMdUrl(attrs.src);
        const text = escapeLinkText(attrs.provider ?? "");
        const json: Record<string, unknown> = {};
        if (attrs.align != null && attrs.align !== "center")
          json.align = attrs.align;
        if (attrs.width != null && attrs.width !== 800)
          json.width = String(attrs.width);
        if (attrs.height != null && attrs.height !== 600)
          json.height = String(attrs.height);
        return `[${text}](${src})${standaloneCommentFor("embed", json)}`;
      }

      case "audio": {
        // #293 canon #8 (image-form): `![](src)<!--audio {…}-->`. src in the
        // target; attachmentId/size in the ALWAYS-emitted discriminator comment.
        // The <div><audio> form stays on the raw-HTML path (audioToHtml).
        const attrs = node.attrs || {};
        const src = encodeMdUrl(attrs.src);
        const json: Record<string, unknown> = {};
        if (attrs.attachmentId) json.attachmentId = attrs.attachmentId;
        if (attrs.size != null) json.size = String(attrs.size);
        return `![](${src})${standaloneCommentFor("audio", json)}`;
      }

      case "pdf": {
        // #293 canon #8 (link-form): `[filename](src)<!--pdf {…}-->`. src in the
        // target; the VISIBLE text is the filename (`attrs.name`). attachmentId/
        // size/width/height ride in the ALWAYS-emitted discriminator comment. The
        // div[data-type="pdf"] form stays on the raw-HTML path (pdfToHtml).
        const attrs = node.attrs || {};
        const src = encodeMdUrl(attrs.src);
        const text = escapeLinkText(attrs.name ?? "");
        const json: Record<string, unknown> = {};
        if (attrs.attachmentId) json.attachmentId = attrs.attachmentId;
        if (attrs.size != null) json.size = String(attrs.size);
        if (attrs.width != null) json.width = String(attrs.width);
        if (attrs.height != null) json.height = String(attrs.height);
        return `[${text}](${src})${standaloneCommentFor("pdf", json)}`;
      }

      case "columns": {
        // Emit the schema-matching div[data-type="columns"] wrapper so the
        // multi-column layout survives. Without a case the children were
        // concatenated with no separator and the text merged. The schema reads
        // layout from data-layout and widthMode from data-width-mode. The whole
        // block is raw HTML, so render children via blockToHtml (NOT markdown,
        // which marked would not re-parse inside a raw HTML block).
        const attrs = node.attrs || {};
        const parts: string[] = [`data-type="columns"`];
        if (attrs.layout)
          parts.push(`data-layout="${escapeAttr(attrs.layout)}"`);
        if (attrs.widthMode && attrs.widthMode !== "normal")
          parts.push(`data-width-mode="${escapeAttr(attrs.widthMode)}"`);
        const inner = nodeContent.map((n: any) => blockToHtml(n)).join("");
        return `<div ${parts.join(" ")}>${inner}</div>`;
      }

      case "column": {
        // Emit the schema-matching div[data-type="column"]; the schema reads the
        // column width from data-width. Children are rendered as HTML so their
        // formatting survives inside this raw HTML block.
        const attrs = node.attrs || {};
        const parts: string[] = [`data-type="column"`];
        if (attrs.width)
          parts.push(`data-width="${escapeAttr(attrs.width)}"`);
        const inner = nodeContent.map((n: any) => blockToHtml(n)).join("");
        return `<div ${parts.join(" ")}>${inner}</div>`;
      }

      case "pageBreak":
        // #293 canon #5: a pageBreak is a STANDALONE machinery comment on its
        // own line — `<!--pagebreak-->` — which is invisible in any markdown
        // renderer yet round-trips (the importer materializes it back into the
        // pageBreak atom; see markdown-to-prosemirror's applyCommentDirectives).
        // This keeps the markdown readable instead of leaking a raw <div>. The
        // schema div-form is still emitted on the raw-HTML path (blockToHtml),
        // because DOM parsers drop comment nodes inside columns/cells.
        return standaloneCommentFor("pagebreak");

      case "subpages":
        // #293 canon #5: a subpages block serializes as a STANDALONE comment —
        // `<!--subpages-->` by default, or `<!--subpages {"recursive":true}-->`
        // when the recursive toggle is set. Same rationale as pageBreak: readable
        // markdown, invisible in renderers, re-materialized on import. The div
        // form (`<div data-type="subpages">`) is retained on the raw-HTML path
        // (blockToHtml) since comments cannot survive a DOM parse inside columns.
        return node.attrs?.recursive
          ? standaloneCommentFor("subpages", { recursive: true })
          : standaloneCommentFor("subpages");

      case "status": {
        // Inline status pill. The schema reads the label from the element's
        // TEXT content and the color from data-color, so emit both; without a
        // case this inline atom fell through to `default` and collapsed to "".
        const attrs = node.attrs || {};
        const statusColor = attrs.color || "gray";
        return `<span data-type="status" data-color="${escapeAttr(statusColor)}">${escapeHtmlText(attrs.text ?? "")}</span>`;
      }

      case "htmlEmbed": {
        // Block atom; the schema reads the raw source from a base64-encoded
        // data-source attribute (and an optional fixed height from data-height).
        // Encode with the shared helper so it decodes symmetrically on import.
        const attrs = node.attrs || {};
        const parts: string[] = [
          `data-type="htmlEmbed"`,
          `data-source="${escapeAttr(encodeHtmlEmbedSource(attrs.source ?? ""))}"`,
        ];
        if (attrs.height != null)
          parts.push(`data-height="${escapeAttr(attrs.height)}"`);
        return `<div ${parts.join(" ")}></div>`;
      }

      case "footnoteReference": {
        // #293 canon #2: on the top-level/inline markdown path a footnote is
        // written AT its reference as `^[body]` (Pandoc/Obsidian inline
        // footnote). Look the body up by id in the pre-scanned definitions map
        // and render it inline. An ORPHAN reference (no matching definition) has
        // no body anywhere, so it emits `^[]` — a footnote with an empty body,
        // the lossless choice (the id was already derived, never authored). The
        // separate `<section data-footnotes>` list is NOT emitted (see the
        // footnotesList/doc cases); the raw-HTML path carries the body on the
        // <sup> instead (inlineToHtml).
        const def = footnoteDefs.get(node.attrs?.id);
        return `^[${def ? renderFootnoteBody(def) : ""}]`;
      }

      case "footnotesList":
        // Bodies are inlined at their references (`^[…]`), so the bottom list
        // emits NOTHING in markdown. The doc case skips it outright to avoid a
        // phantom blank line; this case guards any non-doc-level occurrence.
        return "";

      case "footnoteDefinition":
        // Reached only via a footnotesList (handled above) — never rendered on
        // its own on the markdown path; its body rides at the reference.
        return "";

      case "pageEmbed": {
        // #293 canon #8 (standalone): a whole-page live embed serializes as a
        // lone discriminator comment on its own line — `<!--pageembed-->` or
        // `<!--pageembed {"sourcePageId":…}-->`. Readable markdown, invisible in
        // renderers, re-materialized on import. The div[data-type="pageEmbed"]
        // form stays on the raw-HTML path (pageEmbedToHtml) for columns/cells.
        const attrs = node.attrs || {};
        const json: Record<string, unknown> = {};
        if (attrs.sourcePageId) json.sourcePageId = attrs.sourcePageId;
        return standaloneCommentFor("pageembed", json);
      }

      case "transclusionReference": {
        // #293 canon #8 (standalone): a live block/page reference serializes as a
        // lone `<!--transclusion {…}-->` comment carrying sourcePageId +
        // transclusionId (the data-loss-critical id links). The
        // div[data-type="transclusionReference"] form stays on the raw-HTML path
        // (transclusionReferenceToHtml). (transclusionSource is unchanged — it has
        // block children and keeps recursing through processNode.)
        const attrs = node.attrs || {};
        const json: Record<string, unknown> = {};
        if (attrs.sourcePageId) json.sourcePageId = attrs.sourcePageId;
        if (attrs.transclusionId) json.transclusionId = attrs.transclusionId;
        return standaloneCommentFor("transclusion", json);
      }

      case "transclusionSource": {
        // Sync-source container; the schema reads data-id and re-parses its
        // block children, so render them as schema-matching HTML.
        const attrs = node.attrs || {};
        const idAttr = attrs.id ? ` data-id="${escapeAttr(attrs.id)}"` : "";
        const inner = nodeContent.map((n: any) => blockToHtml(n)).join("");
        return `<div data-type="transclusionSource"${idAttr}>${inner}</div>`;
      }

      default:
        // Unknown node type: no dedicated case, so the node's identity + attrs
        // have no lossless markdown form. Report the loss (throws in strict
        // mode) then degrade by flattening to its children — the historical
        // graceful fallback.
        warnLoss("node", String(type));
        return nodeContent.map(processNode).join("");
    }
  };

  // ---------------------------------------------------------------------------
  // #515 code-emphasis runs.
  //
  // Now that the schema's `code` mark no longer excludes the other inline marks,
  // ADJACENT text runs can share an outer emphasis mark with an inline code span
  // (CommonMark: ``**`aaa` + `bbb`**`` is <strong><code>aaa</code> + <code>bbb
  // </code></strong>, i.e. three sibling runs all carrying `bold`). Rendering
  // those runs INDEPENDENTLY would close and re-open the `**` delimiters around
  // every span (`` `aaa`** + **`bbb` ``) — the dangling-delimiter corruption from
  // the bug report. So a bounded coalescing pass factors a SHARED emphasis out of
  // such a run once.
  //
  // The pass is deliberately narrow (data-loss-critical git-sync path): it only
  // ever touches a maximal run of CONSECUTIVE text nodes that is SEEDED by a node
  // carrying `code` TOGETHER WITH a bare-delimiter emphasis mark — the ONLY shape
  // #515 newly made expressible, and the only one where an emphasis delimiter can
  // end up glued to a backtick. A plain `` `code` `` span next to an emphasized
  // neighbour (`` **bold**`c` ``) was always legal, always round-tripped as
  // markdown, and is left completely untouched (no seed => no run => the exact
  // pre-#515 bytes). From a genuine seed the run only pulls in an
  // IMMEDIATELY adjacent text node whose
  // emphasis mark emits a BARE delimiter (`**` / `*` / `~~` / `==`) — those are
  // exactly the delimiters that COLLIDE with a neighbouring span's delimiters
  // (`` **`a`***b* `` re-imports as literal `**`). Neighbours that render as
  // HTML/bracket forms (underline, sub/sup, spoiler, comment, textStyle, colored
  // highlight, link) have self-delimiting boundaries and are NOT pulled in, so the
  // ordinary ``pre **`code`** post`` case stays clean markdown. Non-text inline
  // nodes (mathInline, mention, status, footnoteReference, hardBreak) render via
  // processNode as before and BREAK any run.
  // ---------------------------------------------------------------------------

  /** Marks whose markdown form is a bare, collidable delimiter. */
  const isBareDelimiterMark = (m: any): boolean =>
    m.type === "bold" ||
    m.type === "italic" ||
    m.type === "strike" ||
    (m.type === "highlight" && !m.attrs?.color);

  const hasCodeMark = (n: any): boolean =>
    (n?.marks || []).some((m: any) => m.type === "code");

  const nonCodeMarks = (n: any): any[] =>
    (n?.marks || []).filter((m: any) => m.type !== "code");

  /**
   * SEED of a code-emphasis run. A delimiter collision is only POSSIBLE when the
   * CODE node ITSELF carries a bare-delimiter emphasis mark: that is the only way
   * an emphasis delimiter ends up glued to a backtick (`` **`x`** ``). A code node
   * with NO emphasis mark (plain `` `x` ``) has ALWAYS been representable next to
   * any emphasized neighbour — the old `excludes: "_"` forbade code+mark on the
   * SAME node, never on ADJACENT nodes — and those constructs (`` **bold**`c` ``,
   * `` `c`**bold** ``, `` **a**`c`**b** ``) are valid CommonMark that re-imports
   * losslessly. So an un-emphasized code node is NOT a seed and never starts a
   * run: it keeps serializing through `case "text"` byte-for-byte as before, and
   * the pre-#515 markdown in the git-sync repo does not degrade to HTML.
   */
  const isRunSeed = (n: any): boolean =>
    n?.type === "text" &&
    hasCodeMark(n) &&
    (n.marks || []).some(isBareDelimiterMark);

  /**
   * A text node that may EXTEND a run that a seed has already started. Broader
   * than the seed rule on purpose: once a genuine collision exists, an adjacent
   * bare-delimiter neighbour (`` **`a`***b* ``) or an adjacent plain code span
   * (`` **`a`**`b` ``) participates in the delimiter re-pairing and must be
   * folded into the same emission decision.
   */
  const isRunMember = (n: any): boolean =>
    n?.type === "text" &&
    (hasCodeMark(n) || (n.marks || []).some(isBareDelimiterMark));

  /**
   * Stable identity of a mark: its type PLUS its FULL attrs, deeply compared
   * (for `link` that is every attr — class/href/internal/rel/target/title — not
   * just href/title, so two links that differ in any attr are NOT factored into
   * one shared wrapper).
   */
  const markIdentity = (m: any): string => {
    const attrs = m?.attrs && typeof m.attrs === "object" ? m.attrs : {};
    const keys = Object.keys(attrs)
      .filter((k) => attrs[k] !== undefined)
      .sort();
    return JSON.stringify([m?.type, keys.map((k) => [k, attrs[k]])]);
  };

  /** Identity of a node's NON-code mark SET (order-insensitive). */
  const nonCodeMarkSetIdentity = (n: any): string =>
    nonCodeMarks(n).map(markIdentity).sort().join("|");

  /**
   * Is `c` (a SINGLE code point, or "" at the edge of the inline content) a
   * character next to which an emphasis delimiter glued to a backtick still
   * flanks — i.e. a character the IMPORTER counts as whitespace-or-punctuation?
   *
   * The rule is stated EXPLICITLY against the importer's own definition rather
   * than inferred: marked's emphasis tokenizer classifies a character with
   * `punctSpace = /[\s\p{P}\p{S}]/u` (CommonMark 0.31's "Unicode whitespace or
   * punctuation", where punctuation includes the SYMBOL categories). Anything
   * outside that class — a letter, a digit, but ALSO a combining mark (U+0301),
   * a format character (ZWJ, SOFT HYPHEN) — is a word character to marked, so a
   * `**` opener sitting between it and a backtick is NOT left-flanking and the
   * emphasis is dropped on re-import. An earlier `!/[\p{L}\p{N}]/u` formulation
   * called those non-letter/non-digit characters BOUNDARIES and silently lost the
   * mark (byte-stably, so the round-trip property could not see it).
   *
   * ASTRAL code points are treated as WORD characters (never a boundary), i.e.
   * conservatively pushed to the lossless HTML fallback, EVEN when their Unicode
   * category says "symbol" (emoji). marked inspects the preceding character with
   * a UTF-16 `.slice(-1)`, so it tests a lone LOW SURROGATE — which matches
   * neither `\s` nor `\p{P}`/`\p{S}` — and refuses to open the emphasis. The
   * fallback is verified by the astral regression tests; do NOT "optimize" this
   * to trust the code point's real category.
   */
  const isWordBoundaryChar = (c: string): boolean => {
    if (c === "") return true;
    const cp = c.codePointAt(0);
    if (cp === undefined) return true;
    // Astral (or a stray lone surrogate): word char -> HTML fallback.
    if (cp > 0xffff || (cp >= 0xd800 && cp <= 0xdfff)) return false;
    return /[\s\p{P}\p{S}]/u.test(c);
  };

  /**
   * LAST / FIRST code point of a string ("" when empty) — NOT a UTF-16 unit.
   * `slice(-1)` / `slice(0, 1)` would return a lone SURROGATE half of an astral
   * character. Taking two units first bounds the work to O(1) while still
   * capturing a whole surrogate pair, which `Array.from` then yields as one
   * code point.
   */
  const lastCodePoint = (s: string): string => {
    const cps = Array.from(s.slice(-2));
    return cps.length ? cps[cps.length - 1] : "";
  };
  const firstCodePoint = (s: string): string => Array.from(s.slice(0, 2))[0] ?? "";

  /**
   * Emit one detected code-emphasis run. `prevPart` / `nextPart` are the already
   * rendered markdown of the immediately surrounding siblings ("" at the edges) —
   * needed for the flanking check below.
   *
   * HOMOGENEOUS (every node carries the IDENTICAL non-code mark set): factor the
   * shared marks OUT once (in the first node's mark-array order, so the innermost
   * wrapper matches the single-node path), with each node rendered inside as its
   * code span (code innermost) or its escaped text.
   *
   * HETEROGENEOUS (the non-code sets differ — e.g. `[code,bold]` beside
   * `[italic]`): no single markdown factoring exists and per-node markdown would
   * collide (`` **`a`***b* `` — the `***` re-parses as ONE delimiter run and the
   * bold is lost), so emit the WHOLE run as schema HTML via inlineToHtml (per-node
   * wrapping, NOT factored). marked passes the inline HTML through and
   * generateJSON rebuilds the exact marks — lossless and idempotent.
   *
   * FLANKING (also HTML): even a homogeneous run can be unemittable as markdown.
   * CommonMark's flanking rules disqualify an emphasis delimiter that sits
   * BETWEEN a backtick and a word character:
   *   * an OPENER `**` directly before a code span is left-flanking only if the
   *     char BEFORE it is whitespace/punctuation — so `x**`+`` `a` ``+`**` (an
   *     emphasized code span glued to preceding prose) would NOT open, and
   *   * a CLOSER `**` directly after a code span is right-flanking only if the
   *     char AFTER it is whitespace/punctuation — so ``**`a`**b`` would NOT close.
   * Either way the delimiters re-pair across the paragraph on re-import and the
   * emphasis silently leaks onto (or off) neighbouring text — data loss on the
   * git-sync path. When the emitted markdown would land in that position, take the
   * same lossless HTML fallback. Runs separated from their neighbours by a space
   * (the overwhelmingly common ``pre **`code`** post``) are unaffected.
   */
  const renderCodeEmphasisRun = (
    run: any[],
    prevPart: string,
    nextPart: string,
    soloPart: string,
  ): string => {
    const identities = run.map(nonCodeMarkSetIdentity);
    const homogeneous = identities.every((id) => id === identities[0]);
    if (!homogeneous) return inlineToHtml(run);

    // A ONE-node run (the common ``pre **`code`** post``) is exactly what
    // `case "text"` already emitted (2a: code span innermost, other marks around
    // it in mark-array order) — reuse that rendering verbatim rather than
    // duplicating it, so `case "text"` stays the single source for a single run.
    let out = soloPart;
    if (run.length > 1) {
      out = run
        .map((n: any) => {
          const raw = n.text || "";
          // `code` is the INNERMOST wrapper; its content is literal (unescaped).
          return hasCodeMark(n) ? `\`${raw}\`` : escapeInlineText(raw);
        })
        .join("");
      for (const mark of nonCodeMarks(run[0])) {
        out = applyInlineMark(mark, out);
      }
    }

    // Flanking guard (see above). Only a BARE delimiter (`*`/`~`/`=`) that is
    // glued to a backtick can be disqualified; an HTML-form mark (<u>, <mark
    // style>, <span>, a link's brackets) is self-delimiting and always safe.
    const openerHitsCode = /^[*~=]+`/.test(out);
    const closerHitsCode = /`[*~=]+$/.test(out);
    const prevChar = lastCodePoint(prevPart);
    const nextChar = firstCodePoint(nextPart);
    if (
      (openerHitsCode && !isWordBoundaryChar(prevChar)) ||
      (closerHitsCode && !isWordBoundaryChar(nextChar))
    ) {
      return inlineToHtml(run);
    }
    return out;
  };

  // Render a run of inline children to MARKDOWN, with the #293 canon #6
  // inline-math guard. A `mathInline` serialized as `$…$` whose FOLLOWING
  // sibling renders starting with a DIGIT would put a digit right after the
  // closing `$`, which the pandoc inline rule refuses to parse as math (the
  // currency guard) — so the node would re-import as literal text (data loss).
  // For that node ONLY we fall back to the lossless schema-HTML `<span>` form.
  // Every other inline node is rendered exactly as processNode would, so output
  // is unchanged whenever no math sits directly before a digit.
  const renderInlineChildren = (nodes: any[]): string => {
    const parts = nodes.map(processNode);

    // #515 (2b/2c): coalesce code-emphasis runs BEFORE the math/hardBreak guards
    // below, so those guards see the FINAL rendering of their neighbours. A run's
    // whole output lands on its FIRST index and the remaining member indices are
    // blanked. A run can never start mid-way after a mathInline/hardBreak (those
    // node types break runs), so no guard ever looks at a blanked index.
    //
    // The pass only ever TRIGGERS on a genuine seed (a code node that itself
    // carries a bare-delimiter emphasis mark — see isRunSeed). Every inline shape
    // that was already expressible before #515 therefore contains no seed at all
    // and takes ZERO passes through here, keeping its historical markdown output
    // byte-for-byte.
    for (let i = 0; i < nodes.length; ) {
      if (!isRunSeed(nodes[i])) {
        i++;
        continue;
      }
      let start = i;
      while (start - 1 >= 0 && isRunMember(nodes[start - 1])) start--;
      let end = i;
      while (end + 1 < nodes.length && isRunMember(nodes[end + 1])) end++;
      // The neighbours are never run members (the run is maximal), so their parts
      // are already final markdown — safe to read for the flanking check.
      parts[start] = renderCodeEmphasisRun(
        nodes.slice(start, end + 1),
        parts[start - 1] ?? "",
        parts[end + 1] ?? "",
        // The `case "text"` rendering of a lone code run, already computed above.
        parts[start],
      );
      for (let j = start + 1; j <= end; j++) parts[j] = "";
      i = end + 1;
    }

    for (let i = 0; i < nodes.length - 1; i++) {
      if (
        nodes[i]?.type === "mathInline" &&
        parts[i].startsWith("$") &&
        /^[0-9]/.test(parts[i + 1] || "")
      ) {
        parts[i] = mathInlineHtml(nodes[i].attrs?.text || "");
      }
    }
    // #549: position-aware hardBreak. The two-space `  \n` form (emitted by the
    // processNode hardBreak case) only re-imports to a hardBreak when it is
    // FOLLOWED by same-paragraph text. It is silently lost when the break is
    // (a) the last inline child — the top-level `.trim()` strips the trailing
    // `  \n`, and even a non-last paragraph's trailing break sits before the
    // `\n\n` block gap — or (b) immediately followed by another hardBreak — the
    // intervening whitespace-only line reads as a paragraph separator on
    // re-parse, splitting the run. Emit `<br>` there instead: marked passes the
    // inline HTML break through and generateJSON rebuilds a hardBreak in every
    // position. A safe mid-paragraph break keeps the `  \n` form so the existing
    // golden output stays byte-stable. Skipped inside footnote bodies, whose
    // `^[…]` inline form collapses breaks to spaces (unchanged; already lossy).
    if (!inFootnoteBody) {
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i]?.type !== "hardBreak") continue;
        const next = nodes[i + 1];
        if (!next || next.type === "hardBreak" || (parts[i + 1] ?? "") === "") {
          parts[i] = "<br>";
        }
      }
    }
    return parts.join("");
  };

  // Render inline content (text runs + their marks) to HTML. Used by the raw
  // HTML fallbacks (spanned tables, columns) where marked will NOT re-parse
  // markdown, so backtick/asterisk/bracket syntax would otherwise leak as
  // literal characters. Each mark is mirrored to the HTML the schema's parseHTML
  // accepts so it re-imports as the matching ProseMirror mark.
  const inlineToHtml = (inlineNodes: any[]): string =>
    (inlineNodes || [])
      .map((n: any) => {
        if (n.type === "hardBreak") return "<br>";
        // #293 canon #6: on the raw-HTML path (columns/spanned cells) marked does
        // NOT re-parse markdown, so inline math MUST stay the schema-HTML `<span>`
        // form here — a `$…$` fence would land as literal text on re-import.
        if (n.type === "mathInline") return mathInlineHtml(n.attrs?.text || "");
        if (n.type === "footnoteReference") {
          // #293 canon #2 raw-HTML path (columns/spanned cells): marked does NOT
          // re-parse `^[…]` inside raw HTML, so the note text rides ON the <sup>
          // in a `data-fn-text` attribute (encoded exactly like the `^[…]`
          // inner). NO id is emitted here (F1): the importer's footnote post-pass
          // assigns ids by dedup-ing on the EXACT body text, so a column footnote
          // and an inline `^[…]` with the same body merge to one definition and
          // DIFFERENT bodies can never collide. The post-pass reads data-fn-text,
          // sets data-id, builds the doc-level definition, and strips the attr.
          const def = footnoteDefs.get(n.attrs?.id);
          const body = def ? renderFootnoteBody(def) : "";
          return `<sup data-footnote-ref data-fn-text="${escapeAttr(body)}"></sup>`;
        }
        if (n.type !== "text") {
          // Other inline atoms (mention, status) already emit schema HTML from
          // processNode.
          return processNode(n);
        }
        let t = escapeHtmlText(n.text || "");
        // #515: apply `code` FIRST so the <code> element is the INNERMOST wrapper
        // (`<strong><code>x</code></strong>`), regardless of where the mark sits
        // in this node's marks array. Required for byte stability: ProseMirror
        // re-orders a node's marks by schema rank on import, so honouring the
        // array order verbatim would flip <code> outside on the SECOND export and
        // md2 !== md1. Marks are a SET in ProseMirror, so the nesting order does
        // not change what re-imports — only the bytes. A node with no `code` mark
        // keeps the historical order exactly (the filter is order-preserving).
        const orderedMarks = [
          ...(n.marks || []).filter((m: any) => m.type === "code"),
          ...(n.marks || []).filter((m: any) => m.type !== "code"),
        ];
        for (const mark of orderedMarks) {
          switch (mark.type) {
            case "bold":
              t = `<strong>${t}</strong>`;
              break;
            case "italic":
              t = `<em>${t}</em>`;
              break;
            case "code":
              t = `<code>${t}</code>`;
              break;
            case "strike":
              t = `<s>${t}</s>`;
              break;
            case "underline":
              t = `<u>${t}</u>`;
              break;
            case "subscript":
              t = `<sub>${t}</sub>`;
              break;
            case "superscript":
              t = `<sup>${t}</sup>`;
              break;
            case "link": {
              // Mirror the top-level link path: emit the optional `title` too
              // (the schema's link mark carries a `title` attr — see
              // DocmostAttributes link globals — so <a title> round-trips). A
              // link with a title inside a column/spanned cell would otherwise
              // drop it on re-import.
              const linkTitle = mark.attrs?.title;
              const titleAttr = linkTitle
                ? ` title="${escapeAttr(String(linkTitle))}"`
                : "";
              t = `<a href="${escapeAttr(mark.attrs?.href || "")}"${titleAttr}>${t}</a>`;
              break;
            }
            case "highlight":
              t = mark.attrs?.color
                ? `<mark style="background-color: ${escapeAttr(mark.attrs.color)}">${t}</mark>`
                : `<mark>${t}</mark>`;
              break;
            case "textStyle":
              if (mark.attrs?.color)
                t = `<span style="color: ${escapeAttr(mark.attrs.color)}">${t}</span>`;
              break;
            case "spoiler":
              // Emit the same raw inline HTML the top-level path uses. The
              // schema's Spoiler mark parses span[data-spoiler] back on import,
              // so a spoiler inside a column/spanned cell survives the round
              // trip (without this case the mark was silently lost here).
              t = `<span data-spoiler="true">${t}</span>`;
              break;
            case "comment":
              // Inline comment anchor inside a raw-HTML container (columns /
              // spanned table cells), so commented text there also round-trips.
              if (mark.attrs?.commentId) {
                // Hide resolved anchors from agent reads: drop the wrapper and
                // keep only the bare text. Active anchors keep their wrapper.
                if (mark.attrs?.resolved && dropResolvedCommentAnchors) {
                  break;
                }
                const r = mark.attrs?.resolved ? ` data-resolved="true"` : "";
                t = `<span data-comment-id="${escapeAttr(mark.attrs.commentId)}"${r}>${t}</span>`;
              }
              break;
            default:
              // Unknown mark on the raw-HTML path: dropped (no HTML form). Report
              // the loss (throws in strict mode) — same policy as the markdown
              // path's marks loop above.
              warnLoss("mark", String(mark.type));
              break;
          }
        }
        return t;
      })
      .join("");

  // Emit the schema-matching <img> for an image node. Shared so the image is
  // emitted as real HTML wherever a raw-HTML container needs it (inside a column
  // or a spanned table cell), where markdown `![](...)` would NOT be re-parsed
  // and would survive as literal text. The Image extension reads src/alt from
  // the standard attributes; the Docmost extra attrs (width/height/align/size/
  // attachmentId/aspectRatio) are global attributes read from same-named DOM
  // attributes, so emit them by name.
  const imageToHtml = (node: any): string => {
    const attrs = node.attrs || {};
    const parts: string[] = [`src="${escapeAttr(attrs.src ?? "")}"`];
    if (attrs.alt) parts.push(`alt="${escapeAttr(attrs.alt)}"`);
    if (attrs.title) parts.push(`title="${escapeAttr(attrs.title)}"`);
    if (attrs.width != null) parts.push(`width="${escapeAttr(attrs.width)}"`);
    if (attrs.height != null) parts.push(`height="${escapeAttr(attrs.height)}"`);
    // #293 canon #4: image align default is unified to "center", so a center
    // (or unset) image no longer emits a redundant align="center" here — only a
    // genuinely non-default alignment (left/right) is written.
    if (attrs.align && attrs.align !== "center")
      parts.push(`align="${escapeAttr(attrs.align)}"`);
    if (attrs.size != null) parts.push(`data-size="${escapeAttr(attrs.size)}"`);
    if (attrs.attachmentId)
      parts.push(`data-attachment-id="${escapeAttr(attrs.attachmentId)}"`);
    if (attrs.aspectRatio != null)
      parts.push(`data-aspect-ratio="${escapeAttr(attrs.aspectRatio)}"`);
    // Plain-text caption (issue #221). Markdown `![](src)` cannot carry it, so
    // emit it as data-caption; the schema's image `caption` attr parses it back.
    if (attrs.caption) parts.push(`data-caption="${escapeAttr(attrs.caption)}"`);
    return `<img ${parts.join(" ")}>`;
  };

  // Emit the schema-matching div[data-type="callout"] for a callout node. The
  // schema reads the banner type from data-callout-type. Children are rendered
  // as HTML so they survive inside a raw-HTML container.
  const calloutToHtml = (node: any): string => {
    const type = (node.attrs?.type || "info").toLowerCase();
    const inner = (node.content || []).map(blockToHtml).join("");
    return `<div data-type="callout" data-callout-type="${escapeAttr(type)}">${inner}</div>`;
  };

  // Emit a schema-matching <details> tree. The schema parses <details>,
  // summary[data-type="detailsSummary"], and div[data-type="detailsContent"].
  // The `open` (collapsed/expanded) state lives on the details node and the
  // schema parses it back from the attribute, so emit it here too — mirroring
  // the top-level `details` case — or a NESTED details (inside columns/cells)
  // would silently drop `open:true` every round trip.
  const detailsToHtml = (node: any): string => {
    const open = node.attrs?.open ? " open" : "";
    const inner = (node.content || []).map(blockToHtml).join("");
    return `<details${open}>${inner}</details>`;
  };
  const detailsSummaryToHtml = (node: any): string =>
    `<summary data-type="detailsSummary">${inlineToHtml(node.content || [])}</summary>`;
  const detailsContentToHtml = (node: any): string => {
    const inner = (node.content || []).map(blockToHtml).join("");
    return `<div data-type="detailsContent">${inner}</div>`;
  };

  // Emit the schema-matching taskList/taskItem HTML. bridgeTaskLists (in
  // collaboration.ts) recognizes ul[data-type="taskList"] with
  // li[data-type="taskItem"][data-checked]; emitting that directly here keeps
  // task lists inside columns/cells from degrading to literal "- [ ]" text.
  const taskListToHtml = (node: any): string => {
    const items = (node.content || [])
      .map((it: any) => {
        const checked = it.attrs?.checked ? "true" : "false";
        return `<li data-type="taskItem" data-checked="${checked}">${blockChildrenToHtml(it)}</li>`;
      })
      .join("");
    return `<ul data-type="taskList">${items}</ul>`;
  };

  // Render a block node to HTML for the raw-HTML containers (spanned tables,
  // columns). marked does NOT re-parse markdown inside a raw-HTML block, so
  // EVERY block type that can appear inside a column or a spanned cell must be
  // emitted as schema-matching HTML here — never as markdown, or it would land
  // as literal text on re-import. Nodes whose processNode case already produces
  // schema-matching HTML (math/media/embed/attachment/nested columns/spanned
  // table) are delegated to processNode; the markdown-emitting cases
  // (image/blockquote/callout/details/hr/taskList) get explicit HTML here.
  const blockToHtml = (block: any): string => {
    const children = block.content || [];
    switch (block.type) {
      case "paragraph": {
        // Carry textAlign here too (symmetric with the processNode paragraph
        // case): a paragraph nested inside an HTML container (column/table/
        // callout) would otherwise drop its alignment on the round trip.
        const pAlign = block.attrs?.textAlign;
        const pStyle =
          pAlign && pAlign !== "left"
            ? ` style="text-align:${escapeAttr(pAlign)}"`
            : "";
        return `<p${pStyle}>${inlineToHtml(children)}</p>`;
      }
      case "heading": {
        // Same for a heading nested in an HTML container: emit the alignment as
        // an inline style (symmetric with the processNode heading case) so it is
        // not silently dropped. Clamp the level to a valid HTML heading tag.
        const level = Math.min(6, Math.max(1, block.attrs?.level || 1));
        const hAlign = block.attrs?.textAlign;
        const hStyle =
          hAlign && hAlign !== "left"
            ? ` style="text-align:${escapeAttr(hAlign)}"`
            : "";
        return `<h${level}${hStyle}>${inlineToHtml(children)}</h${level}>`;
      }
      case "bulletList":
        return `<ul>${children
          .map((li: any) => `<li>${blockChildrenToHtml(li)}</li>`)
          .join("")}</ul>`;
      case "orderedList": {
        // Carry a non-1 `start` on the raw-HTML path (columns/spanned cells) via
        // the <ol start="N"> attribute, which the tiptap parser reads back into
        // attrs.start. A default (start=1) list stays a bare <ol>. See #351.
        // Use the SAME integer-≥-2 guard as the markdown path: a fractional start
        // would emit `start="2.5"` → parseInt→2 on import (path divergence), and a
        // 0/negative start is not a valid explicit start either.
        const raw = block.attrs?.start;
        const start = Number.isInteger(raw) && (raw as number) > 1 ? (raw as number) : 1;
        const startAttr = start > 1 ? ` start="${start}"` : "";
        return `<ol${startAttr}>${children
          .map((li: any) => `<li>${blockChildrenToHtml(li)}</li>`)
          .join("")}</ol>`;
      }
      case "codeBlock": {
        const lang = block.attrs?.language || "";
        // The code itself is element TEXT content (between <code> tags), so it
        // must escape < > & — NOT the attribute escaper. The language rides in
        // a class ATTRIBUTE, so it uses escapeAttr.
        //
        // Read the child text RAW (as `case "codeBlock"` does) and keep it
        // VERBATIM — do NOT strip the trailing newline. Unlike the markdown fence
        // path (which strips then relies on marked re-adding one `\n`), the schema
        // codeBlock parseHTML reads the `<code>` text content back byte-for-byte,
        // so stripping here would drop a trailing newline the node legitimately
        // carries and break the round trip inside a column/cell.
        const code = escapeHtmlText(
          children
            .map((child: any) =>
              typeof child?.text === "string" ? child.text : "",
            )
            .join(""),
        );
        const cls = lang ? ` class="language-${escapeAttr(lang)}"` : "";
        return `<pre><code${cls}>${code}</code></pre>`;
      }
      case "image":
        return imageToHtml(block);
      case "blockquote":
        return `<blockquote>${children.map(blockToHtml).join("")}</blockquote>`;
      case "horizontalRule":
        return "<hr>";
      case "callout":
        return calloutToHtml(block);
      case "details":
        return detailsToHtml(block);
      case "detailsSummary":
        return detailsSummaryToHtml(block);
      case "detailsContent":
        return detailsContentToHtml(block);
      case "taskList":
        return taskListToHtml(block);
      case "taskItem":
        // A bare taskItem (outside a taskList) still needs a wrapping list so
        // the schema parses it; wrap it in a single-item taskList.
        return taskListToHtml({ content: [block] });
      // A table nested in a raw-HTML block (e.g. inside a column) MUST be the
      // HTML <table> form — a GFM pipe table here would not be re-parsed by
      // marked and would round-trip as literal "| a | b |" text (review #7).
      case "table":
        return tableToHtml(block.content || []);
      // #293 canon #5: on the TOP-LEVEL path (processNode) subpages/pageBreak
      // serialize as standalone `<!--...-->` comments, but a comment node is
      // discarded by the DOM parse stage (jsdom/parse5) that reads back a raw-
      // HTML block — so inside a column/cell the comment form would silently
      // vanish (latent data loss; these atoms previously fell through to the
      // `default` <div></div>). Here we KEEP the schema-matching div-form so the
      // node survives the raw-HTML round trip.
      case "pageBreak":
        return `<div data-type="pageBreak"></div>`;
      case "subpages": {
        const recursive = block.attrs?.recursive ? ` data-recursive="true"` : "";
        return `<div data-type="subpages"${recursive}></div>`;
      }
      // #293 canon #8: the media/discriminator family now serializes at TOP LEVEL
      // (processNode) as md-target + `<!--name-->` comment. A comment node is
      // DROPPED by the DOM parse stage that reads a raw-HTML block back, so inside
      // a column/cell the comment form would silently vanish (data loss). Give
      // each an EXPLICIT schema-HTML case here (via the shared media-html builders
      // — the SAME output processNode used to emit, and the same the importer
      // rebuilds) instead of delegating to processNode's md+comment form.
      case "video":
        return videoToHtml(block.attrs || {});
      case "audio":
        return audioToHtml(block.attrs || {});
      case "pdf":
        return pdfToHtml(block.attrs || {});
      case "youtube":
        return youtubeToHtml(block.attrs || {});
      case "embed":
        return embedToHtml(block.attrs || {});
      case "attachment":
        return attachmentToHtml(block.attrs || {});
      case "drawio":
      case "excalidraw":
        return diagramToHtml(block.type, block.attrs || {});
      case "pageEmbed":
        return pageEmbedToHtml(block.attrs || {});
      case "transclusionReference":
        return transclusionReferenceToHtml(block.attrs || {});
      // #293 canon #6: on the TOP-LEVEL path (processNode) mathBlock now
      // serializes as a `$$…$$` fence, but marked does NOT re-parse markdown
      // inside a raw-HTML block, so inside a column/cell it MUST stay the
      // schema-HTML `<div>` form or it would land as literal `$$…$$` text on
      // re-import. Give it an EXPLICIT case here (the same form the importer
      // rebuilds) instead of delegating to processNode's fence form.
      case "mathBlock":
        return mathBlockHtml(block.attrs?.text || "");
      // #293 canon #2: on the markdown path a footnotesList emits nothing (the
      // note body rides at each `^[…]` reference). But a raw-HTML container
      // drops comment/markdown reconstruction, so KEEP the schema-matching
      // <section>/<div> HTML here so a footnotesList that ever lands inside a
      // column/cell still round-trips via the schema's parseHTML instead of
      // vanishing. (Normally the list is doc-level and never nests here.)
      case "footnotesList": {
        const inner = (block.content || []).map(blockToHtml).join("");
        return `<section data-footnotes>${inner}</section>`;
      }
      case "footnoteDefinition": {
        const idAttr = block.attrs?.id
          ? ` data-id="${escapeAttr(block.attrs.id)}"`
          : "";
        const inner = (block.content || []).map(blockToHtml).join("");
        return `<div data-footnote-def${idAttr}>${inner}</div>`;
      }
      // columns/column, htmlEmbed, transclusionSource already emit
      // schema-matching HTML from processNode.
      case "columns":
      case "column":
      case "htmlEmbed":
      case "transclusionSource":
        return processNode(block);
      default:
        // Any still-unhandled block type: NEVER fall back to markdown inside a
        // raw-HTML block (it would become literal text). Wrap its rendered
        // children in a <div> so their content is preserved; if it has no block
        // children, render its inline content instead.
        if (children.length && children.some((c: any) => c.type !== "text")) {
          return `<div>${children.map(blockToHtml).join("")}</div>`;
        }
        return `<div>${inlineToHtml(children)}</div>`;
    }
  };

  // Render the block children of a list item to HTML (a listItem holds block+
  // content). Mirrors processListItem but for the HTML fallback path.
  const blockChildrenToHtml = (item: any): string =>
    (item.content || []).map((b: any) => blockToHtml(b)).join("");

  // Indent the rendered children of a list item under a marker prefix.
  // Each child block is a (possibly multi-line) string. The very first physical
  // line of the first child carries the marker (e.g. "- " or "1. "); EVERY
  // other line — the remaining lines of the first child AND all lines of every
  // subsequent child (nested lists, code blocks, extra paragraphs) — is indented
  // to align under the marker. Without indenting these continuation lines, the
  // 2nd/3rd line of a nested child collapses to column 0 and escapes the list.
  //
  // The continuation indent MUST equal the LIST marker width, which is not the
  // same as the visible prefix width:
  //   - bullet "- "          -> 2 columns
  //   - task   "- [ ] "      -> marker is still "- " (the "[ ] " is content), 2
  //   - ordered "1. "/"10. " -> 3/4 columns, scaling with the number's digits
  // CommonMark anchors nested content to the marker column, so an ordered item
  // indented to only 2 columns would be re-parsed as a sibling/loose content on
  // re-import. Callers therefore pass the exact indent width to use.
  const indentItemChildren = (
    childStrings: string[],
    prefix: string,
    indentWidth: number,
  ): string => {
    const indent = " ".repeat(indentWidth);
    const lines: string[] = [];
    childStrings.forEach((child, childIndex) => {
      // Separate consecutive block children with a BLANK line so the item is a
      // CommonMark "loose" list item and each block stays its own node. Without
      // it, a second paragraph (`- a\n  b`) is re-parsed as a lazy continuation
      // of the first and the two merge into one paragraph — silent data loss.
      // The blank line still sits INSIDE the item (the following block keeps the
      // continuation indent), so nested lists/code blocks remain nested.
      if (childIndex > 0) lines.push("");
      child.split("\n").forEach((line, lineIndex) => {
        if (childIndex === 0 && lineIndex === 0) {
          // First physical line of the first block gets the marker.
          lines.push(`${prefix} ${line}`);
        } else {
          // Indent every continuation line by the marker width; keep blank
          // lines blank rather than emitting trailing whitespace.
          lines.push(line.length ? `${indent}${line}` : "");
        }
      });
    });
    return lines.join("\n");
  };

  const processListItem = (item: any, prefix: string): string => {
    const itemContent = item.content || [];
    // A `<!-- -->` entry separates two adjacent same-family sublists inside the
    // item so they do not merge on re-parse (see renderBlockChildren).
    const childStrings = renderBlockChildren(itemContent, processNode);
    if (childStrings.length === 0) return prefix;
    // The rendered marker is `${prefix} ` (prefix + one space), so its width —
    // and thus the continuation indent — is prefix.length + 1. This is correct
    // for both bullet ("-" -> 2) and ordered ("1." -> 3, "10." -> 4) markers,
    // since for those the visible prefix IS the list marker.
    return indentItemChildren(childStrings, prefix, prefix.length + 1);
  };

  const processTaskItem = (item: any): string => {
    const checked = item.attrs?.checked || false;
    const checkbox = checked ? "[x]" : "[ ]";
    const prefix = `- ${checkbox}`;
    const itemContent = item.content || [];
    // A `<!-- -->` entry separates two adjacent same-family sublists inside the
    // item so they do not merge on re-parse (see renderBlockChildren).
    const childStrings = renderBlockChildren(itemContent, processNode);
    // An empty task item still needs its checkbox marker; without this guard
    // the indent below produces "" and the "- [ ]"/"- [x]" row disappears.
    if (childStrings.length === 0) return prefix;
    // The list marker for a task item is just "- " (2 columns); the "[ ] "/"[x] "
    // checkbox is item content, NOT part of the marker. So the continuation
    // indent is a fixed 2 — do NOT derive it from the wider prefix.length.
    return indentItemChildren(childStrings, prefix, 2);
  };

  return processNode(content).trim();
}
