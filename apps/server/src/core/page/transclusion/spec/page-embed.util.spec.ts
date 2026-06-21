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

  it('ignores a pageEmbed whose sourcePageId is not a string', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'pageEmbed', attrs: { sourcePageId: 123 as any } },
        { type: 'pageEmbed', attrs: { sourcePageId: null as any } },
        { type: 'pageEmbed', attrs: { sourcePageId: { nested: true } as any } },
        { type: 'pageEmbed', attrs: { sourcePageId: ['arr'] as any } },
        // a valid one mixed in proves only the bad ones are dropped
        { type: 'pageEmbed', attrs: { sourcePageId: 'good' } },
      ],
    };
    expect(collectPageEmbedsFromPmJson(doc)).toEqual([
      { sourcePageId: 'good' },
    ]);
  });

  it('collects a pageEmbed nested under multiple block containers', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'callout',
          content: [
            {
              type: 'columns',
              content: [
                {
                  type: 'column',
                  content: [
                    {
                      type: 'details',
                      content: [
                        {
                          type: 'pageEmbed',
                          attrs: { sourcePageId: 'deep' },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(collectPageEmbedsFromPmJson(doc)).toEqual([{ sourcePageId: 'deep' }]);
  });

  it('returns gracefully (does not throw) on a self-referencing/cyclic object', () => {
    // A depth guard (see MAX_PM_WALK_DEPTH) defends against a hand-built cyclic
    // JS object — which cannot arise from JSON parsing, the real input path —
    // so the recursive walk stops at the cap instead of overflowing the stack.
    // A non-cyclic (JSON-shaped) document is never affected.
    const node: any = { type: 'doc', content: [] };
    node.content.push(node); // content array references its own parent node
    let got: ReturnType<typeof collectPageEmbedsFromPmJson>;
    expect(() => {
      got = collectPageEmbedsFromPmJson(node);
    }).not.toThrow();
    expect(got!).toEqual([]);
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
