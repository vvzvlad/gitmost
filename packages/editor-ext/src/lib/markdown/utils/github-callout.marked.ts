import { Token, marked } from 'marked';
import { renderCalloutHtml } from './callout-common.marked';

interface GithubCalloutToken {
  type: 'githubCallout';
  calloutType: string;
  text: string;
  raw: string;
}

/**
 * Map GitHub "alert" blockquote markers (`> [!NOTE]`, `> [!WARNING]`, …) onto
 * the four callout banner types the editor schema supports. The editor's own
 * type names (`info`/`success`/`warning`/`danger`) are also accepted directly,
 * because users paste both forms. Anything unrecognized falls back to `info`,
 * matching the `:::type` callout tokenizer.
 */
const GITHUB_ALERT_TYPE_MAP: Record<string, string> = {
  note: 'info',
  tip: 'success',
  important: 'info',
  warning: 'warning',
  caution: 'danger',
  info: 'info',
  success: 'success',
  danger: 'danger',
};

/**
 * Tokenizer for GitHub-flavored alert callouts written as a blockquote whose
 * first line is `[!type]`:
 *
 *   > [!info]
 *   > body line one
 *   > body line two
 *
 * Without this, the default blockquote tokenizer wins and the marker renders as
 * a literal `[!info]` inside a `<blockquote>`. The editor's paste path runs the
 * same `markdownToHtml`, so registering this here also fixes pasting the syntax
 * into the editor (issue #192), not just markdown import.
 */
export const githubCalloutExtension = {
  name: 'githubCallout',
  level: 'block' as const,
  start(src: string) {
    return src.match(/^ {0,3}>[ \t]*\[!/m)?.index ?? -1;
  },
  tokenizer(src: string): GithubCalloutToken | undefined {
    const rule =
      /^ {0,3}>[ \t]*\[!([a-zA-Z]+)\][^\n]*(?:\n {0,3}>[^\n]*)*(?:\n|$)/;
    const match = rule.exec(src);
    if (!match) return undefined;

    const rawType = match[1].toLowerCase();
    const calloutType = GITHUB_ALERT_TYPE_MAP[rawType] ?? 'info';

    const text = match[0]
      .replace(/\n+$/, '')
      .split('\n')
      // Strip the blockquote marker (`>` + optional space) from every line.
      .map((line) => line.replace(/^ {0,3}>[ \t]?/, ''))
      // Drop the `[!type]` marker that opens the first line.
      .map((line, i) => (i === 0 ? line.replace(/^\[![a-zA-Z]+\][ \t]*/, '') : line))
      .join('\n')
      .trim();

    return {
      type: 'githubCallout',
      calloutType,
      raw: match[0],
      text,
    };
  },
  renderer(token: Token) {
    const calloutToken = token as GithubCalloutToken;
    return renderCalloutHtml(
      calloutToken.calloutType,
      marked.parse(calloutToken.text),
    );
  },
};
