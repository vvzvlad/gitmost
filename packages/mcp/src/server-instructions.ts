// SERVER_INSTRUCTIONS — the editing guide surfaced to MCP clients in the
// initialize result so they can pick the right tool by intent and avoid
// resending whole documents.
//
// This guide is split into TWO parts that are composed at the bottom:
//
//  1. ROUTING_PROSE — the hand-written "when to use what" intent hints (READ /
//     EDIT / PAGES / COMMENTS / HISTORY). This is legitimately manual: it
//     encodes editorial judgement (which tool for which situation, the cheap-
//     first ordering, the guardrail nudges) that cannot be derived from the
//     registry. It is NOT the drift-guard for the tool set.
//
//  2. A GENERATED <tool_inventory> — every tool the server registers, listed
//     by name + one-line purpose, grouped by family, built from the SAME
//     registry the server registers tools from (SHARED_TOOL_SPECS' mcpName +
//     catalogLine) PLUS the handful of inline MCP-only tools (their inventory
//     lines live in INLINE_MCP_INVENTORY below). Because this list is BUILT
//     from the registry, it can never drift out of sync with the registered
//     tools — adding/renaming/removing a spec changes it automatically, with no
//     prose edit and no scraper test. An unmapped tool still appears (under
//     "OTHER"), so a new tool can never silently vanish from the guide.
//
// This replaces the old hand-maintained monolithic guide + its regex scraper
// test (test/unit/server-instructions.test.mjs), which only checked that every
// registered name appeared SOMEWHERE in the prose and drifted whenever a name
// was reworded.
//
// OUT OF SCOPE (issue #448): the README / README.ru tool catalogs are still
// hand-maintained prose and are NOT generated from this registry. Regenerating
// them from SHARED_TOOL_SPECS is tracked separately as an optional docs script
// under issue #412 — until then a tool rename still needs a manual README edit.

import { SHARED_TOOL_SPECS, SharedToolSpec } from "./tool-specs.js";

/**
 * The hand-written routing prose — the intent hints that tell a client which
 * tool to reach for in which situation. Kept manual on purpose (it encodes
 * editorial judgement, not a mechanical name list). The generated inventory
 * below is spliced in after it.
 */
