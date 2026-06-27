/**
 * Shared pieces for the two callout tokenizers — `callout.marked.ts` (the
 * `:::type` fenced form) and `github-callout.marked.ts` (the `> [!type]` GitHub
 * alert form). Both emit the SAME callout node, so the banner type dictionary
 * and the HTML renderer live here once instead of drifting apart in two files.
 * The tokenizers themselves stay separate (different syntaxes / source matching).
 */

/** The four callout banner types the editor schema supports. */
export const CALLOUT_TYPES = ['info', 'success', 'warning', 'danger'] as const;

export type CalloutType = (typeof CALLOUT_TYPES)[number];

/**
 * Coerce an arbitrary type name onto a supported banner type, defaulting to
 * `info` for anything unrecognized (the shared fallback both tokenizers use).
 */
export function normalizeCalloutType(type: string): CalloutType {
  return (CALLOUT_TYPES as readonly string[]).includes(type)
    ? (type as CalloutType)
    : 'info';
}

/**
 * Render a callout node to the editor's HTML shape. `body` is the already
 * markdown-parsed inner content (marked may hand back a string synchronously).
 */
export function renderCalloutHtml(
  type: string,
  body: string | Promise<string>,
): string {
  return `<div data-type="callout" data-callout-type="${type}">${body}</div>`;
}
