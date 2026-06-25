/**
 * Deterministic filename strategy (SPEC §12).
 *
 * The file name is COSMETIC — the source of truth for the file<->page link is
 * `pageId` / `slugId` inside the meta block, so renaming a file is safe. These
 * functions are intentionally dependency-free and pure, so they are trivially
 * unit-testable.
 */
/**
 * Sanitize a page title into a safe file-name component (WITHOUT extension).
 *
 * Steps: replace forbidden / control characters with "-", collapse whitespace
 * runs to a single space, trim, cap the length, then guard against an empty
 * result, an all-dots result, or a reserved Windows device name by prefixing
 * with "_".
 */
export declare function sanitizeTitle(title: string): string;
/**
 * Disambiguate a sanitized name when two siblings in the same folder collapse
 * to the same name. Appends a stable suffix built from the page's `slugId`, so
 * the result stays deterministic across runs (SPEC §12: `Title ~slugId`).
 */
export declare function disambiguate(name: string, slugId: string): string;