export const ROUTING_PROSE =
  "Docmost editing guide — choose the tool by intent. The <tool_inventory> at the end lists every tool with a one-line purpose; the notes below are the routing hints for WHEN to reach for each.\n" +
  "READ: find pages across the wiki -> search — OR by default with relevance ranking and RU+EN morphology (multi-word matches ANY term). Operators: \"exact phrase\", +require, -exclude (e.g. `+кофейня -архив`, `+\"воздушный шар\" кофе`); a leading -/+ is the operator, but -,.,: inside a token are literal (WB-MGE-30D86B, 10.0.12.5 stay one term, auto-matched as substrings). Each hit returns its location (path: root->parent titles), a snippet, score, matchedTerms/matchedFields, so you rarely need a follow-up getPage; scope with spaceId or parentPageId (a subtree), titleOnly to match titles only, match to override auto. Paginate with limit+offset; total is exact and permission-filtered, hasMore/truncatedAtCap flag more. Results past the relevance cap (~500) are UNREACHABLE by pagination — when truncatedAtCap is true, narrow the query (add terms / +required / a spaceId) rather than page deeper. A space's page HIERARCHY (or one subtree) -> getTree (one request, complete, `{pageId,title,children?}`; rootPageId for a subtree, maxDepth to trim depth — a trimmed node gets hasChildren:true); prefer it over listPages tree:true (deprecated). Have a pageId, need WHERE-AM-I / what's around it (its breadcrumbs + direct children, metadata only) -> getPageContext (one call; parent = last breadcrumb, [] for a root page). list -> listPages / listSpaces. Locate blocks and their ids CHEAPLY -> getOutline (compact top-level map; start here, not getPageJson). One block, for editing -> getNode (by attrs.id — block ids live on paragraphs and headings, a few containers too — or \"#<index>\" from getOutline for any other top-level block: tables, lists, quotes, dividers, callouts, images and code blocks carry no id) — returns MARKDOWN by default (comment anchors kept for safe write-back); pass format:\"json\" for the raw ProseMirror subtree. Find every occurrence of a string/regex ON a page (and where each is) -> searchInPage, NOT block-by-block getNode — it returns each hit's node ref + block index + context for a targeted comment. These four structural reads (getOutline/getNode/searchInPage/tableGet) reflect your OWN just-made edit to a page immediately (read-after-write), even before the debounced store settles; on a rare freshness degradation the result carries freshness:\"stale-fallback\" — repeat the read a moment later for the settled version. Whole page -> getPage (Markdown, canonical for text; drops only block ids, resolved-comment anchors, and a fixed no-md-representation attr set: table spans/colwidth/bg, indent, callout.icon, orderedList.type, link internal/target/rel/class; inline <span data-comment-id> tags are comment anchors — markup, not text) or getPageJson (full ProseMirror with block ids, for those dropped attrs). Both also return a baseHash — keep it if you intend a full-body overwrite (updatePageJson/updatePageMarkdown require it). Hand a huge page (with images) to an external consumer without pulling it through the model context -> stashPage (returns a short-lived anonymous URL). Pull ONE internal attachment's raw bytes (e.g. to migrate a file to another instance) -> downloadFile: base64 for a small file (enters context) or a short anonymous URL the receiving server can fetch without auth (format: base64|url|auto).\n" +
  "EDIT: fix wording/typos/numbers -> editPageText (find/replace inside blocks, no node id needed). Edit a block -> getNode(markdown) -> edit the markdown -> patchNode(markdown) (by attrs.id from getOutline; the markdown fragment may be several blocks — a 1->N section rewrite in one call, the first block keeps the id). Reach for patchNode's `node`-JSON only for fine attr/mark work; a table cell with spans/colors/fixed width -> the table tools (patchNode markdown refuses it). Add a block -> insertNode (markdown, before/after a block by attrs.id or by anchor text, or append; `node` for raw JSON or bare table structure). Remove a block -> deleteNode (by attrs.id). NOTE on ids: they sit on paragraphs and headings (a few containers carry one too) and are matched ANYWHERE in the tree, so a paragraph nested in a list item, quote, table cell or callout is patchable/deletable IF it has an id — markdown-imported ones often have none, and getOutline never shows nested ids (see getPageJson, tableGet cellIds, searchInPage nodeId). Without an id the \"#<index>\" form does NOT work with patchNode/deleteNode: use editPageText (needs none), the specialised tool below when one fits (the table tools, insertImage/replaceImage, the drawio tools), or docmostTransform (detailed below) to restructure/remove a whole list, table, quote or callout — its ctx.helpers.getList finds a node without an id. Tables -> tableGet / tableUpdateCell / tableInsertRow / tableDeleteRow (address by \"#<index>\" from getOutline; table nodes have no attrs.id). Images -> insertImage (add from a web URL) / replaceImage (swap an existing image). Draw.io diagrams -> PREFER the high-level semantic tools that hide coordinates/styles: drawioFromGraph (architecture/cloud/network diagrams — describe nodes/groups/edges by kind+icon, the server picks layout, colors and verified icons; hints layer/sameLayerAs/pinned and layout:full|incremental|none) and drawioFromMermaid (standard flowcharts — write Mermaid, get an editable diagram). For targeted tweaks of an existing diagram use drawioEditCells (id-based add/update/delete with cascade delete + baseHash lock). Raw mxGraph XML via drawioCreate/drawioUpdate is the escape-hatch for exotic/wireframe diagrams; drawioGet reads a diagram as mxGraph XML + a hash (pass it as baseHash to drawioUpdate/drawioEditCells for optimistic locking). Before authoring raw XML, drawioShapes (look up verified stencil style-strings so a shape name never renders as an empty box) and drawioGuide (on-demand authoring reference: skeleton/layout/containers/icons-aws/icons-azure), and pass layout:\"elk\" to drawioCreate/drawioUpdate to auto-place nodes. Footnotes -> insertFootnote. Bulk/structural rewrite is a LAST RESORT -> updatePageJson (full ProseMirror replace) or updatePageMarkdown (full plain-Markdown body replace, re-imported — block ids regenerate); STRONGLY prefer the granular tools above (they merge with concurrent edits and keep ids). A full overwrite is baseHash-GUARDED: read first (getPageJson/getPage), keep the returned baseHash, then write WITH it; if the page changed since your read the write is REJECTED (409, nothing written) — re-read for a fresh baseHash and retry a BOUNDED number of times (there is no force; a page a human is actively typing into will keep rejecting, so back off and report rather than loop). Also avoids resending the whole ~100KB+ document on every small change. Complex/scripted rewrite (multiple coordinated edits, renumbering) -> docmostTransform: write a JS `(doc, ctx) => doc` transform, preview the diff with dryRun (default), then apply with dryRun:false; ctx.helpers includes commentsToFootnotes for turning inline comments into numbered footnotes.\n" +
  "PAGES: new -> createPage (Markdown). Rename (title only) -> renamePage. Move -> movePage. Delete -> deletePage (SOFT delete — the page goes to trash and is restorable; nothing is permanent). Copy/replace a page's whole content from another page (server-side, no document through the model) -> copyPageContent. Sharing -> sharePage / unsharePage / listShares; sharePage makes the page PUBLICLY accessible — do it only when explicitly asked.\n" +
  "COMMENTS: createComment is always inline and requires an EXACT selection — contiguous text from a single block, <=250 chars (fails rather than leaving an unanchored comment); reply to a thread via parentCommentId. Propose a concrete text fix for one-click human approval -> createComment with suggestedText (the exact plain-text replacement for the selection; the selection must then be UNIQUE in the page — extend it with context if needed); prefer this over editing directly when the change is subjective or needs the author's sign-off. Manage -> listComments, updateComment, resolveComment (resolve/reopen, reversible — prefer over delete to close), deleteComment, checkNewComments.\n" +
  "HISTORY: review what changed -> diffPageVersions (a historyId vs current, or two versions). List saved versions -> listPageHistory. Undo a bad edit -> restorePageVersion (writes a past version back as current; itself revertible). Pin the page's CURRENT content as a restorable named checkpoint BOTH before you start a round of edits to existing content (a safety before-point you can roll back to) AND after you finish the round -> savePageVersion; but do NOT pre-save when the PURPOSE of the edit is to REMOVE sensitive/confidential content (pre-saving would preserve what you're removing in recoverable, permission-shared history) — pre-save only for edits that ADD or REVISE content (kind derived server-side as an agent version; an identical-to-last save is promoted/no-op'd, so a redundant call is harmless). Export a page to self-contained Docmost Markdown (with comment anchors) -> exportPageMarkdown.";

