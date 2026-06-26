// @sindresorhus/slugify ships as ESM and is not in jest's transform allowlist,
// so it cannot be imported under ts-jest here. Mock it with a deterministic
// lowercase/dash slugifier that matches the real output for the simple ASCII
// titles used in these tests (e.g. "Real Title" -> "real-title"). This keeps
// the test focused on the formatter's own slug-composition logic.
jest.mock('@sindresorhus/slugify', () => ({
  __esModule: true,
  default: (input: string) =>
    String(input)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, ''),
}));

import { load, CheerioAPI, Cheerio } from 'cheerio';
import {
  rewriteInternalLinksToMentionHtml,
  notionFormatter,
  xwikiFormatter,
  defaultHtmlFormatter,
  unwrapFromParagraph,
} from './import-formatter';

/**
 * Unit tests for import-formatter.ts. These are pure DOM transforms driven by
 * cheerio. Each test loads a snippet, runs the target function against the
 * cheerio root, and asserts the mutated markup / return value. Assertions are
 * written to fail if the corresponding branch were silently removed.
 */

type PageMeta = { id: string; title: string; slugId: string };

function makeRoot(html: string): { $: CheerioAPI; $root: Cheerio<any> } {
  const $ = load(html);
  return { $, $root: $.root() };
}

describe('rewriteInternalLinksToMentionHtml', () => {
  const creatorId = 'creator-1';
  const sourcePageId = 'source-page-1';
  const workspaceId = 'workspace-1';

  it('replaces an internal link whose text equals the page title with a mention span', async () => {
    const meta: PageMeta = {
      id: 'target-id-1',
      title: 'Design Doc',
      slugId: 'slugABC',
    };
    // currentFilePath dir is "docs"; href "./target.md" resolves to "docs/target.md"
    const map = new Map<string, PageMeta>([['docs/target.md', meta]]);
    const { $, $root } = makeRoot(
      '<a href="./target.md">Design Doc</a>',
    );

    const backlinks = await rewriteInternalLinksToMentionHtml(
      $,
      $root,
      'docs/index.md',
      map,
      creatorId,
      sourcePageId,
      workspaceId,
    );

    const $mention = $root.find('span[data-type="mention"]');
    expect($mention.length).toBe(1);
    expect($mention.attr('data-entity-type')).toBe('page');
    expect($mention.attr('data-entity-id')).toBe('target-id-1');
    expect($mention.attr('data-label')).toBe('Design Doc');
    expect($mention.attr('data-slug-id')).toBe('slugABC');
    expect($mention.attr('data-creator-id')).toBe(creatorId);
    expect($mention.attr('data-id')).toBeTruthy();
    expect($mention.text()).toBe('Design Doc');
    // original anchor must be gone
    expect($root.find('a').length).toBe(0);

    expect(backlinks).toEqual([
      { sourcePageId, targetPageId: 'target-id-1', workspaceId },
    ]);
  });

  it('rewrites href to /s/{space}/p/{slug} when text differs from the title', async () => {
    const meta: PageMeta = {
      id: 'target-id-2',
      title: 'Real Title',
      slugId: 'slug999',
    };
    const map = new Map<string, PageMeta>([['docs/target.md', meta]]);
    const { $, $root } = makeRoot(
      '<a href="./target.md">click here</a>',
    );

    const backlinks = await rewriteInternalLinksToMentionHtml(
      $,
      $root,
      'docs/index.md',
      map,
      creatorId,
      sourcePageId,
      workspaceId,
      'myspace',
    );

    // still an anchor, no mention span
    expect($root.find('span[data-type="mention"]').length).toBe(0);
    const $a = $root.find('a');
    expect($a.length).toBe(1);
    // slugify('Real Title') => 'real-title'
    expect($a.attr('href')).toBe('/s/myspace/p/real-title-slug999');
    expect($a.attr('data-internal')).toBe('true');
    expect($a.text()).toBe('click here');

    expect(backlinks).toEqual([
      { sourcePageId, targetPageId: 'target-id-2', workspaceId },
    ]);
  });

  it('uses /p/{slug} when no spaceSlug is provided', async () => {
    const meta: PageMeta = {
      id: 'target-id-3',
      title: 'Other Page',
      slugId: 'slug777',
    };
    const map = new Map<string, PageMeta>([['docs/target.md', meta]]);
    const { $, $root } = makeRoot('<a href="./target.md">label</a>');

    await rewriteInternalLinksToMentionHtml(
      $,
      $root,
      'docs/index.md',
      map,
      creatorId,
      sourcePageId,
      workspaceId,
    );

    expect($root.find('a').attr('href')).toBe('/p/other-page-slug777');
  });

  it('leaves external http and /api/ hrefs untouched and records no backlink', async () => {
    const map = new Map<string, PageMeta>();
    const { $, $root } = makeRoot(
      '<a href="https://example.com/page">ext</a><a href="/api/files/x">api</a>',
    );

    const backlinks = await rewriteInternalLinksToMentionHtml(
      $,
      $root,
      'docs/index.md',
      map,
      creatorId,
      sourcePageId,
      workspaceId,
    );

    const hrefs = $root
      .find('a')
      .map((_, el) => $(el).attr('href'))
      .get();
    expect(hrefs).toEqual(['https://example.com/page', '/api/files/x']);
    expect($root.find('a').first().attr('data-internal')).toBeUndefined();
    expect(backlinks).toEqual([]);
  });

  it('falls back without throwing on a malformed decodeURIComponent href', async () => {
    const meta: PageMeta = {
      id: 'target-id-4',
      title: 'Broken',
      slugId: 'slug000',
    };
    // The raw (un-decodable) href is what gets joined: "docs/%E0%A4%A.md".
    const map = new Map<string, PageMeta>([['docs/%E0%A4%A.md', meta]]);
    const { $, $root } = makeRoot('<a href="%E0%A4%A.md">Broken</a>');

    let backlinks: any;
    await expect(
      (async () => {
        backlinks = await rewriteInternalLinksToMentionHtml(
          $,
          $root,
          'docs/index.md',
          map,
          creatorId,
          sourcePageId,
          workspaceId,
        );
      })(),
    ).resolves.not.toThrow();

    // Because the raw path matched the map, it still produced a mention.
    expect($root.find('span[data-type="mention"]').length).toBe(1);
    expect(backlinks).toEqual([
      { sourcePageId, targetPageId: 'target-id-4', workspaceId },
    ]);
  });

  it('accumulates one backlink per resolved link', async () => {
    const a: PageMeta = { id: 'id-a', title: 'A', slugId: 's-a' };
    const b: PageMeta = { id: 'id-b', title: 'B', slugId: 's-b' };
    const map = new Map<string, PageMeta>([
      ['docs/a.md', a],
      ['docs/b.md', b],
    ]);
    const { $, $root } = makeRoot(
      '<a href="./a.md">A</a><a href="./b.md">B</a>',
    );

    const backlinks = await rewriteInternalLinksToMentionHtml(
      $,
      $root,
      'docs/index.md',
      map,
      creatorId,
      sourcePageId,
      workspaceId,
    );

    expect(backlinks).toEqual([
      { sourcePageId, targetPageId: 'id-a', workspaceId },
      { sourcePageId, targetPageId: 'id-b', workspaceId },
    ]);
  });
});

