// Detection + collection of INTERNAL Docmost file URLs inside a ProseMirror doc.
//
// An internal file URL is a relative path served by Docmost's authenticated
// attachment route (`GET /api/files/:fileId/:fileName`). It is useless to an
// external consumer (relative + needs a Docmost session), so the stash tool
// mirrors every such resource into the blob sandbox and rewrites its `src`.
//
// The criterion is "internal file URL", NOT the node TYPE: image, drawio,
// excalidraw, video and file nodes all carry such a `src`, so a type-agnostic
// walker covers them all. External http(s) srcs (CDNs) are left untouched.
//
// Mirrors editor-ext's isInternalFileUrl / normalizeFileUrl (kept as a local
// dup so the ESM mcp package does not depend on the editor-ext build).
export function isInternalFileUrl(url) {
    if (typeof url !== "string")
        return false;
    const normalized = url.trim();
    return (normalized.startsWith("/api/files/") || normalized.startsWith("/files/"));
}
/** Normalize a bare `/files/...` src to the canonical `/api/files/...` form. */
export function normalizeFileUrl(src) {
    const trimmed = src.trim();
    if (trimmed.startsWith("/files/"))
        return "/api" + trimmed;
    return trimmed;
}
/**
 * Recursively collect every node whose `attrs.src` is an internal file URL.
 * Returns references to the live nodes (so the caller can rewrite `attrs.src`
 * in place on its clone). Descends `content` arrays, covering callouts, tables,
 * details and any other nested container.
 */
export function collectInternalFileNodes(doc) {
    const out = [];
    const visit = (node) => {
        if (!node)
            return;
        if (Array.isArray(node)) {
            for (const child of node)
                visit(child);
            return;
        }
        if (typeof node !== "object")
            return;
        if (node.attrs && isInternalFileUrl(node.attrs.src)) {
            out.push(node);
        }
        if (Array.isArray(node.content)) {
            for (const child of node.content)
                visit(child);
        }
    };
    visit(doc);
    return out;
}
