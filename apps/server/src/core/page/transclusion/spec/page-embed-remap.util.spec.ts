import {
  remapPageEmbedSourceId,
  remapPageEmbedSourceIds,
} from '../utils/transclusion-prosemirror.util';

/**
 * Unit tests for the `pageEmbed` remap used by `PageService.duplicatePage`:
 *
 *   - source page within the copied set  -> rewrite to the COPY's new id
 *   - source page NOT in the copied set   -> keep the ORIGINAL id (live embed)
 *
 * `remapPageEmbedSourceId` is the per-node decision the production
 * `duplicatePage` callback now calls directly, so these tests guard the real
 * path rather than a parallel copy. `remapPageEmbedSourceIds` is the JSON
 * walker that delegates to the same helper; its tests exercise the shared
 * decision transitively across nested ProseMirror containers.
 */
describe('remapPageEmbedSourceId (shared per-node decision used by duplicatePage)', () => {
  it('returns the new copy id when the source IS in the copied set', () => {
    const idMap = new Map([['old-src', 'new-copy']]);

    const out = remapPageEmbedSourceId('old-src', (id) => idMap.get(id));

    expect(out).toBe('new-copy');
  });

  it('returns the original id when the source is NOT in the copied set', () => {
    const idMap = new Map([['old-src', 'new-copy']]);

    const out = remapPageEmbedSourceId('external', (id) => idMap.get(id));

    expect(out).toBe('external');
  });

  it('returns the original id when resolveNewId yields undefined', () => {
    const out = remapPageEmbedSourceId('some-id', () => undefined);

    expect(out).toBe('some-id');
  });

  it('leaves a null source unchanged without consulting the resolver', () => {
    const resolve = jest.fn(() => 'should-not-be-used');

    const out = remapPageEmbedSourceId(null, resolve);

    expect(out).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('leaves an undefined source unchanged without consulting the resolver', () => {
    const resolve = jest.fn(() => 'should-not-be-used');

    const out = remapPageEmbedSourceId(undefined, resolve);

    expect(out).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('remapPageEmbedSourceIds (duplicatePage pageEmbed remap)', () => {
  const docWithEmbeds = (ids: string[]) => ({
    type: 'doc',
    content: ids.map((id) => ({
      type: 'pageEmbed',
      attrs: { sourcePageId: id },
    })),
  });

  it('remaps a source that IS within the copied set to its new copy id', () => {
    const doc = docWithEmbeds(['old-src']);
    const idMap = new Map([['old-src', 'new-copy']]);

    const out = remapPageEmbedSourceIds(doc, idMap);

    expect(out.content[0].attrs.sourcePageId).toBe('new-copy');
  });

  it('keeps the original id for a source NOT in the copied set', () => {
    const doc = docWithEmbeds(['external']);
    const idMap = new Map([['old-src', 'new-copy']]); // does not contain "external"

    const out = remapPageEmbedSourceIds(doc, idMap);

    expect(out.content[0].attrs.sourcePageId).toBe('external');
  });

  it('handles a mixed doc: in-set remapped, out-of-set preserved', () => {
    const doc = docWithEmbeds(['in-set', 'external']);
    const idMap = new Map([['in-set', 'in-set-copy']]);

    const out = remapPageEmbedSourceIds(doc, idMap);

    expect(out.content.map((n: any) => n.attrs.sourcePageId)).toEqual([
      'in-set-copy',
      'external',
    ]);
  });

  it('remaps pageEmbeds nested inside columns', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'columnList',
          content: [
            {
              type: 'column',
              content: [
                { type: 'pageEmbed', attrs: { sourcePageId: 'nested-in' } },
              ],
            },
            {
              type: 'column',
              content: [
                { type: 'pageEmbed', attrs: { sourcePageId: 'nested-out' } },
              ],
            },
          ],
        },
      ],
    };
    const idMap = new Map([['nested-in', 'nested-in-copy']]);

    const out = remapPageEmbedSourceIds(doc, idMap) as any;

    const col0 = out.content[0].content[0].content[0];
    const col1 = out.content[0].content[1].content[0];
    expect(col0.attrs.sourcePageId).toBe('nested-in-copy');
    expect(col1.attrs.sourcePageId).toBe('nested-out');
  });

  it('remaps pageEmbeds nested inside a callout', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'callout',
          content: [
            { type: 'pageEmbed', attrs: { sourcePageId: 'in-callout' } },
          ],
        },
      ],
    };
    const idMap = new Map([['in-callout', 'in-callout-copy']]);

    const out = remapPageEmbedSourceIds(doc, idMap) as any;

    expect(out.content[0].content[0].attrs.sourcePageId).toBe(
      'in-callout-copy',
    );
  });

  it('does not descend into a transclusionSource (schema-isolated)', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'transclusionSource',
          attrs: { id: 'src' },
          content: [
            { type: 'pageEmbed', attrs: { sourcePageId: 'hidden' } },
          ],
        },
      ],
    };
    const idMap = new Map([['hidden', 'should-not-apply']]);

    const out = remapPageEmbedSourceIds(doc, idMap) as any;

    // The embed inside a source must be left untouched.
    expect(out.content[0].content[0].attrs.sourcePageId).toBe('hidden');
  });

  it('leaves embeds missing a sourcePageId untouched', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'pageEmbed', attrs: {} },
        { type: 'pageEmbed', attrs: { sourcePageId: '' } },
      ],
    };
    const idMap = new Map([['', 'x']]);

    const out = remapPageEmbedSourceIds(doc, idMap) as any;

    expect(out.content[0].attrs.sourcePageId).toBeUndefined();
    expect(out.content[1].attrs.sourcePageId).toBe('');
  });

  it('returns the doc unchanged when idMap is empty', () => {
    const doc = docWithEmbeds(['a', 'b']);

    const out = remapPageEmbedSourceIds(doc, new Map());

    expect(out.content.map((n: any) => n.attrs.sourcePageId)).toEqual([
      'a',
      'b',
    ]);
  });
});