describe('notionFormatter', () => {
  it('converts a multi-column column-list to data-type="columns" with the right layout', () => {
    const html =
      '<div class="column-list">' +
      '<div class="column"><p>one</p></div>' +
      '<div class="column"><p>two</p></div>' +
      '<div class="column"><p>three</p></div>' +
      '</div>';
    const { $, $root } = makeRoot(html);

    notionFormatter($, $root);

    const $cols = $root.find('div[data-type="columns"]');
    expect($cols.length).toBe(1);
    // 3 columns => COLUMN_LAYOUTS[3] === 'three_equal'
    expect($cols.attr('data-layout')).toBe('three_equal');
    expect($root.find('div[data-type="column"]').length).toBe(3);
    // original column-list wrapper is gone
    expect($root.find('div.column-list').length).toBe(0);
  });

  it('uses two_equal layout for exactly two columns', () => {
    const html =
      '<div class="column-list">' +
      '<div class="column"><p>one</p></div>' +
      '<div class="column"><p>two</p></div>' +
      '</div>';
    const { $, $root } = makeRoot(html);

    notionFormatter($, $root);

    expect($root.find('div[data-type="columns"]').attr('data-layout')).toBe(
      'two_equal',
    );
  });

  it('converts figure.equation into a mathBlock with the tex text', () => {
    const html =
      '<figure class="equation">' +
      '<annotation encoding="application/x-tex">E = mc^2</annotation>' +
      '</figure>';
    const { $, $root } = makeRoot(html);

    notionFormatter($, $root);

    const $math = $root.find('div[data-type="mathBlock"]');
    expect($math.length).toBe(1);
    expect($math.attr('data-katex')).toBe('true');
    expect($math.text()).toBe('E = mc^2');
    expect($root.find('figure.equation').length).toBe(0);
  });

  it('converts ul.to-do-list items to a taskList with data-checked reflecting checkbox-on', () => {
    const html =
      '<ul class="to-do-list">' +
      '<li><div class="checkbox checkbox-on"></div>' +
      '<span class="to-do-children-checked">done item</span></li>' +
      '<li><div class="checkbox checkbox-off"></div>' +
      '<span class="to-do-children-unchecked">open item</span></li>' +
      '</ul>';
    const { $, $root } = makeRoot(html);

    notionFormatter($, $root);

    const $list = $root.find('ul[data-type="taskList"]');
    expect($list.length).toBe(1);
    const $items = $list.find('li[data-type="taskItem"]');
    expect($items.length).toBe(2);
    expect($items.eq(0).attr('data-checked')).toBe('true');
    expect($items.eq(1).attr('data-checked')).toBe('false');
    // checked item has a checked input; unchecked does not
    expect($items.eq(0).find('input[checked]').length).toBe(1);
    expect($items.eq(1).find('input[checked]').length).toBe(0);
    // text is carried over
    expect($items.eq(0).find('p').text()).toBe('done item');
    expect($items.eq(1).find('p').text()).toBe('open item');
  });
});

