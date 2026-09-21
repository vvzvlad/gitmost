// The model sometimes serializes a ProseMirror node arg as a JSON string
// instead of an object. Normalize: parse a string to an object (throwing on
// invalid JSON), pass an object through unchanged. Shared by patchNode /
// insertNode (and the analogous updatePageJson content parsing).
//
// This lives in the converter package (#414) so BOTH consumers import the ONE
// copy: `@docmost/mcp` (ESM) and the CommonJS server app. The server cannot
// import `@docmost/mcp` directly (ESM-only, no declaration files), but it does
// import `@docmost/prosemirror-markdown` natively — so this is the shared home.
export function parseNodeArg(
  node: unknown,
  errMsg = "node was a string but not valid JSON",
): unknown {
  if (typeof node === "string") {
    try {
      return JSON.parse(node);
    } catch {
      throw new Error(errMsg);
    }
  }
  return node;
}
