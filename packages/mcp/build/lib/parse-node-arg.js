// The model sometimes serializes a ProseMirror node arg as a JSON string
// instead of an object. Normalize: parse a string to an object (throwing on
// invalid JSON), pass an object through unchanged. Shared by patch_node /
// insert_node (and the analogous update_page_json content parsing).
export function parseNodeArg(node, errMsg = "node was a string but not valid JSON") {
    if (typeof node === "string") {
        try {
            return JSON.parse(node);
        }
        catch {
            throw new Error(errMsg);
        }
    }
    return node;
}
