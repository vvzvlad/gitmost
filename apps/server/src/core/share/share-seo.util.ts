import { htmlEscape } from '../../common/helpers/html-escaper';

/**
 * Build the SEO-enriched index HTML for a publicly shared page.
 *
 * This is the pure, side-effect-free core of ShareSeoController.getShare: given
 * the raw index.html and the share's title + searchIndexing flag, it returns the
 * transformed HTML with the <title> replaced and the og:/twitter:/robots meta
 * tags injected at the <!--meta-tags--> marker.
 *
 * SECURITY: the title is attacker-influenceable (it is the shared page title),
 * so it MUST be htmlEscape'd before being interpolated into both the <title>
 * element and the content="..." attributes of the meta tags. Removing the
 * escaping would allow a page title to break out of the attribute / element and
 * inject markup into the share origin.
 */
export function buildShareMetaHtml(
  indexHtml: string,
  opts: { title: string | null; searchIndexing: boolean },
): string {
  // Escape FIRST, then truncate, so the truncation acts on the safe string and
  // can never split a multi-char HTML entity (matches the original controller).
  const rawTitle = htmlEscape(opts.title ?? 'untitled');
  const metaTitle =
    rawTitle.length > 80 ? `${rawTitle.slice(0, 77)}…` : rawTitle;

  const metaTagVar = '<!--meta-tags-->';

  const metaTags = [
    `<meta property="og:title" content="${metaTitle}" />`,
    `<meta property="twitter:title" content="${metaTitle}" />`,
    !opts.searchIndexing ? `<meta name="robots" content="noindex" />` : '',
  ]
    .filter(Boolean)
    .join('\n    ');

  return indexHtml
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${metaTitle}</title>`)
    .replace(metaTagVar, metaTags);
}
