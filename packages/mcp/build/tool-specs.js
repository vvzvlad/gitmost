// Zod-agnostic shared tool-spec registry consumed by BOTH the zod-v3 MCP server
// (packages/mcp/src/index.ts) and the zod-v4 in-app AI-SDK service
// (apps/server/src/core/ai-chat/tools/ai-chat-tools.service.ts). Intentionally
// imports NO zod: each consumer passes its OWN zod namespace into buildShape,
// because the two packages are on different zod majors (v3 here, v4 in the
// server) and a zod schema object built with one major cannot be reused by the
// other. The builders below only touch z.string()/.min()/.optional()/.describe(),
// z.array() and z.object() — API identical across v3 and v4 — so a single
// builder works with either namespace.
//
// Only tools whose snake_case/camelCase name, input schema AND model-facing
// description are genuinely identical across both layers live here. Tools that
// diverge on purpose (security guardrails, tuned UX, "Reversible" framing on
// some write tools, different limits, hybrid-RRF search, etc.) stay defined
// per-layer and are NOT represented here.
export const SHARED_TOOL_SPECS = {
    // --- no-argument read tools ---
    getWorkspace: {
        mcpName: 'get_workspace',
        inAppKey: 'getWorkspace',
        description: 'Fetch metadata about the current workspace (name, settings).',
    },
    listSpaces: {
        mcpName: 'list_spaces',
        inAppKey: 'listSpaces',
        description: 'List the spaces the current user can access. Returns the array of ' +
            'spaces (id, name, slug, ...).',
    },
    listShares: {
        mcpName: 'list_shares',
        inAppKey: 'listShares',
        description: 'List all public shares in the workspace with page titles and public URLs.',
    },
    // --- single-pageId read tools ---
    getPageJson: {
        mcpName: 'get_page_json',
        inAppKey: 'getPageJson',
        description: 'Get page details with the raw ProseMirror JSON content (lossless: ' +
            'includes block ids, callouts, tables, link/image attributes) plus the ' +
            'slugId used in URLs. Use the block ids it returns to make precise ' +
            'structural edits or surgical text edits without resending the page.',
        buildShape: (z) => ({
            pageId: z.string().min(1),
        }),
    },
    getOutline: {
        mcpName: 'get_outline',
        inAppKey: 'getOutline',
        description: "Return a COMPACT outline of a page's top-level blocks ({index, type, " +
            'id, level, firstText}; tables add rows/cols/header; lists add item ' +
            'count) WITHOUT the full document body. Use it to locate sections/tables ' +
            'and grab block ids cheaply before fetching, patching or inserting ' +
            'individual blocks.',
        buildShape: (z) => ({
            pageId: z.string().min(1),
        }),
    },
    // --- two-id read tool ---
    getNode: {
        mcpName: 'get_node',
        inAppKey: 'getNode',
        description: "Fetch a single node's full ProseMirror subtree (lossless) without " +
            'pulling the whole document. `nodeId` is a block id from the page ' +
            'outline or page-JSON view (works for headings/paragraphs/callouts/images), OR ' +
            '`#<index>` to fetch a top-level block by its outline index — use the ' +
            '`#<index>` form for tables/rows/cells, which carry no id.',
        buildShape: (z) => ({
            pageId: z.string().min(1),
            nodeId: z.string().min(1),
        }),
    },
    // --- node delete ---
    deleteNode: {
        mcpName: 'delete_node',
        inAppKey: 'deleteNode',
        description: 'Remove a single block by its attrs.id (from the page-JSON view) WITHOUT ' +
            'resending the whole document.',
        buildShape: (z) => ({
            pageId: z.string().min(1),
            nodeId: z.string().min(1),
        }),
    },
    // --- share management ---
    unsharePage: {
        mcpName: 'unshare_page',
        inAppKey: 'unsharePage',
        description: 'Remove the public share of a page (revokes the public URL).',
        buildShape: (z) => ({
            pageId: z.string().min(1).describe('ID of the page to unshare'),
        }),
    },
    // --- version history ---
    diffPageVersions: {
        mcpName: 'diff_page_versions',
        inAppKey: 'diffPageVersions',
        description: 'Diff two versions of a page and return a Docmost-equivalent change set ' +
            '(inserted/deleted text, integrity counts for images/links/tables/' +
            'callouts/footnote markers, and a human-readable markdown summary). ' +
            "`from`/`to` each accept a historyId, or null/'current' for the page's " +
            'current content (defaults: from=current, to=current — pass a historyId ' +
            'from the page-history list to compare against the live page).',
        buildShape: (z) => ({
            pageId: z.string().min(1),
            from: z
                .string()
                .optional()
                .describe("historyId, or 'current'/omit for current content"),
            to: z
                .string()
                .optional()
                .describe("historyId, or 'current'/omit for current content"),
        }),
    },
    listPageHistory: {
        mcpName: 'list_page_history',
        inAppKey: 'listPageHistory',
        description: "List a page's saved versions (Docmost auto-snapshots on every save), " +
            'newest first, cursor-paginated. Returns { items, nextCursor }; each ' +
            "item's id is the historyId to pass to the page diff or restore tools.",
        buildShape: (z) => ({
            pageId: z.string().min(1),
            cursor: z
                .string()
                .optional()
                .describe('Pagination cursor from a previous nextCursor'),
        }),
    },
    restorePageVersion: {
        mcpName: 'restore_page_version',
        inAppKey: 'restorePageVersion',
        description: 'Restore a page to a saved version: writes that version\'s content back ' +
            'as the page\'s current content (Docmost has no restore endpoint, so ' +
            'this creates a NEW history snapshot — the restore is itself revertible). ' +
            'Get the historyId from the page-history list.',
        buildShape: (z) => ({
            historyId: z.string().min(1),
        }),
    },
    // --- markdown round-trip ---
    importPageMarkdown: {
        mcpName: 'import_page_markdown',
        inAppKey: 'importPageMarkdown',
        description: "Replace a page's content from a self-contained Docmost-flavoured " +
            'Markdown file produced by the page-Markdown export tool. Restores comment ' +
            'highlight anchors and diagrams from their inline HTML. NOTE: comment ' +
            'thread records are NOT created/updated/deleted on the server by this ' +
            'tool — only the page body + inline comment marks are written; manage ' +
            'comment threads via the comment tools/UI.',
        buildShape: (z) => ({
            pageId: z.string().min(1),
            markdown: z.string().min(1),
        }),
    },
    // --- server-side content copy ---
    copyPageContent: {
        mcpName: 'copy_page_content',
        inAppKey: 'copyPageContent',
        description: "Replace targetPageId's content with a copy of sourcePageId's content, " +
            'entirely server-side — the document is NOT sent through the model. The ' +
            'target keeps its own title and slug; only its body is replaced. Ideal ' +
            "for 'make page A's content equal to B' or 'replace A with B but keep A's URL'.",
        buildShape: (z) => ({
            sourcePageId: z.string().min(1).describe('Page to copy content FROM'),
            targetPageId: z
                .string()
                .min(1)
                .describe('Page whose content is REPLACED (title/slug kept)'),
        }),
    },
    // --- surgical text edit (folds in the documented drift-bug fix) ---
    //
    // CANONICAL description is the CORRECTED in-app wording: a formatting-only
    // change is REFUSED into failed[] (not silently stripped-and-retried). The
    // stale MCP claim that "Markdown wrappers are tolerated via a strip-and-retry
    // fallback" is intentionally absent here.
    editPageText: {
        mcpName: 'edit_page_text',
        inAppKey: 'editPageText',
        description: "Surgical find/replace inside a page's text, preserving all block " +
            'ids and marks. A find MAY cross bold/italic/link boundaries; the ' +
            'replacement inherits marks from the unchanged common prefix/suffix ' +
            '(so editing plain text next to a bold word keeps it bold, and ' +
            'editing inside a bold word keeps the new text bold). Each find must ' +
            'match exactly once unless replaceAll is set. The batch applies what ' +
            'it can and returns applied[] + failed[] plus a verify change-report ' +
            '(the text/marks/structure that ACTUALLY changed — read it to confirm ' +
            'your edit landed; do not assume success); a fully-unmatched batch ' +
            'writes nothing and errors. find and replace are LITERAL text, not ' +
            'markdown. This tool edits plain text ONLY and CANNOT add or remove ' +
            'formatting marks: a formatting change — find/replace that differ only ' +
            'in markdown markers (e.g. find:"~~x~~", replace:"x"), or a replace ' +
            'containing **bold**/~~strike~~/`code` wrappers — is REFUSED into ' +
            'failed[]. To change bold/italic/strike/code/link, read the block as ' +
            'page JSON and use a structural node patch/update to set its marks. ' +
            'Examples: edits:[{find:"teh",replace:"the"}]; edits:[{find:"Hello ' +
            'world",replace:"Hello there"}] (crosses a bold boundary).',
        buildShape: (z) => ({
            pageId: z.string().describe('ID of the page to edit'),
            edits: z
                .array(z.object({
                find: z.string().describe('Exact text to find'),
                replace: z.string().describe('Replacement text (may be empty)'),
                replaceAll: z
                    .boolean()
                    .optional()
                    .describe('Replace every occurrence (default: must match once)'),
            }))
                .min(1)
                .describe('List of find/replace operations, applied in order'),
        }),
    },
    // --- hand a large page to an external consumer without bloating context ---
    stashPage: {
        mcpName: 'stash_page',
        inAppKey: 'stashPage',
        description: 'Serialize a whole page (the full ProseMirror JSON, as get_page_json ' +
            'returns) into an ephemeral in-memory blob and return ONLY a short ' +
            'anonymous URL to it — the body NEVER enters the model context, so this ' +
            'is the way to hand a large page (or its images) to an external consumer ' +
            'without truncation. Every internal file/image attachment is mirrored ' +
            'into the same sandbox and its src rewritten to a sandbox URL, so the ' +
            'consumer can fetch the images anonymously too; external http(s) images ' +
            'are left untouched. Returns { uri, size, sha256, images:{mirrored, ' +
            'failed} }. Integrity: the blob is served with ETag = its sha256, so a ' +
            'truncated/corrupted fetch is detectable. Blobs are RAM-only: they expire ' +
            'after a short TTL (~1h) and are cleared on restart — consume the URL ' +
            'within the TTL and one uptime, or re-stash.',
        buildShape: (z) => ({
            pageId: z.string().min(1),
        }),
    },
};
