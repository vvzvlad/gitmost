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
> `(doc, ctx) => doc` transform and let it *program* the change. `docmostTransform` is
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
| **Markdown round-trip** (export / import, keeps comment anchors) | ✅ | — | — | — | — |
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
  This server lets the agent change exactly one block (`patchNode` / `insertNode` /
  `deleteNode`), do a structure-preserving find/replace (`editPageText`), or copy a
  whole page server-side (`copyPageContent`) — **without the document ever passing
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
  `(doc, ctx) => doc` transform (`docmostTransform`, with a dry-run diff before it
  commits). This server is shaped around that, which is why it has editing primitives the
  others simply don't.

- **An editing safety net the others lack.** `listPageHistory` → `diffPageVersions`
  → `restorePageVersion` give an agent (and you) a full view-and-undo loop. The diff
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

- **`getWorkspace`** — Information about the current Docmost workspace.
- **`listSpaces`** — All spaces in the workspace.
- **`listPages`** — Recent pages in a space, ordered by `updatedAt` desc (default 50,
  max 100). Use `search` for lookups in large spaces.
- **`search`** — Full-text search across pages and content (bounded by `limit`, max 100).
- **`getPage`** — A page's content as clean **Markdown** (canonical for text; drops only
  block ids, resolved-comment anchors, and a fixed no-Markdown-representation attr set —
  table spans/colwidth/background, indent, `callout.icon`, `orderedList.type`, and link
  `internal`/`target`/`rel`/`class`; use `getPageJson` when you need those). Pass
  `format:"text"` for a flat, deterministic plain-text rendering (one line per block,
  marks dropped, stable `[image]`/`[table RxC]` placeholders) to machine-diff what you
  wrote against what was stored.
- **`getPageJson`** — A page's **lossless ProseMirror/TipTap JSON**, including every
  block's `attrs.id` and the `slugId` used in URLs. This is what the per-block editing
  tools consume.
- **`getOutline`** — A compact outline of a page's top-level blocks (`{index, type, id,
  level, firstText}`; tables add row/column counts and their header-cell texts, lists add
  item counts) **without** the document body. The cheap way to locate a section or table
  and grab its block id — or, for an id-less block such as a table, its `index` — before
  `getNode` / `patchNode` / `insertNode`.
- **`getNode`** — Fetch a single block's full ProseMirror subtree (lossless) without
  pulling the whole page. Address it by a block id (from `getOutline` / `getPageJson`),
  or by `#<index>` for a top-level block — the way to reach a block with no id (tables,
  lists, quotes, dividers, callouts, images).

### Page lifecycle

- **`createPage`** — Create a page from Markdown and place it in the hierarchy (optional
  `parentPageId`) in one call. Uses Docmost's import API for clean Markdown→ProseMirror.
- **`renamePage`** — Change a page's title only, without touching or resending content.
- **`movePage`** — Re-parent a page (nest it, or move to root); supports fractional-index
  positioning. Returns only on a *positively confirmed* success.
- **`deletePage`** — Delete a single page.
- **`copyPageContent`** — Replace one page's body with a copy of another's, **entirely
  server-side** — the document never passes through the model. The target keeps its own
  title and slug (so its URL is preserved).

### Editing

- **`editPageText`** — Surgical find/replace inside a page's text. Preserves **all**
  structure: block ids, marks, links, callouts, tables. The preferred tool for fixing
  wording, typos, numbers and names.
- **`patchNode`** — Replace a single block addressed by its `attrs.id` (from
  `getPageJson`), without resending the document.
- **`insertNode`** — Insert a block before/after another (by `attrs.id` or anchor text),
  or append at the end.
- **`deleteNode`** — Remove a single block by its `attrs.id`.
- **`updatePageJson`** — Replace a page's entire content with a ProseMirror document
  (bulk rewrites, or when nodes lack ids). `content` is optional — omit it to update only
  the title. Keeps the block ids you pass in, so heading anchors and history stay stable.
- **`updatePageMarkdown`** — Replace a page's body (and optionally its title) with new
  **plain Markdown**. The whole body is re-imported (block ids regenerate — for surgical or
  id-preserving edits prefer `editPageText` / `patchNode` / `updatePageJson`).
  Docmost-flavoured markdown is parsed, including `^[...]` inline footnotes.
- **`docmostTransform`** — The agent-native editing interface: instead of retyping a
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