describe('xwikiFormatter', () => {
  it('replaces the root with the contents of #xwikicontent when present', () => {
    const html =
      '<div id="header">junk</div>' +
      '<div id="xwikicontent"><p>real body</p><h2>heading</h2></div>';
    const { $, $root } = makeRoot(html);

    xwikiFormatter($, $root);

    expect($root.find('#header').length).toBe(0);
    expect($root.find('#xwikicontent').length).toBe(0);
    expect($root.find('p').text()).toBe('real body');
    expect($root.find('h2').text()).toBe('heading');
  });

  it('leaves HTML without #xwikicontent unchanged', () => {
    const html = '<div id="header">junk</div><p>body</p>';
    const { $, $root } = makeRoot(html);
    const before = $root.html();

    xwikiFormatter($, $root);

    expect($root.html()).toBe(before);
  });
});

describe('defaultHtmlFormatter', () => {
  it('replaces a recognized provider anchor with a data-type="embed" div', () => {
    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const { $, $root } = makeRoot(`<a href="${url}">video</a>`);

    defaultHtmlFormatter($, $root);

    const $embed = $root.find('div[data-type="embed"]');
    expect($embed.length).toBe(1);
    expect($embed.attr('data-provider')).toBe('youtube');
    expect($embed.attr('data-src')).toBe(url);
    // the anchor is gone
    expect($root.find('a').length).toBe(0);
  });

  it('leaves an anchor as a link when provider resolves to iframe', () => {
    // A plain non-provider URL falls through to the default iframe provider,
    // which the formatter explicitly skips.
    const url = 'https://example.com/some/page';
    const { $, $root } = makeRoot(`<a href="${url}">site</a>`);

    defaultHtmlFormatter($, $root);

    expect($root.find('div[data-type="embed"]').length).toBe(0);
    const $a = $root.find('a');
    expect($a.length).toBe(1);
    expect($a.attr('href')).toBe(url);
  });
});

describe('unwrapFromParagraph', () => {
  it('replaces the wrapper entirely when the node is the only child of a <p>', () => {
    const { $, $root } = makeRoot('<p><img src="x.png"></p>');
    const $node = $root.find('img');

    unwrapFromParagraph($, $node);

    // the <p> wrapper is gone, the img is hoisted to the root
    expect($root.find('p').length).toBe(0);
    expect($root.find('img').length).toBe(1);
  });

  it('moves the node before the wrapper when there are sibling contents', () => {
    const { $, $root } = makeRoot('<p>text before <img src="x.png"></p>');
    const $node = $root.find('img');

    unwrapFromParagraph($, $node);

    // img moved out; the paragraph still holds the sibling text
    const html = $root.html() || '';
    // img must appear before the paragraph in document order
    const imgIndex = html.indexOf('<img');
    const pIndex = html.indexOf('<p');
    expect(imgIndex).toBeGreaterThanOrEqual(0);
    expect(pIndex).toBeGreaterThanOrEqual(0);
    expect(imgIndex).toBeLessThan(pIndex);
    expect($root.find('p').text()).toContain('text before');
  });

  it('returns (does not infinite-loop) on adversarial nesting', () => {
    // Node wrapped in nested <a> and <p> wrappers.
    const { $, $root } = makeRoot(
      '<p><a href="#"><img src="x.png"></a></p>',
    );
    const $node = $root.find('img');

    // If unwrapFromParagraph looped forever this call would hang the test.
    expect(() => unwrapFromParagraph($, $node)).not.toThrow();
    // It fully unwrapped: no surrounding p/a left around the img.
    expect($node.closest('p, a').length).toBe(0);
    expect($root.find('img').length).toBe(1);
  });
});
