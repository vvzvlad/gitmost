# Docmost MCP Server

**English** · [Русский](README.ru.md)

A Model Context Protocol (MCP) server for [Docmost](https://docmost.com/) that lets
AI agents **read, search, write, restructure, review, version, comment on, illustrate
and publish** documentation — safely, against a live instance, without an enterprise
license.

> **Written by an agent, for agents.** A human edits a document with their eyes and hands:
> they read it, click into the editor, and retype. An agent works differently — it is far
> better at *writing a small function that fixes the text* than at re-reading and
> re-emitting a whole document. So this server is built around the way a model actually
> wants to edit: address a block by id, run a find/replace, or hand it a
> `(doc, ctx) => doc` transform and let it *program* the change. `docmost_transform` is
> that interface. Other Docmost MCPs are human-shaped — they expose "open the page" and
> "replace the page"; this one exposes the editing primitives a model is good at.

It exposes **41 tools** built around three ideas that the other Docmost MCPs do not
combine:

1. **Surgical, token-cheap edits.** Address a single block by id and patch it, or run
   a find/replace, instead of round-tripping a whole ~100 KB document through the model.
2. **Safe live writes.** Every mutation goes through Docmost's real-time collaboration
   layer (the same WebSocket the web editor uses), serialized per page, so it never
   clobbers a concurrent human edit and is confirmed persisted before the tool returns.
3. **A real safety net.** Version history, a Docmost-equivalent diff, a one-call
   restore, and a dry-run preview for scripted rewrites — so an agent can edit
   boldly and you can always see and undo what it did.

---

## Why this server (vs. the alternatives)

There are several Docmost MCPs. Here is a capability-by-capability comparison.
"Official" is Docmost's built-in MCP; the others are the community projects on GitHub.

| Capability | **This server** | Official (built-in) | MrMartiniMo/docmost-mcp | cyborgx0x/mcp-docmost | aleksvin8888 / isak-landin |
| --- | :---: | :---: | :---: | :---: | :---: |
| **Enterprise license required** | **No** | **Yes** | No | No | No |
| Authentication | email + password, **auto re-auth** | API key | email + password | cookie `authToken` (copy from DevTools) | Docmost API / **direct PostgreSQL** |
| Read page as Markdown | ✅ | ✅ | ✅ | ✅ | ✅ (read-only) |
| **Lossless Markdown round-trip** (export / import, keeps comment anchors) | ✅ | — | — | — | — |
| Read **lossless ProseMirror JSON** (with block ids) | ✅ | — | — | — | — |
| **Compact page outline** (cheap block-id lookup) | ✅ | — | — | — | — |
| **Fetch a single block** (by id or index) | ✅ | — | — | — | — |
| Create / move / delete pages | ✅ | ✅ | ✅ | ✅ | — |
| **Per-block edits** (patch/insert/delete by id) | ✅ | — | — | — | — |
| **Surgical find/replace** (structure-preserving) | ✅ | — | — | — | — |
| **Scripted JS transform** (sandboxed, dry-run diff) | ✅ | — | — | — | — |
| **Structured table editing** (row / cell CRUD) | ✅ | — | — | — | — |
| Page **version history** | ✅ | — | — | ✅ | — |
| **Diff two versions** | ✅ | — | — | — | — |
| **Restore a version** (revertible) | ✅ | — | — | — | — |
| **Comments** (CRUD + inline anchoring) | ✅ | — | — | ✅ | — |
| **Poll for new comments** since a timestamp | ✅ | — | — | — | — |
| **Images** (insert / replace) | ✅ | — | — | — | — |
| **Public share links** (create / revoke / list) | ✅ | — | — | — | — |
| Export to HTML / PDF | — | — | — | ✅ | — |
| **Safe real-time-collab writes** (no clobber, confirmed) | ✅ | n/a | ✅ | — | n/a (read-only) |

### What that means in practice

- **No enterprise tax.** Docmost's official MCP is an enterprise feature: it needs an
  active enterprise license. This server is MIT and
  talks to *any* self-hosted Docmost over the standard API + collaboration socket, with
  nothing but an account email and password.

- **Token-efficient editing.** Most Docmost MCPs (and the official one) only offer
  "replace the whole page" writes — the agent must download the entire document, mutate
  it, and upload it back, paying for the full document **twice** on every tiny fix.
  This server lets the agent change exactly one block (`patch_node` / `insert_node` /
  `delete_node`), do a structure-preserving find/replace (`edit_page_text`), or copy a
  whole page server-side (`copy_page_content`) — **without the document ever passing
  through the model**.

- **Writes that don't fight the editor.** Naive REST writes race with whatever a human
  is typing and can silently overwrite their edits, or fail against Docmost's debounced
  save. This server applies every change through the live collaboration document
  (Hocuspocus/Yjs), reading and writing **synchronously inside one sync tick** so no
  concurrent edit can interleave, serializing writes **per page** with a mutex, and
  **waiting for the server to acknowledge persistence** before returning. If the socket
  drops mid-write, the tool errors instead of falsely reporting success.

- **Agent-native editing model.** Human-facing servers expose "open the page" and "replace
  the page", because that mirrors how a person works. A model edits better by *programming*
  the change — addressing blocks by id, running a find/replace, or supplying a
  `(doc, ctx) => doc` transform (`docmost_transform`, with a dry-run diff before it
  commits). This server is shaped around that, which is why it has editing primitives the
  others simply don't.

- **An editing safety net the others lack.** `list_page_history` → `diff_page_versions`
  → `restore_page_version` give an agent (and you) a full view-and-undo loop. The diff
  uses the *same* `recreateTransform → ChangeSet → simplifyChanges` pipeline Docmost's
  own history viewer uses, so what you see matches the product.

- **Convenience over cookie-scraping.** Some community servers authenticate by making
  you copy a session cookie out of your browser's DevTools (it expires), or by reaching
  **directly into the PostgreSQL database**. This server logs in with credentials and
  **transparently re-authenticates on
  a 401/403** (with in-flight de-duplication), so long-running agents don't die when a
  token expires. It also respects Docmost's own access control, because it goes through
  the API and the collaboration server like a normal user.

---

## Tools

All 41 tools, grouped by what you'd reach for them.

### Exploration & retrieval

- **`get_workspace`** — Information about the current Docmost workspace.
- **`list_spaces`** — All spaces in the workspace.
- **`list_pages`** — Recent pages in a space, ordered by `updatedAt` desc (default 50,
  max 100). Use `search` for lookups in large spaces.
- **`search`** — Full-text search across pages and content (bounded by `limit`, max 100).
- **`get_page`** — A page's content as clean **Markdown** (convenient, but a *lossy*
  view — block ids and exact table/callout structure are approximated).
