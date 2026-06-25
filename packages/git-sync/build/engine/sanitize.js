/**
 * Deterministic filename strategy (SPEC §12).
 *
 * The file name is COSMETIC — the source of truth for the file<->page link is
 * `pageId` / `slugId` inside the meta block, so renaming a file is safe. These
 * functions are intentionally dependency-free and pure, so they are trivially
 * unit-testable.
 */
// Printable characters forbidden in file names on common filesystems (mainly
// Windows): / \ < > : " | ? *. Each match is replaced with a single "-".
// Spaces are NOT in this set; whitespace is normalized separately below.
// ASCII control characters (code points 0..31) are stripped in a separate pass
// (see stripControlChars) to keep this literal free of embedded control bytes.
const FORBIDDEN_PRINTABLE_RE = /[/\\<>:"|?*]/g;
// Runs of whitespace (including tabs/newlines) collapse to a single space.
const WHITESPACE_RUN_RE = /\s+/g;
// Reserved Windows device names (case-insensitive). A bare match (with or
// without an extension) is unusable as a file name, so it is prefixed with "_".
const RESERVED_WINDOWS_NAMES = new Set([
    "con",
    "prn",
    "aux",
    "nul",
    "com1",
    "com2",
    "com3",
    "com4",
    "com5",
    "com6",
    "com7",
    "com8",
    "com9",
    "lpt1",
    "lpt2",
    "lpt3",
    "lpt4",
    "lpt5",
    "lpt6",
    "lpt7",
    "lpt8",
    "lpt9",
]);
// Cap on the sanitized length to stay well within filesystem path-component
// limits (255 bytes on most FSes) while leaving room for an extension and a
// disambiguation suffix.
const MAX_LENGTH = 120;
/**
 * Replace every ASCII control character (code points 0..31) with "-". Done by
 * scanning code points rather than a control-range regex literal, so the source
 * file carries no embedded control bytes.
 */
function stripControlChars(input) {
    let out = "";
    for (let i = 0; i < input.length; i++) {
        out += input.charCodeAt(i) < 32 ? "-" : input[i];
    }
    return out;
}
/**
 * Sanitize a page title into a safe file-name component (WITHOUT extension).
 *
 * Steps: replace forbidden / control characters with "-", collapse whitespace
 * runs to a single space, trim, cap the length, then guard against an empty
 * result, an all-dots result, or a reserved Windows device name by prefixing
 * with "_".
 */
export function sanitizeTitle(title) {
    let name = stripControlChars(title ?? "")
        .replace(FORBIDDEN_PRINTABLE_RE, "-")
        .replace(WHITESPACE_RUN_RE, " ")
        .trim();
    if (name.length > MAX_LENGTH) {
        name = name.slice(0, MAX_LENGTH).trim();
    }
    // Compare the base name (before the first dot) against reserved names, so
    // both "CON" and "con.md" are caught.
    const base = name.split(".")[0]?.toLowerCase() ?? "";
    // A name that is empty, consists only of dots ("." / ".." / "..."), or is a
    // reserved Windows device name is unusable as a path component. The all-dots
    // case is a path-traversal hazard in particular: an unprefixed ".." would
    // become a parent-directory segment and let a page escape the vault, so it
    // MUST be neutralized here (becomes "_..", which is a literal file name).
    if (name.length === 0 ||
        /^\.+$/.test(name) ||
        RESERVED_WINDOWS_NAMES.has(base)) {
        name = "_" + name;
    }
    return name;
}
/**
 * Disambiguate a sanitized name when two siblings in the same folder collapse
 * to the same name. Appends a stable suffix built from the page's `slugId`, so
 * the result stays deterministic across runs (SPEC §12: `Title ~slugId`).
 */
export function disambiguate(name, slugId) {
    return `${name} ~${slugId}`;
}