/**
 * Non-tool camelCase identifiers that legitimately appear in ROUTING_PROSE:
 * parameter names, helper names, and type fragments. The REVERSE drift-guard
 * (`unregisteredProseToolMentions`) subtracts these before checking that every
 * remaining multi-word (camelCase) token in the prose is a REGISTERED tool — so a
 * rename/removal that leaves a DEAD tool reference in the prose reddens, while an
 * ordinary parameter mention does not. The generated <tool_inventory> already
 * guards the FORWARD direction (every registered tool appears); this closes the
 * reverse (the prose could previously name a nonexistent tool and nothing
 * reddened). A new non-tool term in the prose is a loud one-line addition here.
 */
export const PROSE_NON_TOOL_TERMS: ReadonlySet<string> = new Set([
  // tool PARAMETERS mentioned in the routing hints
  "spaceId",
  "parentPageId",
  "titleOnly",
  "pageId",
  "rootPageId",
  "maxDepth",
  "hasChildren",
  "sameLayerAs",
  "baseHash",
  "dryRun",
  "parentCommentId",
  "suggestedText",
  "historyId",
  // search RESPONSE fields documented in the routing prose (#529) — schema
  // fields the search tool returns, not tools themselves
  "matchedTerms",
  "matchedFields",
  "hasMore",
  "truncatedAtCap",
  // helper / value fragments
  "orderedList", // "orderedList.type" (a dropped attr, not a tool)
  "mxGraph", // "mxGraph XML"
  "commentsToFootnotes", // a docmostTransform ctx helper, not a tool
  "getList", // "ctx.helpers.getList" — a docmostTransform ctx helper, not a tool
  "cellIds", // "tableGet cellIds" — a tableGet RESULT field, not a tool
  "nodeId", // "searchInPage nodeId" — a searchInPage RESULT field, not a tool
  // camelCase tokenizer artifact: "ProseMirror" -> "rose" + "Mirror"
  "roseMirror",
]);

/**
 * The set of tool names the MCP host actually registers: every shared-registry
 * spec that is NOT `inAppOnly` (its `mcpName`) PLUS every inline MCP-only tool.
 * This is the authority the reverse prose-guard checks against.
 */
export function registeredMcpToolNames(
  specs: Record<string, SharedToolSpec> = SHARED_TOOL_SPECS,
  inline: ToolInventoryLine[] = INLINE_MCP_INVENTORY,
): Set<string> {
  const names = new Set<string>();
  for (const spec of Object.values(specs)) {
    if (spec.inAppOnly) continue; // not registered on the MCP host
    names.add(spec.mcpName);
  }
  for (const l of inline) names.add(l.name);
  return names;
}

