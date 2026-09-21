/**
 * Foreign-markdown normalizer — an input-liberal / output-canonical adapter that
 * runs at the IMPORT boundary, BEFORE the canonical parser
 * (`markdownToProseMirror`, this package).
 *
 * OWNED BY THIS PACKAGE (#493): the normalizer used to live only in
 * apps/server's import path, so the MCP page-write path (`updatePageMarkdown` ->
 * `markdownToProseMirrorCanonical`) handled the SAME foreign input differently
 * (no front-matter strip, no `[^id]` reference-footnote rewrite) than the server
 * importer. Moving it here — and calling it from `markdownToProseMirrorCanonical`
 * — makes every canonical import boundary treat foreign markdown identically.
 *
 * The canonical parser is deliberately STRICT: it only understands Docmost's
 * canonical markdown surface (Obsidian-style `> [!type]` callouts, Pandoc/Obsidian
 * inline footnotes `^[body]`, lossless `![alt](src) <!--img {...}-->` images, …).
 * Import, however, ingests FOREIGN files (GitHub/GFM, Notion, old Docmost
 * exports). Those use surfaces the canonical parser does not accept, most notably
 * GitHub-flavoured *reference* footnotes:
 *
 *     Text with a note[^1] and another[^long].
 *
 *     [^1]: The first definition.
 *     [^long]: A second one.
 *
 * Left untouched, the parser does NOT recognise `[^id]` (it only parses `^[body]`),
 * so the reference leaks as literal text — and worse, the trailing `[^id]: def`
 * line is a valid CommonMark *link-reference definition*, so `[^id]` is silently
 * rendered as a bogus link. This normalizer rewrites reference footnotes into the
 * canonical inline form so the parser materialises real footnote nodes.
 *
 * This is a TEXT pre-pass, NOT a second parser fork: it does not re-implement any
 * converter logic. Callout surfaces (`:::type` and `> [!type]`) are intentionally
 * NOT touched here — the canonical parser already accepts BOTH natively (its
 * `preprocessCallouts` pass), so normalizing them would be redundant and would
 * only risk degrading the parser's nesting/code-fence-aware handling.
 */

