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
    let out = s;
    // 1. Links/images -> their visible text. `!?` covers both forms.
    out = out.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
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