- **`get_page_json`** — A page's **lossless ProseMirror/TipTap JSON**, including every
  block's `attrs.id` and the `slugId` used in URLs. This is what the per-block editing
  tools consume.
- **`get_outline`** — A compact outline of a page's top-level blocks (`{index, type, id,
  level, firstText}`; tables add row/column counts and their header-cell texts, lists add
  item counts) **without** the document body. The cheap way to locate a section or table
  and grab its block id before
  `get_node` / `patch_node` / `insert_node`.
- **`get_node`** — Fetch a single block's full ProseMirror subtree (lossless) without
  pulling the whole page. Address it by a block id (from `get_outline` / `get_page_json`),
  or by `#<index>` for a top-level block — use the `#<index>` form for tables/rows/cells,
  which carry no id.

### Page lifecycle

- **`create_page`** — Create a page from Markdown and place it in the hierarchy (optional
  `parentPageId`) in one call. Uses Docmost's import API for clean Markdown→ProseMirror.
- **`rename_page`** — Change a page's title only, without touching or resending content.
- **`move_page`** — Re-parent a page (nest it, or move to root); supports fractional-index
  positioning. Returns only on a *positively confirmed* success.
- **`delete_page`** — Delete a single page.
- **`copy_page_content`** — Replace one page's body with a copy of another's, **entirely
  server-side** — the document never passes through the model. The target keeps its own
  title and slug (so its URL is preserved).

### Editing

- **`edit_page_text`** — Surgical find/replace inside a page's text. Preserves **all**
  structure: block ids, marks, links, callouts, tables. The preferred tool for fixing
  wording, typos, numbers and names.
- **`patch_node`** — Replace a single block addressed by its `attrs.id` (from
  `get_page_json`), without resending the document.
- **`insert_node`** — Insert a block before/after another (by `attrs.id` or anchor text),
  or append at the end.
- **`delete_node`** — Remove a single block by its `attrs.id`.
- **`update_page_json`** — Replace a page's entire content with a ProseMirror document
  (bulk rewrites, or when nodes lack ids). `content` is optional — omit it to update only
  the title. Keeps the block ids you pass in, so heading anchors and history stay stable.
- **`docmost_transform`** — The agent-native editing interface: instead of retyping a
  document, the agent **writes a function that fixes it**. Edit a page by running an
  arbitrary **`(doc, ctx) => doc` JavaScript transform** against its *live* ProseMirror
  document. Runs **sandboxed**
  (no `require`/`process`/`fs`/network, 5 s timeout). **Dry-run by default**: returns a
  diff preview without writing; set `dryRun:false` to apply atomically. `ctx` exposes the
  page's comments and a toolbox of helpers (`walk`, `getList`, `blockText`,
  `insertMarkerAfter`, `setCalloutRange`, `commentsToFootnotes`, …) for multi-step,
  coordinated rewrites such as renumbering, or turning inline comments into numbered
  footnotes.