/**
 * REVERSE drift-guard (#494): return the multi-word (camelCase) tokens in the
 * routing prose that look like a tool name but are NOT registered and are NOT a
 * known non-tool term. An empty result means the prose references only real
 * tools. A non-empty result is a dead/renamed reference (a token like
 * `getPageContent` after `getPageJson` was the real name) OR a new parameter that
 * belongs in PROSE_NON_TOOL_TERMS. Scoped to camelCase tokens on purpose:
 * single-word names (`search`) are indistinguishable from English words, and the
 * forward inventory already lists every registered tool.
 */
export function unregisteredProseToolMentions(
  prose: string = ROUTING_PROSE,
  specs: Record<string, SharedToolSpec> = SHARED_TOOL_SPECS,
  inline: ToolInventoryLine[] = INLINE_MCP_INVENTORY,
): string[] {
  const registered = registeredMcpToolNames(specs, inline);
  const tokens = new Set(prose.match(/[a-z][a-zA-Z0-9]+/g) ?? []);
  return [...tokens].filter(
    (t) =>
      /[A-Z]/.test(t) && // multi-word camelCase only
      !registered.has(t) &&
      !PROSE_NON_TOOL_TERMS.has(t),
  );
}

/**
 * A single generated inventory line: the tool's registered NAME + a one-line
 * purpose. For a registry tool the purpose is its `catalogLine` (falling back
 * to the first sentence of its description); for an inline MCP-only tool it is
 * the hand-written line in INLINE_MCP_INVENTORY.
 */
export interface ToolInventoryLine {
  name: string;
  purpose: string;
}

/**
 * The families the inventory is grouped under, in display order. A tool is
 * placed by looking its mcpName up in TOOL_FAMILY; anything not listed there
 * falls into "OTHER" so it is never dropped from the guide.
 */
const FAMILY_ORDER = [
  "READ",
  "EDIT",
  "PAGES",
  "COMMENTS",
  "HISTORY",
  "OTHER",
] as const;
type Family = (typeof FAMILY_ORDER)[number];

/**
 * mcpName -> family for the generated inventory grouping. Purely cosmetic (it
 * orders the inventory to mirror the routing prose); an unmapped tool still
 * appears under OTHER, so forgetting to add an entry here can never drop a tool
 * from the guide — it only lands it in the catch-all group.
 */
const TOOL_FAMILY: Record<string, Family> = {
  // READ
  search: "READ",
  listPages: "READ",
  getTree: "READ",
  getPageContext: "READ",
  listSpaces: "READ",
  getOutline: "READ",
  getNode: "READ",
  searchInPage: "READ",
  getPage: "READ",
  getPageJson: "READ",
  getWorkspace: "READ",
  stashPage: "READ",
  downloadFile: "READ",
  // EDIT
  editPageText: "EDIT",
  patchNode: "EDIT",
  insertNode: "EDIT",
  deleteNode: "EDIT",
  updatePageJson: "EDIT",
  updatePageMarkdown: "EDIT",
  tableGet: "EDIT",
  tableUpdateCell: "EDIT",
  tableInsertRow: "EDIT",
  tableDeleteRow: "EDIT",
  insertImage: "EDIT",
  replaceImage: "EDIT",
  insertFootnote: "EDIT",
  drawioGet: "EDIT",
  drawioCreate: "EDIT",
  drawioUpdate: "EDIT",
  drawioEditCells: "EDIT",
  drawioFromGraph: "EDIT",
  drawioFromMermaid: "EDIT",
  drawioShapes: "EDIT",
  drawioGuide: "EDIT",
  docmostTransform: "EDIT",
  // PAGES
  createPage: "PAGES",
  renamePage: "PAGES",
  movePage: "PAGES",
  deletePage: "PAGES",
  copyPageContent: "PAGES",
  sharePage: "PAGES",
  unsharePage: "PAGES",
  listShares: "PAGES",
  // COMMENTS
  createComment: "COMMENTS",
  listComments: "COMMENTS",
  updateComment: "COMMENTS",
  resolveComment: "COMMENTS",
  deleteComment: "COMMENTS",
  checkNewComments: "COMMENTS",
  // HISTORY
  diffPageVersions: "HISTORY",
  listPageHistory: "HISTORY",
  restorePageVersion: "HISTORY",
  savePageVersion: "HISTORY",
  exportPageMarkdown: "HISTORY",
  // importPageMarkdown is now inAppOnly (#411) — it is not registered on the
  // external MCP host, so it no longer appears in the generated inventory.
};