/** Matches a fenced code block delimiter (``` or ~~~), capturing the marker run. */
const CODE_FENCE_RE = /^(\s*)(`{3,}|~{3,})/;

/**
 * Matches a GFM footnote DEFINITION line: `[^id]: body`. The id is any run of
 * non-`]` characters; the body is the remainder of the line (possibly empty).
 */
const FOOTNOTE_DEF_RE = /^\[\^([^\]]+)\]:[ \t]?(.*)$/;

/** True when a line is a code-fence delimiter that toggles fenced-code state. */
function fenceMarker(line: string): string | null {
  const m = line.match(CODE_FENCE_RE);
  return m ? m[2] : null;
}

/** True when a line is indented (leading space/tab) and not blank — a continuation. */
function isIndentedContinuation(line: string): boolean {
  return /^[ \t]+\S/.test(line);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Backslash-escape any square bracket in a footnote body before it is wrapped in
 * `^[...]`. The canonical inline-footnote tokenizer scans the body with bracket
 * balancing and closes on the first UNMATCHED `]`, so an unbalanced bracket in a
 * foreign definition (e.g. `[^1]: see item ] later`) would otherwise truncate the
 * footnote and leak the tail as literal text. Escaping every `[`/`]` makes the
 * body an inert run of characters — the tokenizer then closes only on our own
 * closing `]`. (A balanced `[link](url)` inside a body still round-trips because
 * the escaped form renders the literal brackets, which is the safe reading for a
 * footnote body; the alternative — brittle balance tracking — risks worse.)
 */
function escapeFootnoteBody(body: string): string {
  return body.replace(/[[\]]/g, '\\$&');
}

/**
 * Rewrite every `[^id]` reference on a line to its `^[body]` form, but ONLY in the
 * text OUTSIDE inline-code spans. A `[^id]` inside backticks is literal code
 * content and must be preserved verbatim (a footnote ref never lives inside code).
 * We split the line on inline-code spans (paired backtick runs) and rewrite only
 * the non-code segments.
 */
// Above this length a single line is not split into inline-code spans (see
// below). A genuine markdown line carrying a footnote reference is never tens of
// KB; the cap only bypasses the inline-code protection for pathological lines.
const INLINE_SPLIT_MAX_LINE = 8192;

function rewriteRefsOutsideInlineCode(
  line: string,
  replace: (text: string) => string,
): string {
  // The inline-code split alternation `(`+)(?:(?!\1)[\s\S])*\1` backtracks
  // quadratically on a long UNCLOSED backtick run (its middle can consume the
  // rest of the line, then fail to find a closing run and retry from each
  // position). On an untrusted import this is a request-thread ReDoS. A real
  // footnote line is short, so for an oversized line we skip the inline-code
  // protection entirely and leave the line UNTOUCHED (rewriting it wholesale
  // could corrupt a `[^id]` that legitimately lives inside inline code). This is
  // a conservative bypass: an over-8KB line simply does not get its reference
  // footnotes inlined — acceptable for a pathological input.
  if (line.length > INLINE_SPLIT_MAX_LINE) return line;

  // Alternation: an inline-code span (one or more backticks, then anything up to
  // the SAME run of backticks) OR a run of non-backtick text. Unterminated
  // backticks fall through as ordinary text (matched by the second branch on the
  // leftover), so a stray backtick never swallows the rest of the line.
  const parts = line.match(/(`+)(?:(?!\1)[\s\S])*\1|[^`]+|`+/g);
  if (!parts) return line;
  return parts
    .map((seg) => (seg.startsWith('`') ? seg : replace(seg)))
    .join('');
}

/**
 * Convert GFM reference footnotes (`[^id]` + `[^id]: def`) into canonical inline
 * footnotes (`^[def]`).
 *
 * - Definitions are collected first (a leading `[^id]: text` line plus any
 *   immediately-following indented continuation lines, joined with a space) and
 *   removed from the output.
 * - Each in-text reference `[^id]` for which a definition was found is replaced by
 *   `^[def]`. References with no matching definition are left literal (there is no
 *   body to inline; the parser fails them open the same way).
 * - Code is respected on both passes: `[^id]` inside a fenced ``` / ~~~ block is
 *   never rewritten and a `[^id]:` line inside a fence is never a definition; and
 *   on the rewrite pass a `[^id]` inside an INLINE-code span (backticks) is left
 *   literal too.
 * - The inlined body is bracket-escaped so an unbalanced `[`/`]` in a foreign
 *   definition cannot truncate the resulting `^[...]` footnote.
 *
 * Deduplication / reference-ordering / orphan-dropping of the resulting footnotes
 * is handled downstream by the canonical parser (`assembleFootnotes`); this pass
 * only changes the surface syntax.
 */
function convertReferenceFootnotes(markdown: string): string {
  const lines = markdown.split('\n');

  // Pass 1: collect definitions and mark their lines for removal.
  const defs = new Map<string, string>();
  const dropped = new Array<boolean>(lines.length).fill(false);
  let inFence = false;
  let fence = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = fenceMarker(line);
    if (inFence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
        inFence = false;
        fence = '';
      }
      continue;
    }
    if (marker) {
      inFence = true;
      fence = marker;
      continue;
    }

    const def = line.match(FOOTNOTE_DEF_RE);
    if (!def) continue;

    const id = def[1];
    const body: string[] = [def[2].trim()];
    dropped[i] = true;

    // Consume immediately-following indented continuation lines (GFM lazy
    // continuation is not supported by design — keep it simple and predictable).
    let j = i + 1;
    while (j < lines.length && isIndentedContinuation(lines[j])) {
      body.push(lines[j].trim());
      dropped[j] = true;
      j++;
    }
    i = j - 1;

    // Last definition wins for a duplicated id (matches CommonMark link-ref
    // semantics closely enough for a foreign-input adapter).
    defs.set(id, body.filter((s) => s.length > 0).join(' '));
  }

  if (defs.size === 0) {
    return markdown;
  }

  // ONE fixed, generic scanner regex — NOT one built from the definition ids.
  // It matches ANY `[^id]` shape, and the replacer decides per match via a map
  // lookup whether that id is a real definition (replace) or not (leave as-is).
  // This is genuinely O(total text) with no per-document regex compilation.
  //
  // Do NOT rebuild this as an alternation over `[...defs.keys()]`: a giant
  // `(id1|id2|...)` alternation over thousands of ids can blow the V8 regex
  // compiler's stack — a fatal, UNCATCHABLE "RegExpCompiler Allocation failed"
  // on prefix-chain ids (`a`, `aa`, `aaa`, ...) that kills the whole process
  // (worse than the earlier per-def thread-hang). A fixed scanner has no
  // id-dependent compilation cost and cannot blow up.
  const refRe = /\[\^([^\]]+)\]/g;
  const rewriteSegment = (segment: string): string =>
    segment.replace(refRe, (whole, id: string) => {
      const body = defs.get(id);
      // Only real definitions are inlined; an unknown id is left literal (same as
      // the old per-def loop, which simply never matched it).
      return body === undefined ? whole : `^[${escapeFootnoteBody(body)}]`;
    });

  // Pass 2: rewrite in-text references, skipping fenced code and dropped lines.
  const out: string[] = [];
  inFence = false;
  fence = '';
  for (let i = 0; i < lines.length; i++) {
    if (dropped[i]) continue;
    let line = lines[i];

    const marker = fenceMarker(line);
    if (inFence) {
      out.push(line);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
        inFence = false;
        fence = '';
      }
      continue;
    }
    if (marker) {
      inFence = true;
      fence = marker;
      out.push(line);
      continue;
    }

    line = rewriteRefsOutsideInlineCode(line, rewriteSegment);
    out.push(line);
  }

  return out.join('\n');
}