### Tables

- **`table_get`** — Read a table as a matrix: `{rows, cols, cells (text[][]), cellIds}`
  (a paragraph id per cell, or `null`). Address the table by `#<index>` (from
  `get_outline`) or any block id inside it. Use `cellIds` with `patch_node` for
  rich-formatted cell edits.
- **`table_insert_row`** — Insert a row of plain-text cells, padded to the table's column
  count (passing more cells than columns is an error). `index` is the 0-based insert
  position (0 inserts before the header); omit it to append at the end.
- **`table_delete_row`** — Delete the row at a 0-based `index`. Refuses to delete a table's
  only row; deleting row 0 promotes the next row to header.
- **`table_update_cell`** — Set the plain-text content of cell `[row, col]` (0-based). For
  rich formatting, `patch_node` the cell's paragraph id from `table_get`.

### Markdown round-trip

- **`export_page_markdown`** — Export a page to a single self-contained, **lossless
  Docmost-flavoured Markdown** file: a meta header, the body with inline comment anchors
  and diagrams, and a trailing comments-thread block. Built for a download → edit body →
  `import_page_markdown` round-trip that preserves everything, including comment highlights.
- **`import_page_markdown`** — Replace a page's content from a Docmost-flavoured Markdown
  file produced by `export_page_markdown`, restoring comment-highlight anchors and diagrams
  from their inline HTML. (Comment *threads* in the file are not re-created on the server —
  only the page body and inline comment marks are written; manage threads via the comment
  tools/UI.)

### Images

- **`insert_image`** — Download an image from a web (http/https) URL and insert it in one
  step: append it, drop it in place of a text placeholder (`replaceText`), or put it after
  a given block (`afterText`). Preserves all other block ids.
- **`replace_image`** — Swap an existing image for one fetched from a web (http/https) URL.
  Uploads the new file as a **fresh
  attachment** (clean URL that renders and busts browser caches), then re-points every
  node referencing the old attachment (recursively, including callouts/tables) via the
  live document, preserving comments, alignment and alt text. (In-place overwrite is
  deliberately avoided — some Docmost versions corrupt the attachment on overwrite.)