/**
 * Inventory lines for the INLINE MCP-only tools — the ones registered directly
 * in index.ts (not via SHARED_TOOL_SPECS) because they diverge per transport or
 * exist only on this standalone surface. They carry no `catalogLine`, so their
 * one-line purpose is hand-written here. This is the ONLY hand-maintained tool
 * list left, and it is tiny; a new inline tool without an entry here is caught
 * by the completeness guard in `tool-inventory.test.mjs`.
 */
export const INLINE_MCP_INVENTORY: ToolInventoryLine[] = [
  {
    name: "tableGet",
    purpose:
      "read a table as a matrix of cell texts + per-cell paragraph ids.",
  },
  {
    name: "search",
    purpose:
      "search pages across the wiki (OR default, RU+EN morphology, \"phrase\"/+/- operators, pagination); returns each hit's path, snippet, score and matched terms.",
  },
  {
    name: "docmostTransform",
    purpose:
      "edit a page by running a sandboxed JS `(doc, ctx) => doc` transform, with a dryRun diff preview.",
  },
  {
    name: "updateComment",
    purpose: "update an existing comment's content (creator only).",
  },
  {
    name: "deleteComment",
    purpose: "delete a comment (creator or space admin only).",
  },
  {
    name: "uploadFile",
    purpose:
      "upload a file from base64 bytes (any type) as a page attachment and get a ready-to-insert node; optionally insert it in the same call.",
  },
  {
    name: "downloadFile",
    purpose:
      "download an internal Docmost attachment's bytes by its /api/files src — as base64 (small files, in-context) or a short anonymous URL (format: base64|url|auto). The host of an absolute url is IGNORED: the file always comes from THIS instance.",
  },
];

/**
 * Derive the one-line purpose for a registry spec: prefer its hand-written
 * `catalogLine` (already a "name — purpose" line — we take the purpose after
 * the em dash), else fall back to the first sentence of its description.
 */
function purposeForSpec(spec: SharedToolSpec): string {
  const line = spec.catalogLine?.trim();
  if (line) {
    const dash = line.indexOf(" — ");
    if (dash >= 0) return line.slice(dash + 3).trim();
    return line;
  }
  const desc = (spec.description ?? "").replace(/\s+/g, " ").trim();
  const firstSentence = desc.split(/(?<=[.!?])\s/)[0];
  return firstSentence || desc || "(no description)";
}

/**
 * Build the flat list of every registered tool's inventory line: one per shared
 * registry spec (skipping `inAppOnly` specs, which are not registered on this
 * MCP host) PLUS every inline MCP-only tool. Pure and deterministic — the
 * registry drives it, so it can never drift from what index.ts registers.
 */
export function buildToolInventoryLines(
  specs: Record<string, SharedToolSpec> = SHARED_TOOL_SPECS,
  inline: ToolInventoryLine[] = INLINE_MCP_INVENTORY,
): ToolInventoryLine[] {
  const lines: ToolInventoryLine[] = [];
  for (const spec of Object.values(specs)) {
    if (spec.inAppOnly) continue; // not registered on the MCP host
    lines.push({ name: spec.mcpName, purpose: purposeForSpec(spec) });
  }
  for (const l of inline) lines.push({ ...l });
  return lines;
}

/**
 * Render the generated `<tool_inventory>` block: every tool name + purpose,
 * grouped by family (families in FAMILY_ORDER; tools within a family sorted by
 * name for stable output; unmapped tools fall into OTHER). Pure.
 */
export function buildToolInventory(
  specs: Record<string, SharedToolSpec> = SHARED_TOOL_SPECS,
  inline: ToolInventoryLine[] = INLINE_MCP_INVENTORY,
): string {
  const byFamily = new Map<Family, ToolInventoryLine[]>();
  for (const family of FAMILY_ORDER) byFamily.set(family, []);
  for (const line of buildToolInventoryLines(specs, inline)) {
    const family = TOOL_FAMILY[line.name] ?? "OTHER";
    byFamily.get(family)!.push(line);
  }
  const sections: string[] = [];
  for (const family of FAMILY_ORDER) {
    const items = byFamily.get(family)!;
    if (items.length === 0) continue;
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      sections.push(`  ${family}  ${item.name} — ${item.purpose}`);
    }
  }
  return ["<tool_inventory>", ...sections, "</tool_inventory>"].join("\n");
}

/**
 * The composed editing guide: the hand-written routing prose followed by the
 * generated, drift-proof tool inventory. Exported (and used by index.ts /
 * createDocmostMcpServer) as the MCP server's `instructions`.
 */
export const SERVER_INSTRUCTIONS =
  ROUTING_PROSE + "\n" + buildToolInventory();
