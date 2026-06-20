import { collectPageEmbedsFromPmJson } from '../utils/transclusion-prosemirror.util';
import {
  htmlToJson,
  jsonToHtml,
} from '../../../../collaboration/collaboration.util';

describe('collectPageEmbedsFromPmJson', () => {
  it('returns [] for null/undefined doc', () => {
    expect(collectPageEmbedsFromPmJson(null)).toEqual([]);
    expect(collectPageEmbedsFromPmJson(undefined)).toEqual([]);
  });

  it('returns [] for a doc with no pageEmbed nodes', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }],
    };
    expect(collectPageEmbedsFromPmJson(doc)).toEqual([]);
  });

  it('extracts a top-level pageEmbed', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'pageEmbed', attrs: { sourcePageId: 'p1' } }],
    };
    expect(collectPageEmbedsFromPmJson(doc)).toEqual([{ sourcePageId: 'p1' }]);
  });

  it('skips pageEmbed nodes missing sourcePageId', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'pageEmbed', attrs: {} },
        { type: 'pageEmbed', attrs: { sourcePageId: '' } },
      ],
    };
    expect(collectPageEmbedsFromPmJson(doc)).toEqual([]);
  });

  it('dedupes identical sourcePageIds, first-seen order preserved', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'pageEmbed', attrs: { sourcePageId: 'p1' } },
        { type: 'pageEmbed', attrs: { sourcePageId: 'p2' } },
        { type: 'pageEmbed', attrs: { sourcePageId: 'p1' } },
      ],
    };
    expect(collectPageEmbedsFromPmJson(doc)).toEqual([
      { sourcePageId: 'p1' },
      { sourcePageId: 'p2' },
    ]);
  });

  it('finds pageEmbed nested in other block containers (column)', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'column',
          content: [{ type: 'pageEmbed', attrs: { sourcePageId: 'nested' } }],
        },
      ],
    };
    expect(collectPageEmbedsFromPmJson(doc)).toEqual([
      { sourcePageId: 'nested' },
    ]);
  });

  it('does not descend into a transclusion source', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'transclusionSource',
          attrs: { id: 'src' },
          content: [{ type: 'pageEmbed', attrs: { sourcePageId: 'hidden' } }],
        },
      ],
    };
    expect(collectPageEmbedsFromPmJson(doc)).toEqual([]);
  });
});

describe('pageEmbed HTML <-> JSON round-trip (server schema)', () => {
  it('preserves sourcePageId across jsonToHtml -> htmlToJson', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'before' }] },
        { type: 'pageEmbed', attrs: { sourcePageId: 'abc-123' } },
      ],
    };

    const html = jsonToHtml(doc);
    expect(html).toContain('data-source-page-id="abc-123"');

    const back = htmlToJson(html);
    const embeds = collectPageEmbedsFromPmJson(back);
    expect(embeds).toEqual([{ sourcePageId: 'abc-123' }]);
  });
});
