/**
 * Injects an admin-authored analytics/tracker snippet verbatim into the
 * <head> of a public-share page.
 *
 * `trackerHead` is admin-only trusted content (writable only via the
 * admin-gated workspace settings) and must be inserted BYTE-FOR-BYTE before the
 * first `</head>` marker. A plain string replacement would interpret `$&`,
 * `$$`, `` $` `` and `$'` inside the snippet as substitution patterns and mangle
 * the tracker, so a FUNCTION replacer is used: its return value is inserted
 * literally with no special-pattern interpretation.
 *
 * The snippet is deliberately NOT escaped (it is trusted HTML/JS). Returns the
 * html unchanged when:
 *   - trackerHead is undefined / empty / whitespace-only, or
 *   - there is no `</head>` marker to anchor the injection.
 */
export function injectTrackerHead(
  html: string,
  trackerHead: string | undefined,
): string {
  if (typeof trackerHead !== 'string' || trackerHead.trim().length === 0) {
    return html;
  }
  if (!html.includes('</head>')) {
    return html;
  }
  // Function replacer: the return value is inserted literally, so `$&`/`$$`/
  // `` $` ``/`$'` in the admin snippet are NOT treated as substitution patterns.
  return html.replace('</head>', () => `${trackerHead}\n</head>`);
}
