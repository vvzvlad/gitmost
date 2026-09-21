/**
 * Locator normalization helpers for mcp. The two PRIMITIVES —
 * `stripInlineMarkdown` (lenient locator normalizer) and `stripWrappersAndLinks`
 * (strict balanced-wrapper/link collapse) — live in the canonical package
 * `@docmost/prosemirror-markdown` (#493 dedup: they used to be forked verbatim
 * here). This module now only re-exports `stripInlineMarkdown` and adds the two
 * mcp-only helpers built on top: `stripBalancedWrappers` and `closestBlockHint`.
 *
 * They are used ONLY as a fallback for LOCATING (after an exact match fails) and
 * for formatting-vs-plain intent detection; never applied to replacement text or
 * inserted node content, so no formatting is ever lost.
 */
import {
  stripInlineMarkdown,
  stripWrappersAndLinks,
  foldInvisibles,
  escapeInvisibles,
} from "@docmost/prosemirror-markdown";

// Re-export the canonical locator normalizer so mcp call sites keep importing it
// from `./text-normalize.js` unchanged.
export { stripInlineMarkdown };

// Re-export the fold canon (#658) so mcp call sites import it from
// `./text-normalize.js` alongside the other locator helpers.
export {
  foldInvisibles,
  foldTypography,
  escapeInvisibles,
  isFoldDelete,
  isFoldSpace,
} from "@docmost/prosemirror-markdown";

/**
 * STRICT formatting detector — distinct from the lenient locator normalization.
 * It strips ONLY what unambiguously is markdown markup (links/images to visible
 * text, and balanced inline `**`/`__`/`~~`/`*`/`_`/`` ` `` wrappers) and
 * DELIBERATELY does NOT trim leading/trailing whitespace, emoji, or lone marker
 * chars (the lenient extras `stripInlineMarkdown` does).
 *
 * It exists ONLY to recognize formatting-vs-plain INTENT in `applyTextEdits`
 * (deciding whether find/replace differ purely by markdown markers). Because it
 * skips the lenient trimming, ordinary plain-text edits are NOT misread as
 * formatting: a trailing-space trim, snake_case (`my_var_name`), math (`2 * 3`),
 * and identifiers/URLs with underscores all stay untouched here (their `_x_` /
 * `*x*` runs are only collapsed when actually balanced, and even then they are
 * compared symmetrically, so plain text never collapses to a different string).
 *
 * Do NOT use this for LOCATING — the locator fallback must keep using the
 * lenient `stripInlineMarkdown` (it trims stray decoration so a find still
 * matches the document's plain text).
 */
export function stripBalancedWrappers(s: string): string {
  if (typeof s !== "string" || s.length === 0) return s;
  return stripWrappersAndLinks(s);
}

/**
 * Build a bounded "closest text" hint for an anchor/find MISS, shared by
 * editPageText (json-edit) and createComment (client) so both surface the
 * same self-correction affordance.
 *
 * Take the longest whitespace-delimited token (>= 3 chars) of the locator
 * (markdown-stripped first, so `**bold**` contributes `bold`), find the FIRST
 * of `blockTexts` that contains it, and return ` Closest block text: "…".` with
 * the block quoted (truncated to 120 code points + ellipsis). Returns "" when
 * no token qualifies or no block contains it, so the caller can append it
 * unconditionally.
 */
export function closestBlockHint(
  blockTexts: string[],
  locator: string,
  escape = false,
): string {
  if (typeof locator !== "string" || locator.length === 0) return "";
  const stripped = stripInlineMarkdown(locator);
  const tokenSource = stripped.length > 0 ? stripped : locator;
  const longestToken = tokenSource
    .split(/\s+/)
    .filter((t) => t.length >= 3)
    .sort((a, b) => b.length - a.length)[0];
  if (!longestToken) return "";
  const hitBlock = blockTexts.find((plain) => plain.includes(longestToken));
  if (!hitBlock) return "";
  // Truncate by code point (spread iterates by code point) so a surrogate pair
  // is never split; append the ellipsis only when the text was actually longer.
  const points = [...hitBlock];
  const truncated =
    points.length > 120 ? points.slice(0, 120).join("") + "…" : hitBlock;
  // When quoting a MISS diagnostic, make invisible characters visible so the
  // agent sees WHY its (visually identical) find did not match (#658).
  const snippet = escape ? escapeInvisibles(truncated) : truncated;
  return ` Closest block text: "${snippet}".`;
}
