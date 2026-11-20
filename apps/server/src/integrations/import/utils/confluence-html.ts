import { load } from 'cheerio';
import { posix } from 'node:path';
import { getMimeType } from '../../../common/helpers/file.helper';

export function getConfluenceParents(
  html: string,
  indexPath: string,
  pagePaths: ReadonlySet<string>,
): Map<string, string> {
  const $ = load(html);
  const links = new Map<object, string>();
  for (const anchor of $('li a[href]').toArray()) {
    const target = $(anchor).attr('href').split(/[?#]/, 1)[0];
    if (!target || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(target)) continue;
    try {
      const file = posix.join(
        posix.dirname(indexPath),
        decodeURIComponent(target),
      );
      const item = $(anchor).closest('li').get(0);
      if (item && pagePaths.has(file) && !links.has(item))
        links.set(item, file);
    } catch {
      // Ignore malformed hrefs in the generated index.
    }
  }

  const parents = new Map<string, string>();
  for (const item of $('li').toArray()) {
    const child = links.get(item);
    if (!child || parents.has(child)) continue;
    const parent = $(item)
      .parents('li')
      .toArray()
      .map((ancestor) => links.get(ancestor))
      .find(Boolean);
    if (!parent || parent === child) continue;
    const visited = new Set([child]);
    let cursor = parent;
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      cursor = parents.get(cursor);
    }
    if (!cursor) parents.set(child, parent);
  }
  return parents;
}

export function extractConfluencePage(html: string): {
  title: string;
  html: string;
  attachments: { href: string; fileName: string; mimeType: string }[];
} {
  const $ = load(html);
  const title =
    $('#title-text').first().text().trim() || $('title').first().text().trim();
  const attachments = $('.pageSection a[href]')
    .toArray()
    .flatMap((link) => {
      const href = $(link).attr('href');
      const fileName = $(link).text().trim();
      if (!/^(?:\.\/)?attachments\//i.test(href) || !fileName) return [];
      return [{ href, fileName, mimeType: getMimeType(fileName) }];
    });
  const body = $('#main-content, .wiki-content').first();
  if (!body.length) return { title, html, attachments };
  body.find('script, style, .page-metadata, .pageSection').remove();
  return { title, html: body.html() ?? '', attachments };
}
