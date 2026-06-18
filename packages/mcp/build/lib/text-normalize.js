/**
 * Locator normalization: strip inline markdown wrappers and trailing
 * decoration from a LOCATOR string so a find/anchor that the model wrote with
 * markdown (or a stray emoji) can still match the document's plain text.
 *
 * This is used ONLY as a fallback for LOCATING (after an exact match fails);
 * it is never applied to replacement text or inserted node content, so no
 * formatting is ever lost.
 */
/** Maximum unwrap passes, so pathological/nested input cannot loop forever. */
const MAX_PASSES = 8;
/**
 * Inline emphasis/code/strikethrough wrappers, strong BEFORE emphasis so
 * `**x**` collapses to `x` rather than leaving a stray `*x*`. Each pattern is
 * non-greedy and capture group 1 is the inner text. Applied repeatedly until
 * the string stops changing (nested wrappers like `**_x_**`).
 */
const WRAPPER_PATTERNS = [
    /\*\*([^*]+?)\*\*/g, // **x**
    /__([^_]+?)__/g, // __x__
    /~~([^~]+?)~~/g, // ~~x~~
    /\*([^*]+?)\*/g, // *x*
    /_([^_]+?)_/g, // _x_
    /``([^`]+?)``/g, // ``x``
    /`([^`]+?)`/g, // `x`
];
/** Links/images -> their visible text. `!?` covers both `[t](u)` and `![a](s)`. */
const LINK_IMAGE_RE = /!?\[([^\]]*)\]\([^)]*\)/g;
/**
 * Apply ONLY the two balanced/link passes shared by both normalizers: first
 * collapse links/images to their visible text, then collapse balanced inline
 * wrappers repeatedly until stable. Does NOT trim decoration, does NOT guard
 * against an empty result — it returns exactly the transformed string.
 */
function stripWrappersAndLinks(s) {
    // 1. Links/images -> their visible text.
    let out = s.replace(LINK_IMAGE_RE, "$1");
    // 2. Strip balanced wrappers, repeating until the string is stable so nested
    //    wrappers (`**_x_**`) and adjacent runs both collapse.
    for (let pass = 0; pass < MAX_PASSES; pass++) {
        const before = out;
        for (const re of WRAPPER_PATTERNS) {
            out = out.replace(re, "$1");
        }
        if (out === before)
            break;
    }
    return out;
}
/**
 * STRICT formatting detector — distinct from the lenient locator
 * normalization below. It strips ONLY what unambiguously is markdown markup:
 *  1. links/images `[text](url)` -> `text`, `![alt](src)` -> `alt`, and
 *  2. balanced inline `**`/`__`/`~~`/`*`/`_`/`` ` `` wrappers (repeat-until-stable),
 * and DELIBERATELY does NOT trim leading/trailing whitespace, emoji, or lone
 * marker chars (the lenient extras `stripInlineMarkdown` does in its step 3).
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
export function stripBalancedWrappers(s) {
    if (typeof s !== "string" || s.length === 0)
        return s;
    return stripWrappersAndLinks(s);
}
/**
 * Conservatively strip inline markdown from a locator string.
 *
 * Deterministic, order-fixed steps:
 *  1. Links/images: `[text](url)` -> `text`, `![alt](src)` -> `alt`.
 *  2. Balanced inline wrappers (strong before emphasis, code, strikethrough),
 *     applied repeatedly until stable for nested cases.
 *  3. Trim leading/trailing decoration only: whitespace, leftover marker chars
 *     (`* _ ~ \``) and emoji. Letters/digits and sentence punctuation (`.`/`,`
 *     etc.) are NEVER trimmed.
 *
 * If the result is empty (e.g. the input was only markers like `***`), the
 * ORIGINAL string is returned so a locator can never normalize down to "" and
 * match everything.
 */
export function stripInlineMarkdown(s) {
    if (typeof s !== "string" || s.length === 0)
        return s;
    // 1 + 2. Shared link/image and balanced-wrapper passes.
    let out = stripWrappersAndLinks(s);
    // 3. Trim leading/trailing decoration: whitespace, leftover markdown markers,
    //    and emoji (Extended_Pictographic plus the VS16 / ZWJ joiners, plus the
    //    regional-indicator range U+1F1E6–U+1F1FF for flag emoji, which are NOT
    //    Extended_Pictographic). The `u` flag enables the Unicode property escape.
    //    Anchored runs only — interior text and sentence punctuation are untouched.
    const DECORATION = "[\\s*_~\\x60\\p{Extended_Pictographic}\\u{1F1E6}-\\u{1F1FF}\\u{FE0F}\\u{200D}]+";
    out = out
        .replace(new RegExp("^" + DECORATION, "u"), "")
        .replace(new RegExp(DECORATION + "$", "u"), "");
    // 4. Never normalize a locator down to nothing.
    if (out.length === 0)
        return s;
    return out;
}