- **`tableGet`** — Read a table as a matrix: `{rows, cols, cells (text[][]), cellIds}`
  (a paragraph id per cell, or `null`). Address the table by `#<index>` (from
  `getOutline`) or any block id inside it. Use `cellIds` with `patchNode` for
  rich-formatted cell edits.
- **`tableInsertRow`** — Insert a row of plain-text cells, padded to the table's column
  count (passing more cells than columns is an error). `index` is the 0-based insert
  position (0 inserts before the header); omit it to append at the end.
- **`tableDeleteRow`** — Delete the row at a 0-based `index`. Refuses to delete a table's
  only row; deleting row 0 promotes the next row to header.
- **`tableUpdateCell`** — Set the plain-text content of cell `[row, col]` (0-based). For
  rich formatting, `patchNode` the cell's paragraph id from `tableGet`.

### Markdown round-trip

- **`exportPageMarkdown`** — Export a page to a single self-contained
  **Docmost-flavoured Markdown** file: a meta header, the body with inline comment anchors
  and diagrams, and a trailing comments-thread block. The download → edit → import
  round-trip regenerates block ids and **silently drops** the no-Markdown-representation
  attr set (table merge spans/colwidth/background, indent, `callout.icon`,
  `orderedList.type`, link `internal`/`target`/`rel`/`class`); keep those in ProseMirror
  JSON if they must survive. To replace a page's body from plain authoring Markdown, use
  `updatePageMarkdown`.

> **Removed in this release:** `importPageMarkdown` (the round-trip parser for an
> exported Docmost-Markdown file) is **no longer exposed on the external MCP surface**.
> To replace a page's body from Markdown, use **`updatePageMarkdown`** (plain Markdown
> body replace). See the CHANGELOG for the migration note.

### Images

- **`insertImage`** — Download an image from a web (http/https) URL and insert it in one
  step: append it, drop it in place of a text placeholder (`replaceText`), or put it after
  a given block (`afterText`). Preserves all other block ids.
- **`replaceImage`** — Swap an existing image for one fetched from a web (http/https) URL.
  Uploads the new file as a **fresh
  attachment** (clean URL that renders and busts browser caches), then re-points every
  node referencing the old attachment (recursively, including callouts/tables) via the
  live document, preserving comments, alignment and alt text. (In-place overwrite is
  deliberately avoided — some Docmost versions corrupt the attachment on overwrite.)
