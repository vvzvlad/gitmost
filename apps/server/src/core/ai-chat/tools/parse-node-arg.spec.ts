import { parseNodeArg } from './parse-node-arg';

/**
 * Unit tests for the in-app `parseNodeArg` helper. It mirrors the standalone
 * MCP helper (packages/mcp/src/lib/parse-node-arg.ts) and is used by the
 * patchNode / insertNode / updatePageJson tool adapters. Behavior must be
 * byte-identical: object passthrough, valid-string parse, invalid-string throw.
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
