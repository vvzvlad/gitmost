import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { DocmostClient } from "./client.js";
// Re-export the client and its config type so embedding hosts (e.g. the gitmost
// NestJS server) can `import('@docmost/mcp')` and construct a DocmostClient
// directly — for the credentials variant OR the per-user getToken variant.
export { DocmostClient } from "./client.js";
// Read version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"));
const VERSION = packageJson.version;
// Configuration for an MCP server instance is the DocmostMcpConfig union
// (credentials OR getToken) defined and re-exported above. The factory below is
// fully side-effect-free on import: it reads no environment variables and opens
// no transport. The standalone stdio entrypoint (stdio.ts) and the HTTP handler
// (http.ts) supply this config and own the process/transport lifecycle.
// --- Modern McpServer Implementation ---
// Editing guide surfaced to MCP clients in the initialize result so they can
// pick the right tool by intent and avoid resending whole documents.
const SERVER_INSTRUCTIONS = "Docmost editing guide — choose the tool by intent: fix wording/typos/numbers (text inside blocks) -> edit_page_text (no node id needed). Change ONE block (paragraph/heading/callout/table cell/etc.) structurally -> patch_node (address by attrs.id from get_page_json). Add a block -> insert_node (before/after a block by attrs.id or by anchor text, or append). Remove a block -> delete_node (by attrs.id). Images -> insert_image (place a local image file) / replace_image (swap an existing image file). New page -> create_page (Markdown). Bulk/structural rewrite or nodes without an id -> update_page_json (full ProseMirror replace; prefer the granular tools above to avoid resending the whole ~100KB+ document). Copy/replace a page's whole content from another page (server-side, no document through the model) -> copy_page_content. Rename a page (title only) -> rename_page. Read -> get_page (Markdown, lossy) or get_page_json (lossless ProseMirror with block ids). Comments -> create_comment (an inline comment anchors to its selection text), list_comments, update_comment, delete_comment, check_new_comments. Tip: read block ids via get_page_json, then use patch_node/insert_node/delete_node so you never resend the full document. " +
    "Complex/scripted rewrite (multiple coordinated edits, footnotes, renumbering) -> docmost_transform: write a JS `(doc, ctx) => doc` transform, preview the diff with dryRun (default), then apply with dryRun:false; ctx.helpers includes commentsToFootnotes for turning inline comments into numbered footnotes. " +
    "Review what changed -> diff_page_versions (compare a historyId to current, or two history versions). See a page's saved versions -> list_page_history. Undo a bad edit -> restore_page_version (writes a past version back as current; itself revertible). " +
    "Lossless markdown round-trip (download, edit, re-upload, incl. comment anchors) -> export_page_markdown / import_page_markdown.";
// Helper to format JSON responses
const jsonContent = (data) => ({
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});
/**
 * Create a fully configured Docmost MCP server. Side-effect-free: it does not
 * read environment variables and does not connect any transport — the caller
 * decides how to expose it (stdio or HTTP). The client talks to Docmost over
 * REST + the collaboration WebSocket using the provided service-account
 * credentials and auto-re-authenticates.
 */