/**
 * Strip a single leading YAML front-matter block (`---\n…\n---`). Foreign files
 * from Obsidian / Hugo / Jekyll / Notion — and Docmost's OWN git-sync page files
 * — open with front-matter that the canonical parser does not consume, so
 * without this it leaks into the body (and `title: Foo` above the closing `---`
 * renders as a setext `<h2>` that `extractTitleAndRemoveHeading` can hijack as
 * the page title). It is a no-op for front-matter-free input.
 *
 * LINE-ANCHORED (the same shape the canonical parser uses in
 * prosemirror-markdown/page-file.ts): the block opens only on `---\n` at the
 * very start and closes only on a `\n---` line. The retired editor-ext
 * `markdownToHtml` front-matter strip (removed in #347) closed on the FIRST
 * `---` ANYWHERE (an unanchored close), so a value
 * containing a triple-dash (e.g. `title: Q1 --- Q2`) truncated the front-matter
 * and leaked the rest into the body. An optional leading BOM is tolerated.
 */
const YAML_FRONT_MATTER_RE = /^\uFEFF?---\n[\s\S]*?\n---\n?/;

/**
 * Normalize a foreign markdown string from a FILE IMPORT into Docmost's canonical
 * markdown surface so the strict canonical parser accepts it losslessly: normalize
 * line endings, strip a leading YAML front-matter block, then rewrite GFM reference
 * footnotes into inline footnotes. Add further fixture-driven foreign-surface cases
 * here as they are found.
 *
 * FRONT-MATTER STRIP IS IMPORT-ONLY (#493 review): use this ONLY at the server
 * file-import boundary, where a `.md` file really can open with an Obsidian/Hugo
 * YAML header. Do NOT use it on the canonical AGENT-WRITE path — see
 * {@link normalizeAgentMarkdown} for why a full-body agent rewrite must NOT strip
 * a leading `---…---` (it is normally a horizontalRule the serializer emitted, and
 * stripping it would silently drop the page's leading content).
 */
export function normalizeForeignMarkdown(markdown: string): string {
  if (!markdown) return markdown;
  // Normalize CRLF -> LF FIRST. The line-anchored front-matter regex requires a
  // bare `\n` after the opening `---`, and convertReferenceFootnotes splits on
  // `\n`; a Windows/CRLF foreign file (`---\r\n…`) would otherwise slip past the
  // front-matter strip and leak into the body. The canonical parser
  // (page-file.ts parsePageFile) normalizes the same way before its FRONTMATTER_RE.
  const src = markdown.replace(/\r\n/g, '\n');
  const withoutFrontMatter = src.replace(YAML_FRONT_MATTER_RE, '').trimStart();
  return convertReferenceFootnotes(withoutFrontMatter);
}

/**
 * Canonical AGENT-WRITE normalization: normalize line endings and rewrite GFM
 * `[^id]` reference footnotes to inline `^[body]` — but DELIBERATELY NOT strip a
 * leading YAML front-matter block.
 *
 * WHY the split (#493 review): the reference-footnote rewrite is the drift the
 * MCP page-write path (`updatePageMarkdown` -> `markdownToProseMirrorCanonical`)
 * needed unified with the server import (an agent may paste GFM footnotes). The
 * front-matter strip, however, is a FILE-import concern: on a full-body agent
 * rewrite a leading `---…---` is (almost) always a `horizontalRule` the
 * serializer emitted plus a later rule/heading — NOT a foreign YAML header — so
 * `YAML_FRONT_MATTER_RE` would match it and SILENTLY DELETE the page's leading
 * content (a page that starts with a horizontal rule and contains a second `---`
 * lost everything up to it). Agent writes must never lose already-stored content,
 * so this variant skips the strip. It IS a no-op on canonical serialized content
 * (which never emits `[^id]:` reference-definition lines).
 */
export function normalizeAgentMarkdown(markdown: string): string {
  if (!markdown) return markdown;
  const src = markdown.replace(/\r\n/g, '\n');
  return convertReferenceFootnotes(src);
}
