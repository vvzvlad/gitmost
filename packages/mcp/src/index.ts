import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { DocmostClient, DocmostMcpConfig } from "./client.js";
import { searchShapes } from "./lib/drawio-shapes.js";
import { getGuideSection } from "./lib/drawio-guide.js";
import { SHARED_TOOL_SPECS, SharedToolSpec } from "./tool-specs.js";
import { SERVER_INSTRUCTIONS } from "./server-instructions.js";
import {
  createCommentSignalTracker,
  createListCommentsProbe,
  CommentSignalTracker,
  DEFAULT_COMMENT_SIGNAL_DEBOUNCE_MS,
} from "./comment-signal.js";

// Re-export the client and its config type so embedding hosts (e.g. the gitmost
// NestJS server) can `import('@docmost/mcp')` and construct a DocmostClient
// directly — for the credentials variant OR the per-user getToken variant.
export { DocmostClient } from "./client.js";
export type { DocmostMcpConfig } from "./client.js";

// Teardown for the live per-page CollabSession cache (issue #400). An embedding
// HTTP host (the gitmost NestJS server) should call this from its own shutdown
// hook so no cached collab provider outlives the process.
export { destroyAllSessions } from "./lib/collab-session.js";

// Re-export the zod-agnostic shared tool-spec registry so the in-app AI-SDK
// service can read it off the loaded module (it cannot import the ESM package's
// internals directly; it goes through loadDocmostMcp()).
export { SHARED_TOOL_SPECS } from "./tool-specs.js";
export type { SharedToolSpec } from "./tool-specs.js";
// #489 — write-class registry consumed by the in-app external-MCP retry gate.
export {
  SHARED_TOOL_WRITE_CLASS,
  isRetryableWriteClass,
  assertEverySpecDeclaresWriteClass,
} from "./tool-specs.js";
export type { ToolWriteClass } from "./tool-specs.js";

// Re-export the build-time REGISTRY_STAMP (issue #447): a deterministic hash of
// the tool-specs registry content, generated into src/registry-stamp.generated.ts
// by scripts/gen-registry-stamp.mjs BEFORE tsc, so it lands in build/. The in-app
// loader recomputes the same hash from src/tool-specs.ts (dev/test only) and
// refuses to run on a mismatch, catching a build/ vs src/ skew (a spec edited in
// src without rebuilding the package the server actually loads from build/).
export { REGISTRY_STAMP } from "./registry-stamp.generated.js";

// Re-export the shared "new comments: N" signal helper (#417) so the in-app
// layer reads the SAME watermark/debounce/injection-safe line builder off the
// loaded module (same pattern as SHARED_TOOL_SPECS). Both surfaces then differ
// only in their per-surface probe + result shaping.
export {
  createCommentSignalTracker,
  createListCommentsProbe,
  buildCommentSignalLine,
  defangCommentSignalTitle,
  COMMENT_SIGNAL_EXCLUDED_TOOLS,
  DEFAULT_COMMENT_SIGNAL_DEBOUNCE_MS,
} from "./comment-signal.js";
export type {
  CommentSignalTracker,
  CommentSignalProbe,
  CommentSignalProbeResult,
  CommentSignalTrackerOptions,
} from "./comment-signal.js";
// Re-export the pure, no-network draw.io helpers (#424) so the in-app AI-SDK
// service can wire drawioShapes / drawioGuide off the loaded module. These are
// NOT client methods (no page/backend hit) — the in-app handler calls them
// directly, mirroring how the standalone MCP server wires them here.
export { searchShapes } from "./lib/drawio-shapes.js";
export type { SearchShapesOptions } from "./lib/drawio-shapes.js";
export { getGuideSection } from "./lib/drawio-guide.js";

// Read version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(
  readFileSync(join(__dirname, "../package.json"), "utf-8"),
);
const VERSION = packageJson.version;

// Configuration for an MCP server instance is the DocmostMcpConfig union
// (credentials OR getToken) defined and re-exported above. The factory below is
// fully side-effect-free on import: it reads no environment variables and opens
// no transport. The standalone stdio entrypoint (stdio.ts) and the HTTP handler
// (http.ts) supply this config and own the process/transport lifecycle.