export function createDocmostMcpServer(config) {
    // Pass the whole config union through: the client branches internally on
    // credentials vs. getToken, so both the external /mcp (creds) and the
    // internal per-user (getToken) paths are wired here unchanged.
    const docmostClient = new DocmostClient(config);
    const server = new McpServer({
        name: "docmost-mcp",
        version: VERSION,
    }, { instructions: SERVER_INSTRUCTIONS });
    // Tool: get_workspace
    server.registerTool("get_workspace", {
        description: "Get the current Docmost workspace",
    }, async () => {
        const workspace = await docmostClient.getWorkspace();
        return jsonContent(workspace);
    });
    // Tool: list_spaces
    server.registerTool("list_spaces", {
        description: "List all available spaces in Docmost",
    }, async () => {
        const spaces = await docmostClient.getSpaces();
        return jsonContent(spaces);
    });
    // Tool: list_pages
    server.registerTool("list_pages", {
        description: "List most recent pages in a space ordered by updatedAt (descending). " +
            "Returns a bounded list (default 50, max 100) — use search for lookups " +
            "in large spaces.",
        inputSchema: {
            spaceId: z.string().optional(),
            limit: z
                .number()
                .int()
                .min(1)
                .max(100)
                .optional()
                .describe("Max pages to return (default 50, max 100)"),
        },
    }, async ({ spaceId, limit }) => {
        const result = await docmostClient.listPages(spaceId, limit ?? 50);
        return jsonContent(result);
    });
    // Tool: get_page
    server.registerTool("get_page", {
        description: "Get page details with content converted to Markdown. The conversion is " +
            "LOSSY (block ids, exact table/callout structure are approximated); for a " +
            "lossless representation use get_page_json.",
        inputSchema: {
            pageId: z.string().min(1),
        },
    }, async ({ pageId }) => {
        const page = await docmostClient.getPage(pageId);
        return jsonContent(page);
    });
    // Tool: get_page_json
    server.registerTool("get_page_json", {
        description: "Get page details with the raw ProseMirror JSON content (lossless: " +
            "includes block ids, callouts, tables, link/image attributes) plus the " +
            "slugId used in URLs. Use together with update_page_json for precise " +
            "structural edits, or edit_page_text for simple text fixes.",
        inputSchema: {
            pageId: z.string().min(1),
        },
    }, async ({ pageId }) => {
        const page = await docmostClient.getPageJson(pageId);
        return jsonContent(page);
    });
    // Tool: get_outline
    server.registerTool("get_outline", {
        description: "Return a COMPACT outline of a page's top-level blocks ({index, type, " +
            "id, level, firstText}; tables add rows/cols/header; lists add item " +
            "count) WITHOUT the full document body. Use it to locate sections/tables " +
            "and grab block ids cheaply before get_node / patch_node / insert_node.",
        inputSchema: {
            pageId: z.string().min(1),
        },
    }, async ({ pageId }) => {
        const result = await docmostClient.getOutline(pageId);
        return jsonContent(result);
    });
    // Tool: get_node
    server.registerTool("get_node", {
        description: "Fetch a single node's full ProseMirror subtree (lossless) without " +
            "pulling the whole document. `nodeId` is a block id from get_outline/" +
            "get_page_json (works for headings/paragraphs/callouts/images), OR " +
            "`#<index>` to fetch a top-level block by its outline index — use the " +
            "`#<index>` form for tables/rows/cells, which carry no id.",
        inputSchema: {
            pageId: z.string().min(1),
            nodeId: z.string().min(1),
        },
    }, async ({ pageId, nodeId }) => {
        const result = await docmostClient.getNode(pageId, nodeId);
        return jsonContent(result);
    });
    // Tool: table_get
    server.registerTool("table_get", {
        description: "Read a table as a matrix. Returns {rows, cols, cells (text[][]), " +
            "cellIds (paragraph id per cell, or null)}. `table` = `#<index>` from " +
            "get_outline, or any block id inside the table. Use cellIds with " +
            "patch_node for rich-formatted cell edits. `cols` is the FIRST row's " +
            "width; ragged tables may vary per row, so use the per-row length of " +
            "`cells` for each row.",
        inputSchema: {
            pageId: z.string().min(1),
            table: z.string().min(1),
        },
    }, async ({ pageId, table }) => {
        const result = await docmostClient.getTable(pageId, table);
        return jsonContent(result);
    });
    // Tool: table_insert_row
    server.registerTool("table_insert_row", {
        description: "Insert a row of plain-text cells into a table. `table` = `#<index>` or " +
            "a block id inside it. `cells` = text per column (padded to the table's " +
            "column count; error if more cells than columns). `index` = 0-based " +
            "insert position (0 inserts before the header); omit to append at the end.",
        inputSchema: {
            pageId: z.string().min(1),
            table: z.string().min(1),
            cells: z.array(z.string()),
            index: z.number().int().optional(),
        },
    }, async ({ pageId, table, cells, index }) => {
        const result = await docmostClient.tableInsertRow(pageId, table, cells, index);
        return jsonContent(result);
    });
    // Tool: table_delete_row
    server.registerTool("table_delete_row", {
        description: "Delete the row at 0-based `index` from a table (`table` = `#<index>` or " +
            "a block id inside it). Refuses to delete the table's only row. An " +
            "out-of-range `index` throws. Deleting `index` 0 removes the header row, " +
            "and the next row becomes the new header.",
        inputSchema: {
            pageId: z.string().min(1),
            table: z.string().min(1),
            index: z.number().int(),
        },
    }, async ({ pageId, table, index }) => {
        const result = await docmostClient.tableDeleteRow(pageId, table, index);
        return jsonContent(result);
    });
    // Tool: table_update_cell
    server.registerTool("table_update_cell", {
        description: "Set the plain-text content of cell [row,col] (0-based) in a table " +
            "(`table` = `#<index>` or a block id inside it). Replaces the cell's " +
            "content with a single text paragraph; for rich formatting use patch_node " +
            "on the cell's paragraph id from table_get.",
        inputSchema: {
            pageId: z.string().min(1),
            table: z.string().min(1),
            row: z.number().int(),
            col: z.number().int(),
            text: z.string(),
        },
    }, async ({ pageId, table, row, col, text }) => {
        const result = await docmostClient.tableUpdateCell(pageId, table, row, col, text);
        return jsonContent(result);
    });
    // Tool: create_page
    server.registerTool("create_page", {
        description: "Create a new page with content (automatically moves it to the correct hierarchy).",
        inputSchema: {
            title: z.string().min(1).describe("Title of the page"),
            content: z.string().min(1).describe("Markdown content"),
            spaceId: z.string().min(1),
            parentPageId: z
                .string()
                .optional()
                .describe("Optional parent page ID to nest under"),
        },
    }, async ({ title, content, spaceId, parentPageId }) => {
        const result = await docmostClient.createPage(title, content, spaceId, parentPageId);
        return jsonContent(result);
    });
    // Tool: update_page_json
    server.registerTool("update_page_json", {
        description: "Replace a page's content with a raw ProseMirror JSON document " +
            "(lossless write: preserves the block ids, callouts, tables and " +
            "attributes you pass in). Typical flow: get_page_json -> modify the " +
            "JSON -> update_page_json. Keep existing node ids intact so heading " +
            "anchors and history stay stable. Minimal full-doc example: " +
            '{"type":"doc","content":[{"type":"paragraph","content":' +
            '[{"type":"text","text":"Hi"}]}]}. `content` may be a JSON object or a ' +
            "JSON string (both accepted), and is OPTIONAL: omit it to update only " +
            "the title (though prefer rename_page for a title-only change). " +
            "Supplying neither content nor title is an error.",
        inputSchema: {
            pageId: z.string().min(1).describe("ID of the page to update"),
            content: z
                .any()
                .optional()
                .describe('ProseMirror document {"type":"doc","content":[...]} (JSON object or ' +
                "JSON string). Omit to rename only."),
            title: z.string().optional().describe("Optional new title"),
        },
    }, async ({ pageId, content, title }) => {
        // Only parse/validate the document when it was actually supplied; when it
        // is omitted, pass it straight through so the client performs a title-only
        // (or no-op) update.
        let doc;
        if (content === undefined || content === null) {
            doc = undefined;
        }
        else if (typeof content === "string") {
            try {
                doc = JSON.parse(content);
            }
            catch {
                throw new Error("content was a string but not valid JSON");
            }
        }
        else {
            doc = content;
        }
        const result = await docmostClient.updatePageJson(pageId, doc, title);
        return jsonContent(result);
    });
    // Tool: export_page_markdown
    server.registerTool("export_page_markdown", {
        description: "Export a page to a single self-contained, lossless Docmost-flavoured " +
            "Markdown file (custom extensions): YAML-free meta header, body with " +
            "inline comment anchors and diagrams, and a trailing comments-thread " +
            "block. Designed for a download -> edit body -> import_page_markdown " +
            "round-trip that preserves everything, including comment highlights. " +
            "Comment THREADS are preserved in the file but are not re-pushed to the " +
            "server on import.",
        inputSchema: {
            pageId: z.string().min(1),
        },
    }, async ({ pageId }) => {
        const md = await docmostClient.exportPageMarkdown(pageId);
        return { content: [{ type: "text", text: md }] };
    });
    // Tool: import_page_markdown
    server.registerTool("import_page_markdown", {
        description: "Replace a page's content from a self-contained Docmost-flavoured " +
            "Markdown file produced by export_page_markdown. Restores comment " +
            "highlight anchors and diagrams from their inline HTML. NOTE: comment " +
            "thread records are NOT created/updated/deleted on the server by this " +
            "tool — only the page body + inline comment marks are written; manage " +
            "comment threads via the comment tools/UI.",
        inputSchema: {
            pageId: z.string().min(1),
            markdown: z.string().min(1),
        },
    }, async ({ pageId, markdown }) => {
        const res = await docmostClient.importPageMarkdown(pageId, markdown);
        return jsonContent(res);
    });
    // Tool: copy_page_content
    server.registerTool("copy_page_content", {
        description: "Replace targetPageId's content with a copy of sourcePageId's content, " +
            "entirely server-side — the document is NOT sent through the model. The " +
            "target keeps its own title and slug; only its body is replaced. Ideal " +
            "for 'make page A's content equal to B' or 'replace A with B but keep A's URL'.",
        inputSchema: {
            sourcePageId: z.string().min(1).describe("Page to copy content FROM"),
            targetPageId: z
                .string()
                .min(1)
                .describe("Page whose content is REPLACED (title/slug kept)"),
        },
    }, async ({ sourcePageId, targetPageId }) => {
        const result = await docmostClient.copyPageContent(sourcePageId, targetPageId);
        return jsonContent(result);
    });
    // Tool: rename_page
    server.registerTool("rename_page", {
        description: "Rename a page (change its title only) without touching or resending " +
            "its content.",
        inputSchema: {
            pageId: z.string().min(1).describe("ID of the page to rename"),
            title: z.string().min(1).describe("New title"),
        },
    }, async ({ pageId, title }) => {
        const result = await docmostClient.renamePage(pageId, title);
        return jsonContent(result);
    });
    // Tool: edit_page_text
    server.registerTool("edit_page_text", {
        description: "Surgical find/replace inside a page's text. Preserves ALL structure: " +
            "block ids, marks, links, callouts, tables. A `find` MAY cross " +
            "bold/italic/link boundaries; the replacement inherits marks from the " +
            "unchanged common prefix/suffix (editing plain text next to a bold word " +
            "keeps it bold; editing inside a bold word keeps the new text bold). " +
            "Each `find` must match exactly once (or set replaceAll). The batch " +
            "applies what it can and returns applied[] + failed[]; a fully-unmatched " +
            "batch writes nothing and errors. `find` should be the literal rendered " +
            "text (no markdown). Markdown wrappers (**bold**, *italic*, `code`) and " +
            "trailing emoji are tolerated via a strip-and-retry fallback, but plain " +
            "text is preferred. Examples: edits:[{find:\"teh\"," +
            "replace:\"the\"}]; edits:[{find:\"Hello world\",replace:\"Hello there\"}] " +
            "(crosses a bold boundary). This is the preferred tool for fixing " +
            "wording, typos, numbers, names.",
        inputSchema: {
            pageId: z.string().describe("ID of the page to edit"),
            edits: z
                .array(z.object({
                find: z.string().describe("Exact text to find"),
                replace: z.string().describe("Replacement text (may be empty)"),
                replaceAll: z
                    .boolean()
                    .optional()
                    .describe("Replace every occurrence (default: must match once)"),
            }))
                .min(1)
                .describe("List of find/replace operations, applied in order"),
        },
    }, async ({ pageId, edits }) => {
        const result = await docmostClient.editPageText(pageId, edits);
        return jsonContent(result);
    });
    // Tool: patch_node
    server.registerTool("patch_node", {
        description: "Replaces a single block identified by its attrs.id WITHOUT resending the " +
            "whole document. Get the block id from get_page_json, then pass a " +
            "ProseMirror node to put in its place. Example node: a paragraph " +
            '{"type":"paragraph","content":[{"type":"text","text":"Hello"}]} or a ' +
            'heading {"type":"heading","attrs":{"level":2},"content":' +
            '[{"type":"text","text":"Title"}]}. Bold is a mark: ' +
            '{"type":"text","text":"x","marks":[{"type":"bold"}]}. The node may be a ' +
            "JSON object or a JSON string (both accepted). Cheaper and safer than " +
            "update_page_json for one-block structural edits.",
        inputSchema: {
            pageId: z.string().min(1),
            nodeId: z.string().min(1),
            node: z
                .any()
                .describe("ProseMirror node to put in place of the node with this id, e.g. " +
                '{"type":"paragraph","content":[{"type":"text","text":"Hello"}]}. ' +
                "JSON object or JSON string both accepted."),
        },
    }, async ({ pageId, nodeId, node }) => {
        let parsedNode;
        if (typeof node === "string") {
            try {
                parsedNode = JSON.parse(node);
            }
            catch {
                throw new Error("node was a string but not valid JSON");
            }
        }
        else {
            parsedNode = node;
        }
        const result = await docmostClient.patchNode(pageId, nodeId, parsedNode);
        return jsonContent(result);
    });
    // Tool: insert_node
    server.registerTool("insert_node", {
        description: "Insert a block before/after another block (by attrs.id or anchor text) " +
            "or append at the end. Get anchor block ids from get_page_json. Avoids " +
            "resending the whole document. Can also insert table structure: to add a " +
            "tableRow, pass a tableRow node with position before/after and anchor " +
            "INSIDE the target table — anchorNodeId of any block/cell in it, or " +
            "anchorText matching the table; to add a tableCell/tableHeader, use " +
            "anchorNodeId of a block inside the target row (anchorText only resolves " +
            "top-level blocks, so it cannot target a row). `anchorText` is matched " +
            "against the block's literal rendered plain text (no markdown); " +
            "markdown/emoji are tolerated as a fallback; prefer plain text or " +
            "anchorNodeId. Note: append is top-level " +
            "only and rejects structural table nodes. Example node: a paragraph " +
            '{"type":"paragraph","content":[{"type":"text","text":"Hello"}]} or a ' +
            'heading {"type":"heading","attrs":{"level":2},"content":' +
            '[{"type":"text","text":"Title"}]}. Bold is a mark: ' +
            '{"type":"text","text":"x","marks":[{"type":"bold"}]}. The node may be a ' +
            "JSON object or a JSON string (both accepted).",
        inputSchema: {
            pageId: z.string().min(1),
            node: z
                .any()
                .describe("ProseMirror node to insert, e.g. " +
                '{"type":"paragraph","content":[{"type":"text","text":"Hello"}]}. ' +
                "JSON object or JSON string both accepted."),
            position: z.enum(["before", "after", "append"]),
            anchorNodeId: z.string().optional(),
            anchorText: z.string().optional(),
        },
    }, async ({ pageId, node, position, anchorNodeId, anchorText }) => {
        let parsedNode;
        if (typeof node === "string") {
            try {
                parsedNode = JSON.parse(node);
            }
            catch {
                throw new Error("node was a string but not valid JSON");
            }
        }
        else {
            parsedNode = node;
        }
        const result = await docmostClient.insertNode(pageId, parsedNode, {
            position,
            anchorNodeId,
            anchorText,
        });
        return jsonContent(result);
    });
    // Tool: delete_node
    server.registerTool("delete_node", {
        description: "Remove a single block by its attrs.id (from get_page_json) WITHOUT " +
            "resending the whole document.",
        inputSchema: {
            pageId: z.string().min(1),
            nodeId: z.string().min(1),
        },
    }, async ({ pageId, nodeId }) => {
        const result = await docmostClient.deleteNode(pageId, nodeId);
        return jsonContent(result);
    });
    // Tool: insert_image
    server.registerTool("insert_image", {
        description: "Upload a local image and insert it into a page in one step. By default " +
            "appends the image at the end of the page. With replaceText, replaces the " +
            "first top-level block whose text contains that string (handy for " +
            'swapping a text placeholder like "[image: foo.png]" for the real image). ' +
            "With afterText, inserts the image right after the first block containing " +
            "that string. Preserves all other block ids.",
        inputSchema: {
            pageId: z.string().min(1),
            filePath: z
                .string()
                .min(1)
                .describe("Absolute local path to the image file"),
            align: z.enum(["left", "center", "right"]).optional(),
            alt: z.string().optional(),
            replaceText: z
                .string()
                .optional()
                .describe("Replace the first top-level block whose text contains this string with the image"),
            afterText: z
                .string()
                .optional()
                .describe("Insert the image right after the first top-level block whose text contains this string"),
        },
    }, async ({ pageId, filePath, align, alt, replaceText, afterText }) => {
        const result = await docmostClient.insertImage(pageId, filePath, {
            align,
            alt,
            replaceText,
            afterText,
        });
        return jsonContent(result);
    });
    // Tool: replace_image
    server.registerTool("replace_image", {
        description: "Replace an existing image on a page: uploads the new file as a NEW " +
            "attachment (fresh clean URL that renders and busts browser caches), then " +
            "repoints every image node referencing the old attachmentId (recursively, " +
            "incl. callouts/tables) via the live document, preserving comments, " +
            "alignment and alt. The old attachment is left as an unreferenced orphan " +
            "(Docmost has no API to delete a single attachment; it is removed only when " +
            "the page/space is deleted). In-place byte overwrite is avoided because some " +
            "Docmost versions corrupt the attachment (HTTP 500) on overwrite.",
        inputSchema: {
            pageId: z.string().min(1),
            attachmentId: z
                .string()
                .min(1)
                .describe("attachmentId of the image currently in the page to replace"),
            filePath: z
                .string()
                .min(1)
                .describe("Absolute local path to the new image file"),
            align: z.enum(["left", "center", "right"]).optional(),
            alt: z.string().optional(),
        },
    }, async ({ pageId, attachmentId, filePath, align, alt }) => {
        const result = await docmostClient.replaceImage(pageId, attachmentId, filePath, {
            align,
            alt,
        });
        return jsonContent(result);
    });
    // Tool: share_page
    server.registerTool("share_page", {
        description: "Make a page publicly accessible (idempotent) and return its public " +
            "URL. The URL format is <app>/share/<key>/p/<slugId>.",
        inputSchema: {
            pageId: z.string().min(1).describe("ID of the page to share"),
            searchIndexing: z
                .boolean()
                .optional()
                .describe("Allow search engines to index the page (default true)"),
        },
    }, async ({ pageId, searchIndexing }) => {
        const result = await docmostClient.sharePage(pageId, searchIndexing ?? true);
        return jsonContent(result);
    });
    // Tool: unshare_page
    server.registerTool("unshare_page", {
        description: "Remove the public share of a page (revokes the public URL).",
        inputSchema: {
            pageId: z.string().min(1).describe("ID of the page to unshare"),
        },
    }, async ({ pageId }) => {
        const result = await docmostClient.unsharePage(pageId);
        return jsonContent(result);
    });
    // Tool: list_shares
    server.registerTool("list_shares", {
        description: "List all public shares in the workspace with page titles and public URLs.",
    }, async () => {
        const result = await docmostClient.listShares();
        return jsonContent(result);
    });
    // Tool: move_page
    server.registerTool("move_page", {
        description: "Move a page to a new parent (nesting) or root. Essential for organizing pages created via 'create_page'.",
        inputSchema: {
            pageId: z.string().min(1),
            parentPageId: z
                .string()
                .nullable()
                .optional()
                .describe("Target parent page ID. Pass 'null' or empty string to move to root."),
            position: z
                .string()
                .min(5)
                .optional()
                .describe("fractional-index position key; min 5 chars; omit to append at the end."),
        },
    }, async ({ pageId, parentPageId, position }) => {
        const finalParentId = parentPageId === "" || parentPageId === "null" ? null : parentPageId;
        // Cheap cycle guard: a page cannot be moved directly under itself.
        // (Deeper descendant-cycle detection is intentionally out of scope.)
        if (finalParentId !== null && finalParentId === pageId) {
            throw new Error("cannot move a page under itself");
        }
        const result = await docmostClient.movePage(pageId, finalParentId || null, position);
        // Require POSITIVE confirmation: the live /pages/move success shape is
        // exactly { success: true, status: 200 }. An empty body, a 204, or any odd
        // shape lacking success === true must NOT be reported as a successful move,
        // so we surface the raw API result instead of declaring success.
        if (!(result && typeof result === "object" && result.success === true)) {
            throw new Error(`Failed to move page ${pageId}: ${JSON.stringify(result)}`);
        }
        return jsonContent({
            message: `Successfully moved page ${pageId} to parent ${finalParentId || "root"}`,
            result,
        });
    });
    // Tool: delete_page
    server.registerTool("delete_page", {
        description: "Delete a single page by ID.",
        inputSchema: {
            pageId: z.string().min(1),
        },
    }, async ({ pageId }) => {
        await docmostClient.deletePage(pageId);
        return {
            content: [
                { type: "text", text: `Successfully deleted page ${pageId}` },
            ],
        };
    });
    // --- Comment tools (ported from upstream PR #3 by Max Nikitin) ---
    // Tool: list_comments
    server.registerTool("list_comments", {
        description: "List all comments on a page (paginated). Content is returned as Markdown.",
        inputSchema: {
            pageId: z.string().describe("ID of the page"),
        },
    }, async ({ pageId }) => {
        const comments = await docmostClient.listComments(pageId);
        return jsonContent(comments);
    });
    // Tool: create_comment
    server.registerTool("create_comment", {
        description: "Create a new comment on a page. Content is provided as Markdown and " +
            "automatically converted to the required format.",
        inputSchema: {
            pageId: z.string().describe("ID of the page to comment on"),
            content: z.string().min(1).describe("Comment content in Markdown format"),
            type: z
                .enum(["page", "inline"])
                .optional()
                .describe("Comment type: 'page' for general page comment (default), 'inline' for text selection comment"),
            selection: z
                .string()
                // Enforce the documented 250-char cap to match the description above.
                .max(250)
                .optional()
                .describe("For an inline comment, the EXACT text in the page to anchor/highlight the comment on (the first occurrence of this text is wrapped in a comment mark). Max 250 chars. Required when type is 'inline'."),
            parentCommentId: z
                .string()
                .optional()
                .describe("Parent comment ID to create a reply (max 2 nesting levels)"),
        },
    }, async ({ pageId, content, type, selection, parentCommentId }) => {
        const result = await docmostClient.createComment(pageId, content, type || "page", selection, parentCommentId);
        return jsonContent(result);
    });
    // Tool: update_comment
    server.registerTool("update_comment", {
        description: "Update an existing comment's content. Only the comment creator can " +
            "update it. Content is provided as Markdown.",
        inputSchema: {
            commentId: z.string().min(1).describe("ID of the comment to update"),
            content: z
                .string()
                .min(1)
                .describe("New comment content in Markdown format"),
        },
    }, async ({ commentId, content }) => {
        const result = await docmostClient.updateComment(commentId, content);
        return jsonContent(result);
    });
    // Tool: delete_comment
    server.registerTool("delete_comment", {
        description: "Delete a comment. Only the comment creator or space admin can delete it.",
        inputSchema: {
            commentId: z.string().min(1).describe("ID of the comment to delete"),
        },
    }, async ({ commentId }) => {
        await docmostClient.deleteComment(commentId);
        return {
            content: [
                {
                    type: "text",
                    text: `Successfully deleted comment ${commentId}`,
                },
            ],
        };
    });
    // Tool: check_new_comments
    server.registerTool("check_new_comments", {
        description: "Check for new comments across pages in a space since a given timestamp. " +
            "Optionally scope to a page subtree (folder). Returns only comments " +
            "created after the specified time.",
        inputSchema: {
            spaceId: z.string().describe("Space ID to check for new comments"),
            since: z
                .string()
                .min(1)
                .describe("ISO 8601 timestamp — only return comments created after this time (e.g. '2026-03-10T00:00:00Z')"),
            parentPageId: z
                .string()
                .optional()
                .describe("Optional root page ID to scope the check to a subtree (folder). " +
                "Only pages under this parent will be checked."),
        },
    }, async ({ spaceId, since, parentPageId }) => {
        // Reject an unparseable timestamp up front: otherwise the comparison
        // against NaN silently treats every comment as "not new" and the tool
        // returns zero results without signalling the bad input.
        if (Number.isNaN(Date.parse(since))) {
            throw new Error(`Invalid 'since' timestamp: ${JSON.stringify(since)} — expected an ISO 8601 date (e.g. '2026-03-10T00:00:00Z')`);
        }
        const result = await docmostClient.checkNewComments(spaceId, since, parentPageId);
        return jsonContent(result);
    });
    // Tool: search
    server.registerTool("search", {
        description: "Search for pages and content. Results are bounded by `limit` " +
            "(default applied by the client, max 100).",
        inputSchema: {
            query: z.string().min(1).describe("Search query"),
            limit: z
                .number()
                .int()
                .min(1)
                .max(100)
                .optional()
                .describe("Max results to return (max 100)"),
        },
    }, async ({ query, limit }) => {
        // The tool exposes no spaceId filter, so pass undefined for the client's
        // optional spaceId parameter and forward limit into its correct slot.
        const result = await docmostClient.search(query, undefined, limit);
        return jsonContent(result);
    });
    // Tool: docmost_transform
    server.registerTool("docmost_transform", {
        description: "Edit a page by running an arbitrary JS transform `(doc, ctx) => doc` " +
            "against its LIVE ProseMirror document, with a diff preview and page " +
            "history as the safety net. By default dryRun=true: returns a diff " +
            "preview WITHOUT writing. Set dryRun=false to apply (atomic, won't " +
            "clobber concurrent edits). `doc` is the lossless ProseMirror document " +
            "({type:'doc',content:[...]}); return a new doc of the same shape. " +
            "`ctx` gives you: comments (the page's comments, each {id, content " +
            "(markdown), selection, type}); log (array; console.log pushes to it); " +
            "consume(id) (mark a comment id as consumed — those are deleted when " +
            "deleteComments=true after a successful apply); and helpers: " +
            "blockText(node) (plain text), walk(node, fn) (depth-first over all " +
            "nodes incl. callouts/tables/lists), getList(doc, predicate) (find a " +
            "node even without attrs.id), insertMarkerAfter(doc, anchor, marker, " +
            "{beforeBlock}) (insert a plain unmarked text run after anchor, " +
            "mark-safe), setCalloutRange(doc, n) (sync a [1]…[K] callout range to " +
            "[1]…[n]), noteItem(inlineNodes) (wrap inline nodes in a listItem with a " +
            "fresh id), mdToInlineNodes(markdown) (comment markdown -> inline nodes), " +
            "and commentsToFootnotes(doc, comments, {notesHeading}) (turn inline " +
            "comments into numbered footnotes). Footnote convention: markers are " +
            "plain '[N]' text in the body; the notes are an orderedList under a " +
            "heading whose text is 'Примечания переводчика'. The transform runs " +
            "sandboxed (no require/process/fs/network, 5s timeout) and must return a " +
            "{type:'doc'} node.",
        inputSchema: {
            pageId: z.string().min(1),
            transformJs: z
                .string()
                .min(1)
                .describe("A JS function `(doc, ctx) => doc` (expression-arrow or " +
                "parenthesized function). It receives a clone of the live doc and " +
                "ctx (comments, log, consume(id), helpers: blockText/walk/getList/" +
                "insertMarkerAfter/setCalloutRange/noteItem/mdToInlineNodes/" +
                "commentsToFootnotes) and must return a {type:'doc'} node."),
            dryRun: z
                .boolean()
                .optional()
                .default(true)
                .describe("Preview only (no write) when true (default)."),
            deleteComments: z
                .boolean()
                .optional()
                .default(false)
                .describe("After a successful apply, delete every comment id passed to " +
                "ctx.consume(id)."),
        },
    }, async ({ pageId, transformJs, dryRun, deleteComments }) => {
        const result = await docmostClient.transformPage(pageId, transformJs, {
            dryRun,
            deleteComments,
        });
        return jsonContent(result);
    });
    // Tool: diff_page_versions
    server.registerTool("diff_page_versions", {
        description: "Diff two versions of a page and return a Docmost-equivalent change set " +
            "(inserted/deleted text, integrity counts for images/links/tables/" +
            "callouts/footnote markers, and a human-readable markdown summary). " +
            "`from`/`to` each accept a historyId, or null/'current' for the page's " +
            "current content (defaults: from=current, to=current — pass a historyId " +
            "from list_page_history to compare against the live page).",
        inputSchema: {
            pageId: z.string().min(1),
            from: z
                .string()
                .optional()
                .describe("historyId, or 'current'/omit for current content"),
            to: z
                .string()
                .optional()
                .describe("historyId, or 'current'/omit for current content"),
        },
    }, async ({ pageId, from, to }) => {
        const result = await docmostClient.diffPageVersions(pageId, from, to);
        return jsonContent(result);
    });
    // Tool: list_page_history
    server.registerTool("list_page_history", {
        description: "List a page's saved versions (Docmost auto-snapshots on every save), " +
            "newest first, cursor-paginated. Returns { items, nextCursor }; each " +
            "item's id is the historyId to pass to diff_page_versions or " +
            "restore_page_version.",
        inputSchema: {
            pageId: z.string().min(1),
            cursor: z
                .string()
                .optional()
                .describe("Pagination cursor from a previous nextCursor"),
        },
    }, async ({ pageId, cursor }) => {
        const result = await docmostClient.listPageHistory(pageId, cursor);
        return jsonContent(result);
    });
    // Tool: restore_page_version
    server.registerTool("restore_page_version", {
        description: "Restore a page to a saved version: writes that version's content back " +
            "as the page's current content (Docmost has no restore endpoint, so " +
            "this creates a NEW history snapshot — the restore is itself revertible). " +
            "Get the historyId from list_page_history.",
        inputSchema: {
            historyId: z.string().min(1),
        },
    }, async ({ historyId }) => {
        const result = await docmostClient.restorePageVersion(historyId);
        return jsonContent(result);
    });
    return server;
}
