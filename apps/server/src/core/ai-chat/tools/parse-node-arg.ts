// The model sometimes serializes a ProseMirror node arg as a JSON string
// instead of an object. Normalize: parse a string to an object (throwing on
// invalid JSON), pass an object through unchanged. Shared by patchNode /
// insertNode (and the analogous updatePageJson content parsing).
//
// This mirrors `packages/mcp/src/lib/parse-node-arg.ts` byte-for-byte. We
// cannot import that helper here: `@docmost/mcp` is ESM-only and this server
// compiles with module:commonjs, so it is loaded at runtime via the
// `new Function('import()')` trick (see docmost-client.loader.ts). Sharing
// runtime code across that ESM/CJS boundary by a normal import is impossible,
// hence the mirrored copy.
export function parseNodeArg(
  node: unknown,
  errMsg = 'node was a string but not valid JSON',
): unknown {
  if (typeof node === 'string') {
    try {
      return JSON.parse(node);
    } catch {
      throw new Error(errMsg);
    }
  }
  return node;
}
