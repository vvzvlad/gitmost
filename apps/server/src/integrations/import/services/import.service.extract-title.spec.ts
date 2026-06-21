// Importing ImportService transitively loads import-formatter.ts, which imports
// the ESM-only @sindresorhus/slugify package (not in jest's transform
// allowlist). slugify is irrelevant to the method under test, so it is mocked
// out to keep the module graph loadable under ts-jest.
jest.mock('@sindresorhus/slugify', () => ({
  __esModule: true,
  default: (input: string) => String(input),
}));

import { ImportService } from './import.service';

/**
 * Unit tests for ImportService.extractTitleAndRemoveHeading — a pure method
 * (no `this`, no I/O). It pulls a leading level-1 heading out of a ProseMirror
 * document, returning its text as the title and the remaining content, and
 * guarantees at least one paragraph remains.
 *
 * The method does not touch the injected deps, so the service is constructed
 * with placeholder dependencies.
 */

function makeService(): ImportService {
  // The method under test never references `this`/injected deps.
  return new ImportService({} as any, {} as any, {} as any, {} as any);
}

describe('ImportService.extractTitleAndRemoveHeading', () => {
  const service = makeService();

  it('extracts a leading H1 as the title and removes the heading from content', () => {
    const state = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: 'My Title' }],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'body' }] },
      ],
    };

    const result = service.extractTitleAndRemoveHeading(state);

    expect(result.title).toBe('My Title');
    // heading removed, only the paragraph remains
    expect(result.prosemirrorJson.content).toHaveLength(1);
    expect(result.prosemirrorJson.content[0].type).toBe('paragraph');
    expect(result.prosemirrorJson.content[0].content[0].text).toBe('body');
    // doc type preserved via spread
    expect(result.prosemirrorJson.type).toBe('doc');
  });

  it('returns a null title and keeps content when there is no leading H1', () => {
    const state = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'first' }] },
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: 'Later Heading' }],
        },
      ],
    };

    const result = service.extractTitleAndRemoveHeading(state);

    expect(result.title).toBeNull();
    // nothing removed
    expect(result.prosemirrorJson.content).toHaveLength(2);
    expect(result.prosemirrorJson.content[0].type).toBe('paragraph');
  });

  it('does not treat a level-2 heading as a title', () => {
    const state = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'Subheading' }],
        },
      ],
    };

    const result = service.extractTitleAndRemoveHeading(state);

    expect(result.title).toBeNull();
    expect(result.prosemirrorJson.content).toHaveLength(1);
    expect(result.prosemirrorJson.content[0].type).toBe('heading');
  });

  it('injects one empty paragraph when the content becomes empty', () => {
    // A document that is just a single H1 -> after removal, content is empty
    // and one empty paragraph is injected.
    const state = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: 'Only Title' }],
        },
      ],
    };

    const result = service.extractTitleAndRemoveHeading(state);

    expect(result.title).toBe('Only Title');
    expect(result.prosemirrorJson.content).toEqual([
      { type: 'paragraph', content: [] },
    ]);
  });

  it('injects an empty paragraph for an already-empty document', () => {
    const state = { type: 'doc', content: [] };

    const result = service.extractTitleAndRemoveHeading(state);

    expect(result.title).toBeNull();
    expect(result.prosemirrorJson.content).toEqual([
      { type: 'paragraph', content: [] },
    ]);
  });

  it('yields a null title when an H1 has no text node', () => {
    const state = {
      type: 'doc',
      content: [{ type: 'heading', attrs: { level: 1 }, content: [] }],
    };

    const result = service.extractTitleAndRemoveHeading(state);

    expect(result.title).toBeNull();
    // heading removed, empty paragraph injected
    expect(result.prosemirrorJson.content).toEqual([
      { type: 'paragraph', content: [] },
    ]);
  });
});