// --- Modern McpServer Implementation ---

// Editing guide surfaced to MCP clients in the initialize result so they can
// pick the right tool by intent and avoid resending whole documents.
//
// The guide is now SPLIT (issue #448): the hand-written routing prose lives in
// server-instructions.ts and the tool INVENTORY is GENERATED from the registry
// (SHARED_TOOL_SPECS + INLINE_MCP_INVENTORY), so it can no longer drift out of
// sync with the registered tools. Re-exported here (its old home) so existing
// importers are unaffected; the composition lives in server-instructions.ts.
// The drawioShapes / drawioGuide tools (#424) stay in SHARED_TOOL_SPECS (so the
// generated <tool_inventory> picks them up from their catalogLine automatically)
// but are flagged `inlineBothHosts` and registered inline below (their pure
// helpers can't cross into tool-specs.ts); only the hand-written routing prose in
// server-instructions.ts is updated to mention them.
export { SERVER_INSTRUCTIONS };

// Helper to format JSON responses
const jsonContent = (data: any) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

/**
 * Create a fully configured Docmost MCP server. Side-effect-free: it does not
 * read environment variables and does not connect any transport — the caller
 * decides how to expose it (stdio or HTTP). The client talks to Docmost over
 * REST + the collaboration WebSocket using the provided service-account
 * credentials and auto-re-authenticates.
 */
/**
 * Wrap a tool handler so its wall-clock duration is reported through the host's
 * dependency-neutral sink as `mcp_tool_duration_seconds` (labelled by tool
 * name). Pure and side-effect-free apart from the optional `onMetric` call:
 *  - preserves the handler's exact return value (awaited);
 *  - observes in a `finally`, so it records on BOTH success and throw, then
 *    rethrows the original error unchanged (never swallowed);
 *  - with no `onMetric` (standalone/stdio) it is a transparent pass-through.
 * Exported so the timing contract can be unit-tested without a live transport.
 */
export function timeToolHandler(
  name: string,
  handler: (...args: any[]) => any,
  onMetric?: (name: string, value: number, labels?: Record<string, string>) => void,
): (...args: any[]) => Promise<any> {
  return async (...handlerArgs: any[]) => {
    const start = performance.now();
    try {
      return await handler(...handlerArgs);
    } finally {
      onMetric?.("mcp_tool_duration_seconds", (performance.now() - start) / 1000, {
        tool: name,
      });
    }
  };
}

/** Resolve the per-page comment-signal debounce (ms) from the environment,
 *  falling back to the shared default. A non-positive/unparseable value keeps
 *  the default so a bad env var can never disable the rate limit. */
function resolveCommentSignalDebounceMs(): number {
  const parsed = parseInt(
    process.env.MCP_COMMENT_SIGNAL_DEBOUNCE_MS ?? "",
    10,
  );
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_COMMENT_SIGNAL_DEBOUNCE_MS;
}

/**
 * Wrap a tool handler so a passive "new comments: N" line (#417) is APPENDED as
 * an extra text content element when the session's watermark advances. ADDITIVE
 * and non-destructive:
 *  - records the call's `pageId` (if any) into the working set;
 *  - for a comment tool (list/check/create), the result is tautological, so no
 *    signal is added and the watermark is advanced instead — the agent just
 *    consumed the feed, so those comments must not re-signal next call;
 *  - otherwise it asks the tracker for a line; when there is NONE the ORIGINAL
 *    result object is returned UNCHANGED (byte-identical no-signal path), and
 *    when there is one it returns a shallow copy with the extra text element
 *    pushed onto `content` (the main result is never mutated in place).
 * Exported so the wrapper contract can be unit-tested without a live transport.
 */
