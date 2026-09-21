import { parseNodeArg } from '@docmost/prosemirror-markdown';

/**
 * Unit tests for the shared `parseNodeArg` helper (#414: now the single copy in
 * `@docmost/prosemirror-markdown`, imported by both the server tool adapters and
 * `@docmost/mcp`). Used by the patchNode / insertNode / updatePageJson adapters.
 * Behavior: object passthrough, valid-string parse, invalid-string throw.
 */
describe('parseNodeArg', () => {
  it('passes an object through unchanged', () => {
    const obj = { type: 'paragraph', content: [] };
    expect(parseNodeArg(obj)).toBe(obj);
  });

  it('passes undefined/null through unchanged', () => {
    expect(parseNodeArg(undefined)).toBeUndefined();
    expect(parseNodeArg(null)).toBeNull();
  });

  it('parses a valid JSON string into an object', () => {
    expect(parseNodeArg('{"type":"paragraph"}')).toEqual({
      type: 'paragraph',
    });
  });

  it('throws the default message on an invalid JSON string', () => {
    expect(() => parseNodeArg('{not json')).toThrow(
      'node was a string but not valid JSON',
    );
  });

  it('throws a custom message on an invalid JSON string', () => {
    expect(() =>
      parseNodeArg('{not json', 'content was a string but not valid JSON'),
    ).toThrow('content was a string but not valid JSON');
  });
});