- **`stash_page`** — Serialize a whole page (its full ProseMirror JSON) into an ephemeral
  in-RAM blob and return ONLY a short anonymous URL — the body never enters the model
  context, so it is the way to hand a large page (and its images) to an external consumer
  without truncation. Every internal file/image attachment is mirrored into the same
  sandbox and its `src` rewritten to a sandbox URL; external http(s) images are left
  untouched. Returns `{ uri, size, sha256, images:{ mirrored, failed } }` (`sha256` is also
  the blob's ETag). Blobs are RAM-only, expire after a short TTL (~1h) and are bound to the
  server instance that created them.

### Comments

- **`create_comment`** — Add a page comment, optionally **anchored inline** to an exact
  span of text (the first occurrence is wrapped in a comment mark).
- **`list_comments`** — List a page's comments (content returned as Markdown).
- **`update_comment`** — Edit an existing comment.
- **`delete_comment`** — Delete a comment.
- **`resolve_comment`** — Resolve (close) or reopen a comment thread (reversible). Only top-level
  comments can be resolved; the thread and its replies are kept, unlike `delete_comment`.
- **`check_new_comments`** — Find comments created after a given ISO-8601 timestamp across
  a space, optionally scoped to a page subtree — ideal for an agent that watches a doc for
  feedback.

### Versioning & history

- **`list_page_history`** — A page's saved versions (Docmost auto-snapshots on save),
  newest first, cursor-paginated. Each item's id is the `historyId`.
- **`diff_page_versions`** — Diff two versions (or a version against the live page).
  Returns inserted/deleted text, integrity counts (images, links, tables, callouts,
  footnote markers), and a human-readable Markdown summary — computed with the same
  pipeline Docmost's own history viewer uses.
- **`restore_page_version`** — Write a saved version back as the current content. Docmost
  has no restore endpoint, so this creates a **new** snapshot — the restore is itself
  revertible.

### Sharing

- **`share_page`** — Make a page publicly accessible (idempotent) and return its public
  URL (`<app>/share/<key>/p/<slugId>`); optional search-engine indexing.
- **`unshare_page`** — Revoke a page's public share.
- **`list_shares`** — All public shares in the workspace, with titles and public URLs.

---

## Choosing the right editing tool

This same guidance is also delivered at runtime via the MCP server `instructions` field,
so capable clients steer the model automatically.

- **Text fixes** (wording, typos, numbers): `edit_page_text`.
- **One block** (paragraph/heading/callout/table cell): `patch_node` / `insert_node` /
  `delete_node`, addressing the node by its `attrs.id` from `get_page_json`.
- **Images**: `insert_image` / `replace_image`.
- **A new page**: `create_page`.
- **Bulk rewrite, or nodes without ids**: `update_page_json`.
- **Multi-step / scripted rewrite** (renumbering, footnotes, coordinated edits):
  `docmost_transform` — preview with `dryRun`, then apply.
- **Copy a whole page's content from another page** (server-side): `copy_page_content`.
- **Rename a page** (title only): `rename_page`.
- **Reads**: `get_page` (Markdown) / `get_page_json` (lossless ProseMirror with ids).
- **Review changes**: `list_page_history` → `diff_page_versions` → `restore_page_version`.
- **Comments**: `create_comment` (with optional inline anchoring) / `list_comments` /
  `update_comment` / `resolve_comment` / `delete_comment` / `check_new_comments`.
- **Navigate a page cheaply** (find a section/table, grab a block id): `get_outline` →
  `get_node`.
- **Tables** (add/remove a row, set a cell): `table_get` / `table_insert_row` /
  `table_delete_row` / `table_update_cell`.
- **Round-trip a page as Markdown** (download, edit, re-upload losslessly with comments):
  `export_page_markdown` / `import_page_markdown`.

---

## How it works (technical details)

- **Safe real-time-collaboration writes.** Content mutations are applied through Docmost's
  collaboration WebSocket (Hocuspocus + Yjs). The server connects, waits for the initial
  sync so its local doc mirrors the authoritative server doc (including edits not yet in
  the debounced REST snapshot), then **reads → transforms → writes synchronously** in one
  tick so no remote update can interleave, and **waits for persistence acknowledgement**
  before returning.
- **Per-page write serialization.** A per-`pageId` async mutex ensures two MCP writes to
  the same page never overlap; different pages never block each other.
- **Transparent re-authentication.** Login uses email/password; expired tokens are
  refreshed automatically on the first 401/403 (covering JSON, multipart upload, and the
  collaboration-token path), with in-flight login de-duplication so a burst of calls
  triggers a single re-login.
- **Lossless and lossy reads.** `get_page_json` returns the exact ProseMirror tree with
  block ids; `get_page` returns clean Markdown for convenience.
- **Full Docmost schema.** Markdown↔ProseMirror conversion supports callouts (including
  nested), task lists (bullet *and* numbered checklists), tables, math blocks, embeds,
  highlights, sub/superscript and more, with defensive caps against pathological input.
- **Structured tables & lossless Markdown round-trip.** Tables can be edited as a matrix
  (read, insert/delete rows, set cells by `[row,col]`) without resending the document, and
  a page can be exported to and re-imported from a self-contained Docmost-flavoured
  Markdown file that preserves inline comment anchors and diagrams.
- **Token-optimized responses.** API responses are filtered down to the fields agents
  actually need, and large collections (spaces, pages, comments, history) are paginated.
- **Hardened runtime.** Global handlers keep a stray socket error from tearing down the
  stdio server; `move_page` requires a positively confirmed success; the diff engine
  falls back to a coarse block diff rather than hard-failing on a pathological document.

---

## Installation

```bash
npm install
npm run build
```

## Configuration

The server requires three environment variables:

- `DOCMOST_API_URL` — full URL to your Docmost API (e.g. `https://docs.example.com/api`).
- `DOCMOST_EMAIL` — account email for authentication.
- `DOCMOST_PASSWORD` — account password.

## Usage with Claude Desktop / a generic MCP client

Add the server to your MCP configuration (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "docmost-local": {
      "command": "node",
      "args": ["./build/index.js"],
      "env": {
        "DOCMOST_API_URL": "http://localhost:3000/api",
        "DOCMOST_EMAIL": "test@docmost.com",
        "DOCMOST_PASSWORD": "test"
      }
    }
  }
}
```

## Development

```bash
# Watch mode
npm run watch

# Build
npm run build

# Tests (unit + mock; the live end-to-end suite needs a running Docmost)
npm test
npm run test:e2e
```

## Lineage & acknowledgements

This project began as a fork of [MrMartiniMo/docmost-mcp](https://github.com/MrMartiniMo/docmost-mcp)
(by Moritz Krause) and extends it substantially — adding per-block node editing,
surgical text edits, the sandboxed `docmost_transform`, version history / diff / restore,
comments, image insert/replace, public sharing, server-side page copy, dual
JSON/Markdown reads, transparent re-authentication and significant hardening. The comment
tools were ported from upstream PR #3 by Max Nikitin. Thanks to both.

## License

MIT