- **`stashPage`** — Serialize a whole page (its full ProseMirror JSON) into an ephemeral
  in-RAM blob and return ONLY a short anonymous URL — the body never enters the model
  context, so it is the way to hand a large page (and its images) to an external consumer
  without truncation. Every internal file/image attachment is mirrored into the same
  sandbox and its `src` rewritten to a sandbox URL; external http(s) images are left
  untouched. Returns `{ uri, size, sha256, images:{ mirrored, failed } }` (`sha256` is also
  the blob's ETag). Blobs are RAM-only, expire after a short TTL (~1h) and are bound to the
  server instance that created them.

### Comments

- **`createComment`** — Add a page comment, optionally **anchored inline** to an exact
  span of text (the first occurrence is wrapped in a comment mark).
- **`listComments`** — List a page's comments (content returned as Markdown).
- **`updateComment`** — Edit an existing comment.
- **`deleteComment`** — Delete a comment.
- **`resolveComment`** — Resolve (close) or reopen a comment thread (reversible). Only top-level
  comments can be resolved; the thread and its replies are kept, unlike `deleteComment`.
- **`checkNewComments`** — Find comments created after a given ISO-8601 timestamp across
  a space, optionally scoped to a page subtree — ideal for an agent that watches a doc for
  feedback.

### Versioning & history

- **`listPageHistory`** — A page's saved versions (Docmost auto-snapshots on save),
  newest first, cursor-paginated. Each item's id is the `historyId`.
- **`diffPageVersions`** — Diff two versions (or a version against the live page).
  Returns inserted/deleted text, integrity counts (images, links, tables, callouts,
  code blocks, drawio, excalidraw, attachments, media — video/audio/pdf, embeds —
  embed/youtube/htmlEmbed, math blocks, page embeds, subpages, transclusions,
  footnote markers), and a human-readable Markdown
  summary — computed with the same pipeline Docmost's own history viewer uses.
- **`restorePageVersion`** — Write a saved version back as the current content. Docmost
  has no restore endpoint, so this creates a **new** snapshot — the restore is itself
  revertible.

### Sharing

- **`sharePage`** — Make a page publicly accessible (idempotent) and return its public
  URL (`<app>/share/<key>/p/<slugId>`); optional search-engine indexing.
- **`unsharePage`** — Revoke a page's public share.
- **`listShares`** — All public shares in the workspace, with titles and public URLs.

---

## Choosing the right editing tool

This same guidance is also delivered at runtime via the MCP server `instructions` field,
so capable clients steer the model automatically.

- **Text fixes** (wording, typos, numbers): `editPageText`.
- **One block**: `patchNode` / `insertNode` / `deleteNode`, addressing the node by its
  `attrs.id` from `getPageJson`. Block ids sit on paragraphs and headings (a few
  container nodes carry one too) and are matched anywhere in the tree, so a paragraph
  inside a list item, quote, table cell or callout is addressable **if it has an id** —
  blocks imported from Markdown often have none, and `getOutline` shows top-level ids
  only (nested ones surface in `getPageJson`, `tableGet`'s `cellIds`, `searchInPage`'s
  `nodeId`). Without an id: `editPageText` (needs none), the table tools, or
  `docmostTransform`. The `#<index>` form works with `getNode` but not with
  `patchNode` / `deleteNode` / `insertNode`'s `anchorNodeId`.
- **Images**: `insertImage` / `replaceImage`.
- **A new page**: `createPage`.
- **Bulk rewrite, or nodes without ids**: `updatePageJson` (ProseMirror) or
  `updatePageMarkdown` (plain Markdown body replace).
- **Multi-step / scripted rewrite** (renumbering, footnotes, coordinated edits):
  `docmostTransform` — preview with `dryRun`, then apply.
- **Copy a whole page's content from another page** (server-side): `copyPageContent`.
- **Rename a page** (title only): `renamePage`.
- **Reads**: `getPage` (Markdown) / `getPageJson` (lossless ProseMirror with ids).
- **Review changes**: `listPageHistory` → `diffPageVersions` → `restorePageVersion`.
- **Comments**: `createComment` (with optional inline anchoring) / `listComments` /
  `updateComment` / `resolveComment` / `deleteComment` / `checkNewComments`.
- **Navigate a page cheaply** (find a section/table, grab a block id or index):
  `getOutline` → `getNode`.
- **Tables** (add/remove a row, set a cell): `tableGet` / `tableInsertRow` /
  `tableDeleteRow` / `tableUpdateCell`.
- **Export a page as self-contained Markdown** (with comment anchors): `exportPageMarkdown`.
- **Replace a page's body from Markdown**: `updatePageMarkdown`.

---

## How it works (technical details)

- **Safe real-time-collaboration writes.** Content mutations are applied through Docmost's
  collaboration WebSocket (Hocuspocus + Yjs). The server connects, waits for the initial
  sync so its local doc mirrors the authoritative server doc (including edits not yet in
  the debounced REST snapshot), then **reads → transforms → writes synchronously** in one
  tick so no remote update can interleave, and **waits for persistence acknowledgement**
  before returning.
- **Per-page write serialization.** A per-`pageId` async mutex (keyed by the resolved
  page **UUID**, never a slugId) ensures two MCP writes to the same page never overlap;
  different pages never block each other. The lock helper fails fast if it is ever handed
  a non-UUID key, so a write path that forgot to resolve the id can never silently lock
  under a split key.

  **Deploy requirement — single instance or sticky sessions.** This mutex is an
  in-process `Map`, and the cached collab sessions and the `stash_page` blob store are
  RAM-only and process-local. Behind a **multi-replica** load balancer **without sticky
  sessions**, two replicas can each "hold" the lock for the same page at once and per-page
  serialization is silently lost. Run the MCP/app as a **single instance**, or pin each
  page's traffic to one replica (sticky sessions / consistent hashing on the page id).
  There is deliberately no cross-process (e.g. Postgres advisory) lock yet — a conscious
  documented constraint. See the `Dockerfile` comment and the `MCP collaboration write
  path` block in `.env.example`.

  **Rights-staleness window.** A cached collab session writes under the token captured at
  connect time (and the collab-token cache reuses a token for its TTL), so a **revoked**
  page access can lag by up to `MCP_COLLAB_SESSION_MAX_AGE_MS` (the hard session lifetime,
  default 10 min) before the next re-auth picks it up. Lower it to shorten the lag at the
  cost of more reconnects. This bounded window is an accepted trade-off; there is no
  push-based cache invalidation on a rights change.
- **Transparent re-authentication.** Login uses email/password; expired tokens are
  refreshed automatically on the first 401/403 (covering JSON, multipart upload, and the
  collaboration-token path), with in-flight login de-duplication so a burst of calls
  triggers a single re-login.
- **Precise reads.** `getPageJson` returns the exact ProseMirror tree with block ids;
  `getPage` returns canonical Markdown that drops only a fixed, documented attr set.
- **Full Docmost schema.** Markdown↔ProseMirror conversion supports callouts (including
  nested), task lists (bullet *and* numbered checklists), tables, math blocks, embeds,
  highlights, sub/superscript and more, with defensive caps against pathological input.
- **Structured tables & Markdown round-trip.** Tables can be edited as a matrix
  (read, insert/delete rows, set cells by `[row,col]`) without resending the document, and
  a page can be exported to and re-imported from a self-contained Docmost-flavoured
  Markdown file that preserves inline comment anchors and diagrams (block ids regenerate
  and a fixed no-Markdown-representation attr set is dropped — see `exportPageMarkdown`).
- **Token-optimized responses.** API responses are filtered down to the fields agents
  actually need, and large collections (spaces, pages, comments, history) are paginated.
- **Hardened runtime.** Global handlers keep a stray socket error from tearing down the
  stdio server; `movePage` requires a positively confirmed success; the diff engine
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

## Connecting to the embedded HTTP `/mcp` endpoint (Bearer api_key — **no OAuth**)

This same server is also bundled into Gitmost and served over HTTP at `/mcp`
(enable it under Workspace settings → AI). Connecting to it:

```bash
claude mcp add --transport http gitmost https://<host>/mcp \
  --header "Authorization: Bearer <api_key>"
```

Mint `<api_key>` under **Workspace settings → API keys**. The MCP session then acts
under that key owner's permissions; revoking the key revokes access immediately.
If the deployment sets `MCP_TOKEN`, also send `--header "X-MCP-Token: <MCP_TOKEN>"`
(its own header — `Authorization` is reserved for the api_key).

**OAuth is not supported.** `Authorization: Bearer <api_key>` is the *only* accepted
scheme. Gitmost runs no OAuth authorization server, publishes no
`/.well-known/oauth-protected-resource` or `/.well-known/oauth-authorization-server`
metadata (those paths answer an honest `404`), and offers no dynamic client
registration. If your MCP client shows an **Authenticate** button after a `401`,
ignore it — it will not work; put the api_key in the `Authorization` header instead.
A `401` from `/mcp` says so explicitly:

```
WWW-Authenticate: Bearer realm="mcp", error="invalid_token", error_description="MCP requires a Bearer api_key token (Authorization: Bearer <api_key>)."
```

On a deployment that sets `MCP_TOKEN`, a request that is missing (or mis-sending) the
`X-MCP-Token` shared secret gets a challenge naming *that* header instead — adding the
api_key alone would never satisfy it:

```
WWW-Authenticate: Bearer realm="mcp", error="invalid_token", error_description="MCP requires the shared secret in the X-MCP-Token header (X-MCP-Token: <MCP_TOKEN>) plus a Bearer api_key token (Authorization: Bearer <api_key>)."
```

Per RFC 6750 §3.1, the `error="invalid_token"` code appears only when the credential
*that particular challenge asks for* was actually sent and rejected. A request that
never sent it — no `Authorization` header, or (on an `MCP_TOKEN` deployment) no
`X-MCP-Token` — gets the same challenge *without* the code: nothing was sent, so
nothing was "invalid", and the client is not sent hunting a token it never used. An
empty header value (`X-MCP-Token:`) counts as nothing sent.

**Migrating an old config.** `/mcp` used to accept HTTP Basic `email:password`, a
human session ACCESS token, and a `MCP_DOCMOST_EMAIL`/`MCP_DOCMOST_PASSWORD` service
account; all three were removed (see the CHANGELOG Breaking Changes entry). A config
still carrying `Authorization: Basic <base64 email:password>` now gets a `401` — and,
in a spec-conformant client, that `401` is what triggers the useless OAuth flow.
Replace the header with `Authorization: Bearer <api_key>`.

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
surgical text edits, the sandboxed `docmostTransform`, version history / diff / restore,
comments, image insert/replace, public sharing, server-side page copy, dual
JSON/Markdown reads, transparent re-authentication and significant hardening. The comment
tools were ported from upstream PR #3 by Max Nikitin. Thanks to both.

## License

MIT
