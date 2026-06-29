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
function isInternalFileUrl(url) {
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
 * Resolve a page-content `src` into the safe, `/api`-relative path the stash
 * tool may fetch over the authenticated loopback client — or THROW.
 *
 * SECURITY (SSRF / path-traversal): `src` comes from page content and is fully
 * attacker-controllable. The mirroring fetch runs through the AUTHENTICATED
 * loopback axios client whose baseURL ends in `/api`, so a naive
 * `src.replace(/^\/api/, "")` lets a crafted value like
 * `/api/files/../auth/whoami` collapse (via axios/WHATWG URL `..` resolution)
 * into an ARBITRARY internal GET endpoint, whose authed response would then be
 * stored in the anonymous sandbox (SSRF + data exfiltration). A prefix-only
 * `startsWith("/api/files/")` check does NOT defend against this because the
 * `..` segments are still present in the raw string and resolved later.
 *
 * This function defeats that by resolving the canonical pathname FIRST and only
 * then asserting it still lives under `/api/files/`:
 *  - it rejects any percent-encoded dot/slash (`%2e` / `%2f`): the WHATWG URL
 *    parser collapses LITERAL `../` but does NOT decode `%2f` separators, so a
 *    content-controlled src must never be allowed to smuggle those past the
 *    canonicalization;
 *  - it resolves `new URL(trimmed, "http://internal.invalid").pathname`, which
 *    normalizes `..`/`.` segments (e.g. `/api/files/../auth/whoami` →
 *    `/api/auth/whoami`);
 *  - it then requires the canonical pathname to start with `/api/files/`, so a
 *    traversal that escaped that subtree is rejected.
 *
 * Returns the path RELATIVE to the `/api` base (e.g. `/files/<id>/<name>`),
 * ready to hand to the loopback client. The throw happens BEFORE any network
 * call, so a rejected src is counted as a failed mirror and its original src is
 * kept (the per-image try/catch in stashPage never aborts the whole document).
 */
export function resolveInternalFilePath(src) {
    const trimmed = src.trim();
    // Percent-encoded dot/slash must never reach the URL canonicalizer: the
    // WHATWG parser does NOT decode `%2f` into a path separator, so an encoded
    // `..%2fauth` would survive canonicalization and still escape /api/files/.
    if (/%2e|%2f/i.test(trimmed)) {
        throw new Error(`Refusing internal file src with percent-encoded path segment: "${src}"`);
    }
    let pathname;
    try {
        // The base host is irrelevant (never contacted); it only lets the parser
        // resolve a relative `src` and normalize `..`/`.` segments.
        pathname = new URL(trimmed, "http://internal.invalid").pathname;
    }
    catch {
        throw new Error(`Invalid internal file src: "${src}"`);
    }
    if (!pathname.startsWith("/api/files/")) {
        throw new Error(`Refusing internal file src that escapes /api/files/: "${src}"`);
    }
    // Strip the `/api` base prefix; the loopback client's baseURL already ends
    // in `/api`, so it expects the path relative to that (e.g. /files/<id>/<f>).
    return pathname.replace(/^\/api/, "");
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