export function withCommentSignal(
  name: string,
  handler: (...args: any[]) => any,
  tracker: CommentSignalTracker,
): (...args: any[]) => Promise<any> {
  return async (...handlerArgs: any[]) => {
    const input = handlerArgs[0];
    const pageId =
      input && typeof input === "object" ? (input as any).pageId : undefined;
    tracker.noteWorkingPage(pageId);

    const result = await handler(...handlerArgs);

    if (tracker.isExcludedTool(name)) {
      tracker.advanceWatermark();
      return result;
    }
    // Only MCP text/content results can carry the extra element; anything else
    // (should not happen — every tool returns a content array) passes through.
    if (!result || !Array.isArray((result as any).content)) return result;

    const line = await tracker.maybeSignal(name);
    if (!line) return result; // no signal => byte-identical original object

    return {
      ...result,
      content: [
        ...(result as any).content,
        { type: "text" as const, text: line },
      ],
    };
  };
}

export function createDocmostMcpServer(config: DocmostMcpConfig): McpServer {
  // Pass the whole config union through: the client branches internally on
  // credentials vs. getToken, so both the external /mcp (creds) and the
  // internal per-user (getToken) paths are wired here unchanged.
  const docmostClient = new DocmostClient(config);

  const server = new McpServer(
    {
      name: "docmost-mcp",
      version: VERSION,
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  // Single choke point for MCP tool timing. Both `registerSharedFromSpec` (below)
  // and the inline `server.registerTool(...)` calls funnel through this one
  // method, so monkeypatching it HERE — before any tool is registered and before
  // the registry loop captures a reference to it — times every tool with no
  // per-tool boilerplate. The wrapped handler records wall-clock duration and,
  // in a `finally`, feeds the host's dependency-neutral sink
  // `config.onMetric("mcp_tool_duration_seconds", seconds, { tool })`. The tool
  // name is the registration name (bounded cardinality). When no onMetric is
  // provided (standalone/stdio) the wrapper is a pure pass-through: it still
  // returns the original result and rethrows the original error unchanged.
  // Passive "new comments: N" signal (#417). Per-SESSION state (this factory runs
  // once per MCP session — http.ts creates one server + one DocmostClient per
  // session), so the watermark/working-set/debounce live right next to the
  // client. REST-only surface => the count source (option 2) is a rate-limited
  // `listComments` over the working-set pages: the tracker guarantees at most one
  // list call per page per debounce window, and the page title is fetched ONLY
  // when there is something to report (count>0), so the steady no-signal cost is
  // a single list call per page per window and an empty working set => zero calls.
  const commentSignal = createCommentSignalTracker({
    debounceMs: resolveCommentSignalDebounceMs(),
    // Shared count-source probe (#494): counts comments newer than the watermark
    // over the full feed and labels a hit with the light page title. The in-app
    // host uses the SAME factory, so the two probe bodies can no longer drift.
    probe: createListCommentsProbe(docmostClient),
  });

  // Single choke point again: the timing monkeypatch (above) and the new comment
  // signal wrapper both funnel through server.registerTool, so wrapping HERE adds
  // the passive signal to EVERY tool result with no per-tool boilerplate. The
  // signal wrapper is OUTERMOST (it wraps the timed handler) so the probe latency
  // is never counted as the tool's own `mcp_tool_duration_seconds`.
  const originalRegisterTool = server.registerTool.bind(server) as (
    ...args: any[]
  ) => any;
  (server as any).registerTool = (...args: any[]) => {
    const name = args[0] as string;
    const handler = args[args.length - 1];
    const timedHandler = timeToolHandler(name, handler, config.onMetric);
    const signalledHandler = withCommentSignal(name, timedHandler, commentSignal);
    return originalRegisterTool(...args.slice(0, -1), signalledHandler);
  };

  // Register EVERY shared tool from the zod-agnostic registry in one loop (#445).
  // The spec owns the canonical name + description + (optional) schema builder AND
  // the canonical execute mapping; the host only supplies the RESULT ENVELOPE. For
  // each spec:
  //   - skip `inAppOnly` specs (they belong to the in-app host only);
  //   - if the spec has an `mcpExecute` override (a deliberate per-layer
  //     difference — a guardrail, an omitted param, or a non-JSON envelope like a
  //     resource_link/bare success line), the override OWNS the full MCP content
  //     result and is used VERBATIM;
  //   - otherwise the canonical `execute` returns RAW data and this host wraps it
  //     in the standard JSON text envelope (jsonContent), exactly as the old inline
  //     bodies did.
  // buildShape is invoked with THIS package's zod (v3); the in-app layer passes its
  // own zod (v4). The registry's execute returns `unknown` (it is zod-agnostic), so
  // the wrapping is typed loosely and cast — runtime behaviour is unchanged.
  const registerSharedFromSpec = (spec: SharedToolSpec) => {
    if (spec.inAppOnly) return;
    // `inlineBothHosts` specs (drawioShapes / drawioGuide) carry no execute —
    // their pure helper cannot cross into the zod-agnostic tool-specs.ts, so they
    // are registered INLINE below (searchShapes / getGuideSection). Skip them here
    // so the loop never dereferences a missing `execute`.
    if (spec.inlineBothHosts) return;
    const handler = async (args: any) => {
      if (spec.mcpExecute) {
        // The override owns the full MCP result envelope (not re-wrapped).
        return (await spec.mcpExecute(docmostClient, args)) as {
          content: { type: "text"; text: string }[];
        };
      }
      // Canonical execute returns raw data; wrap it as JSON text content. The `!`
      // is backed by assertEverySpecIsRegisterable() (#494), which runs at
      // tool-specs module load and throws if a non-inline, non-inAppOnly spec
      // reaches this loop without an execute/mcpExecute — so this can no longer be
      // a call-time TypeError in production.
      const raw = await spec.execute!(docmostClient, args);
      return jsonContent(raw);
    };
    return (server.registerTool as any)(
      spec.mcpName,
      spec.buildShape
        ? { description: spec.description, inputSchema: spec.buildShape(z) }
        : { description: spec.description },
      handler,
    );
  };

  for (const spec of Object.values(SHARED_TOOL_SPECS)) {
    registerSharedFromSpec(spec as SharedToolSpec);
  }

  // --- INLINE drawio helper tools (IN the shared registry, but inlineBothHosts) ---
  // drawioShapes / drawioGuide (#424) live in SHARED_TOOL_SPECS (so the shared
  // contract pins their name/description/schema across both hosts) but carry the
  // `inlineBothHosts` flag and NO execute: their pure backing helpers
  // (searchShapes / getGuideSection) cannot be value-imported into the
  // zod-agnostic tool-specs.ts without breaking the in-app server's commonjs
  // type-check (searchShapes' catalog loader uses import.meta). So both hosts wire
  // them directly. Here on the MCP host they reuse the spec's name/description/
  // schema and wrap the raw helper result as JSON text content — byte-identical to
  // what the registry loop would have produced. The in-app host mirrors this in
  // ai-chat-tools.service.ts.
  {
    // Cast registerTool like the loop's registerSharedFromSpec does: the spec's
    // buildShape returns the loose zod-agnostic ZodRawShape (Record<string,
    // unknown>) and the handler args are the SDK-validated, type-erased input.
    const registerInline = server.registerTool as any;
    const shapesSpec = SHARED_TOOL_SPECS.drawioShapes as SharedToolSpec;
    registerInline(
      shapesSpec.mcpName,
      {
        description: shapesSpec.description,
        inputSchema: shapesSpec.buildShape!(z),
      },
      async ({ query, category, limit }: any) => {
        const results = searchShapes(query, { category, limit });
        return jsonContent({ query, count: results.length, results });
      },
    );
    const guideSpec = SHARED_TOOL_SPECS.drawioGuide as SharedToolSpec;
    registerInline(
      guideSpec.mcpName,
      {
        description: guideSpec.description,
        inputSchema: guideSpec.buildShape!(z),
      },
      async ({ section }: any) => jsonContent(getGuideSection(section)),
    );
  }

  // --- INLINE tools kept per-transport (NOT in the shared registry) ---
  // Each stays inline for a documented reason: a snake_case/camelCase naming
  // clash the registry convention forbids (tableGet), an intentional
  // per-transport behaviour/schema divergence (search, docmostTransform), or a
  // tool that exists ONLY on this standalone MCP surface (updateComment,
  // deleteComment — the in-app agent deliberately exposes no hard comment
  // edit/delete tool).

  // Tool: tableGet
// NOT in the shared registry: the MCP tool name `tableGet` is noun-first while
// the in-app key is `getTable` (verb-first), breaking the snake_case(inAppKey)
// convention the shared registry enforces (shared-tool-specs.contract.spec.ts).
// Renaming the public MCP tool would break external clients, so it stays inline.
server.registerTool(
  "tableGet",
  {
    description:
      "Read a table as a matrix. Returns {rows, cols, cells (text[][]), " +
      "cellIds (paragraph id per cell, or null)}. `table` = `#<index>` from " +
      "getOutline, or any block id inside the table. Use cellIds with " +
      "patchNode for rich-formatted cell edits. `cols` is the FIRST row's " +
      "width; ragged tables may vary per row, so use the per-row length of " +
      "`cells` for each row. Reflects your own just-made edit immediately " +
      "(read-after-write); a rare freshness:\"stale-fallback\" in the result " +
      "means re-read shortly for the settled version.",
    inputSchema: {
      pageId: z.string().min(1),
      table: z.string().min(1),
    },
  },
  async ({ pageId, table }) => {
    const result = await docmostClient.getTable(pageId, table);
    return jsonContent(result);
  },
);

// Tool: updateComment
server.registerTool(
  "updateComment",
  {
    description:
      "Update an existing comment's content. Only the comment creator can " +
      "update it. Content is provided as Markdown.",
    inputSchema: {
      commentId: z.string().min(1).describe("ID of the comment to update"),
      content: z
        .string()
        .min(1)
        .describe("New comment content in Markdown format"),
    },
  },
  async ({ commentId, content }) => {
    const result = await docmostClient.updateComment(commentId, content);
    return jsonContent(result);
  },
);

// Tool: deleteComment
server.registerTool(
  "deleteComment",
  {
    description:
      "Delete a comment. Only the comment creator or space admin can delete it.",
    inputSchema: {
      commentId: z.string().min(1).describe("ID of the comment to delete"),
    },
  },
  async ({ commentId }) => {
    await docmostClient.deleteComment(commentId);
    return {
      content: [
        {
          type: "text" as const,
          text: `Successfully deleted comment ${commentId}`,
        },
      ],
    };
  },
);

// Tool: search
// INTENTIONAL per-transport divergence (not shared): the in-app `searchPages`
// runs a semantic + keyword hybrid (RRF) with in-process access control and a
// different schema; this transport is the #443 agent-lookup search — a hybrid
// substring + full-text search that also returns each hit's location (`path`)
// and a windowed `snippet`, so one call answers "where is it and what's in it".
// The in-app hybrid-RRF search is deliberately NOT touched. Different behaviour
// AND schema, so kept per-layer.
//
// STANDALONE-vs-STOCK-UPSTREAM: the client sends the opt-in `substring`/
// `parentPageId`/`titleOnly` DTO fields. A stock upstream server validates the
// DTO with `whitelist: true` and silently strips these unknown fields, so the
// request degrades gracefully to plain FTS (no path/snippet, current shape).
//
// EE/TYPESENSE DEGRADATION (#443): on an instance whose SEARCH_DRIVER is
// `typesense`, the server routes this request to the Typesense backend, which
// does NOT implement agent-lookup — the substring/path/snippet/tiering is
// ignored and the response degrades to plain Typesense FTS. The rich lookup
// shape is only produced by the native Postgres search driver.
server.registerTool(
  "search",
  {
    description:
      "Search pages across the wiki. OR by default with relevance ranking " +
      "(RU+EN morphology): multi-word queries match ANY term, not all. " +
      "Operators: \"exact phrase\" (adjacent words), +term (require), -term " +
      "(exclude) — e.g. `+кофейня -архив`, `+\"воздушный шар\" кофе`. A leading " +
      "-/+ is the operator; -,.,: INSIDE a token are literal (`WB-MGE-30D86B`, " +
      "`10.0.12.5` stay one term). Technical fragments (hostnames, IPs, IDs) " +
      "auto-match as substrings; words use full-text. Each hit returns its " +
      "location (`path`: ancestor titles root→parent), a `snippet`, `score`, " +
      "`matchedTerms` and `matchedFields`, so you rarely need a follow-up " +
      "getPage. Paginate with limit + offset; the response carries " +
      "`total` (exact, permission-filtered), `hasMore` and `truncatedAtCap`. " +
      "NOTE: results past the relevance cap (~500) are unreachable by " +
      "pagination — narrow the query (add terms / +required / a spaceId) " +
      "instead when `truncatedAtCap` is true.",
    inputSchema: {
      query: z.string().min(1).describe("Search query (supports \"phrase\", +require, -exclude)"),
      spaceId: z
        .string()
        .optional()
        .describe("Restrict the search to a single space"),
      parentPageId: z
        .string()
        .optional()
        .describe(
          "Restrict to a page and all its descendants (the page itself included)",
        ),
      titleOnly: z
        .boolean()
        .optional()
        .describe("Match page titles only; skip page text"),
      match: z
        .enum(["auto", "word", "prefix", "substring"])
        .optional()
        .describe(
          "Match mode (default auto: identifiers→substring, words→full-text). " +
            "Override with word/prefix/substring.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max results to return (1-50, default 10)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Pagination offset (default 0); use with total/hasMore"),
    },
  },
  async ({ query, spaceId, parentPageId, titleOnly, match, limit, offset }) => {
    const result = await docmostClient.search(query, spaceId, limit, {
      parentPageId,
      titleOnly,
      match,
      offset,
    });
    return jsonContent(result);
  },
);

// Tool: docmostTransform
// INTENTIONAL per-transport divergence (not shared): the in-app `transformPage`
// deliberately omits the `deleteComments` schema field (comment-deletion
// guardrail) and carries a much shorter description; this transport exposes the
// full helper catalogue. Different schema, so kept per-layer.
server.registerTool(
  "docmostTransform",
  {
    description:
      "Edit a page by running an arbitrary JS transform `(doc, ctx) => doc` " +
      "against its LIVE ProseMirror document, with a diff preview and page " +
      "history as the safety net. By default dryRun=true: returns a diff " +
      "preview WITHOUT writing. Set dryRun=false to apply (atomic, won't " +
      "clobber concurrent edits). `doc` is the lossless ProseMirror document " +
      "({type:'doc',content:[...]}); return a new doc of the same shape. " +
      "`ctx` gives you: comments (the page's comments, each {id, content " +
      "(markdown), selection, type}); log (array; console.log pushes to it); " +
      "consume(id) (mark a comment id as consumed — those are deleted when " +
      "deleteComments=true after a successful apply); and `ctx.helpers`: " +
      "blockText(node) (plain text), walk(node, fn) (depth-first over all " +
      "nodes incl. callouts/tables/lists), getList(doc, predicate) (find a " +
      "node even without attrs.id), insertMarkerAfter(doc, anchor, marker, " +
      "{beforeBlock}) (insert a plain unmarked text run after anchor, " +
      "mark-safe), setCalloutRange(doc, n) (sync a [1]…[K] callout range to " +
      "[1]…[n]), noteItem(inlineNodes) (wrap inline nodes in a listItem with a " +
      "fresh id), mdToInlineNodes(markdown) (comment markdown -> inline nodes), " +
      "commentsToFootnotes(doc, comments, {notesHeading}) (turn inline " +
      "comments into numbered footnotes), canonicalizeFootnotes(doc) (derive " +
      "footnote numbering + the single bottom list from reference order, drop " +
      "orphans/duplicates — runs AUTOMATICALLY on the transform RESULT, so the " +
      "applied (and dryRun-previewed) doc is always footnote-canonical; a dryRun " +
      "diff may therefore show footnote tidy-ups your script did not make, and " +
      "it is idempotent after the first run), and " +
      "insertInlineFootnote(doc, {anchorText, text}) (author-inline footnote: " +
      "marker + dedup'd definition, list derived). Footnote convention: markers are " +
      "plain '[N]' text in the body; the notes are an orderedList under a " +
      "heading whose text is 'Примечания переводчика' (that is only the DEFAULT " +
      "notesHeading — pass the notesHeading option to the helpers to use a " +
      "heading matching the page's language). The transform runs " +
      "sandboxed (no require/process/fs/network, 5s timeout) and must return a " +
      "{type:'doc'} node.",
    inputSchema: {
      pageId: z.string().min(1),
      transformJs: z
        .string()
        .min(1)
        .describe(
          "A JS function `(doc, ctx) => doc` (expression-arrow or " +
            "parenthesized function). It receives a clone of the live doc and " +
            "ctx (comments, log, consume(id) on `ctx`; helpers under " +
            "`ctx.helpers`, e.g. `ctx.helpers.blockText(node)` NOT " +
            "`ctx.blockText`: blockText/walk/getList/insertMarkerAfter/" +
            "setCalloutRange/noteItem/mdToInlineNodes/commentsToFootnotes/" +
            "canonicalizeFootnotes/insertInlineFootnote) " +
            "and must return a {type:'doc'} node.",
        ),
      dryRun: z
        .boolean()
        .optional()
        .default(true)
        .describe("Preview only (no write) when true (default)."),
      deleteComments: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "After a successful apply, delete every comment id passed to " +
            "ctx.consume(id).",
        ),
    },
  },
  async ({ pageId, transformJs, dryRun, deleteComments }) => {
    const result = await docmostClient.transformPage(pageId, transformJs, {
      dryRun,
      deleteComments,
    });
    return jsonContent(result);
  },
);

// Tool: uploadFile (issue #608)
// INLINE, MCP-ONLY (deliberately NOT shared): the byte-fed upload path is
// meaningless to the in-app AI chat — that host has no local files to base64,
// and streaming megabytes of base64 through tool arguments would be actively
// harmful. So it is registered only on this external MCP surface, never in the
// shared registry the in-app agent draws from.
server.registerTool(
  "uploadFile",
  {
    description:
      "Upload a file from base64 BYTES (any type) as a page attachment and get " +
      "back a ready-to-insert node. Unlike insertImage/replaceImage (which take " +
      "an http(s) URL the SERVER fetches), you ship the bytes here — no public " +
      "URL needed, and non-image types work. `content` is base64 (a " +
      "`data:<mime>;base64,...` URI is also accepted). The served Content-Type " +
      "is derived from the file-name EXTENSION, so give `fileName` a correct " +
      "extension (or set `mime` and it will be appended). Image types become an " +
      "inline image node; everything else becomes an attachment (download) card. " +
      "With `insert:false` (default) nothing is placed — you get `node` to insert " +
      "yourself later. With `insert:true` the node is placed (position " +
      "append/before/after; before/after need exactly one of anchorText / " +
      "anchorNodeId). IMPORTANT: on insert ALWAYS check `inserted` in the result: " +
      "if it is false, the upload SUCCEEDED but placement failed — see " +
      "`insertError` and insert the returned `node` yourself via insertNode.",
    inputSchema: {
      pageId: z.string().min(1).describe("Page id (UUID or slugId) to attach to"),
      content: z
        .string()
        .min(1)
        .describe(
          "File bytes as base64 (a data:<mime>;base64,<...> URI is also accepted)",
        ),
      fileName: z
        .string()
        .min(1)
        .describe(
          "File name incl. extension — the extension drives the served Content-Type",
        ),
      mime: z
        .string()
        .optional()
        .describe(
          "Optional desired MIME; its canonical extension is appended to fileName if missing",
        ),
      insert: z
        .boolean()
        .optional()
        .describe("Insert the node into the page in the same call (default false)"),
      as: z
        .enum(["image", "file"])
        .optional()
        .describe("Force the node kind (default: auto — image mimes -> image node)"),
      align: z
        .enum(["left", "center", "right"])
        .optional()
        .describe("Image alignment (image node only)"),
      alt: z.string().optional().describe("Image alt text (image node only)"),
      position: z
        .enum(["before", "after", "append"])
        .optional()
        .describe("Where to insert when insert=true (default append)"),
      anchorText: z
        .string()
        .optional()
        .describe("For before/after: the anchor block's literal plain text"),
      anchorNodeId: z
        .string()
        .optional()
        .describe("For before/after: the anchor block's attrs.id"),
    },
  },
  async ({
    pageId,
    content,
    fileName,
    mime,
    insert,
    as,
    align,
    alt,
    position,
    anchorText,
    anchorNodeId,
  }) => {
    const result = await docmostClient.uploadFile(pageId, content, fileName, {
      mime,
      insert,
      as,
      align,
      alt,
      position,
      anchorText,
      anchorNodeId,
    });
    return jsonContent(result);
  },
);

// Tool: downloadFile (issue #613)
// INLINE, MCP-ONLY (mirrors uploadFile, deliberately NOT shared): the in-app AI
// chat has its own `viewImage` for reading an attachment's bytes, so this
// external-only download primitive — the symmetric partner of uploadFile and the
// elegant fix for the cross-instance image-migration blocker — is registered only
// on this external MCP surface, never in the shared registry the in-app agent draws
// from. The url branch owns its own MCP envelope (resource_link + structuredContent,
// like stashPage), so it is NOT wrapped in jsonContent.
server.registerTool(
  "downloadFile",
  {
    description:
      "Download an INTERNAL Docmost attachment's bytes by its `/api/files/<id>/<name>` " +
      "src/url — the value getPageJson/getNode/uploadFile hand you (an image node's " +
      "`src`, an attachment node's `url`). The file is ALWAYS fetched from THIS Docmost " +
      "instance: if you pass an ABSOLUTE url its HOST is IGNORED and only the " +
      "/api/files/... PATH is used, so a url copied from ANOTHER instance does NOT " +
      "download that instance's file (you get this instance's file with that id, or a " +
      "404) — to move a file between instances, call downloadFile on the SOURCE instance " +
      "and uploadFile on the target. A src whose path is not /api/files/<id>/<name> is " +
      "rejected. The result is DISCRIMINATED by `kind`: `base64` returns the bytes " +
      "base64-encoded INTO the context (use for SMALL files only — it costs tokens) plus " +
      "{ mime, fileName, attachmentId, size }; `url` returns a short ANONYMOUS URL any " +
      "server can fetch WITHOUT auth (the way to hand a file to insertImage/replaceImage " +
      "on another instance) plus { sha256, mime, fileName, size } — that URL is PUBLIC and " +
      "NON-revocable until it expires (~1h TTL, RAM-only). `format` (default 'auto'): " +
      "'base64' bytes-in-context, 'url' anonymous URL, 'auto' picks base64 when it fits " +
      "the context ceiling (~1 MiB) else the anonymous URL. Oversize files error with the " +
      "exact byte limit and the alternative to use.",
    inputSchema: {
      src: z
        .string()
        .min(1)
        .describe(
          "Internal attachment URL/src: /api/files/<id>/<fileName> (the bare /files/... form is also accepted). If you pass an absolute URL, its host is IGNORED — only this path is used and the file is fetched from THIS instance.",
        ),
      format: z
        .enum(["base64", "url", "auto"])
        .optional()
        .describe(
          "Return shape: 'base64' (bytes in context — small files only), 'url' (anonymous ~1h URL), 'auto' (default: base64 if small else url)",
        ),
      maxBase64Bytes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Override the base64 ceiling in bytes (still clamped to a context-safe maximum)",
        ),
    },
  },
  async ({ src, format, maxBase64Bytes }) => {
    const result = await docmostClient.downloadFile(src, {
      format,
      maxBase64Bytes,
    });
    if (result.kind === "url") {
      // Mirror stashPage's envelope: deliver the blob as a resource_link (the URL
      // and the bytes stay OUT of the model context) PLUS a structuredContent
      // mirror of the documented shape.
      return {
        content: [
          {
            type: "resource_link" as const,
            uri: result.uri,
            name: result.fileName ?? "attachment",
            mimeType: result.mime,
            size: result.size,
          },
        ],
        structuredContent: {
          kind: result.kind,
          uri: result.uri,
          sha256: result.sha256,
          mime: result.mime,
          fileName: result.fileName,
          attachmentId: result.attachmentId,
          size: result.size,
        },
      };
    }
    // base64: the bytes are intentionally in-context (the caller asked for / auto
    // chose a small file) → the standard JSON text envelope.
    return jsonContent(result);
  },
);

  return server;
}
