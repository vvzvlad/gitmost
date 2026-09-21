# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Releases prior to `0.91.0` predate this changelog; see the
> [git tags](https://github.com/vvzvlad/gitmost/tags) for earlier history.

## [Unreleased]

## [0.96.0] - 2026-09-21

This release makes the wiki local-first: page chrome and body paint from a
local cache and the local collaboration replica, the app shell no longer waits
for `/me`, an unreachable server degrades to a read-only offline view instead
of an error screen, and locally cached content expires on its own after
`OFFLINE_GRACE`. AI chat gains detached runs that survive a browser
disconnect, a server-side "interrupt and send now", personal external MCP
servers every member can attach, and an importable multilingual agent-roles
catalog. The MCP surface is reworked — camelCase tool names, api_key-only
authentication, Markdown by default from `getNode`, read-your-own-writes on
the structural read tools, and a `baseHash` write-CAS that stops an agent from
clobbering a concurrent human edit. The editor picks up side-by-side image
rows, image captions, a spoiler mark, intentional page versions saved with
`Cmd/Ctrl+S` — and loses the Safari 100%-CPU burn on any page containing a
table.

### Breaking Changes

- **MCP `updatePageJson` / `updatePageMarkdown` now require a `baseHash`
  (server-side write-CAS).** A full-body overwrite used to be unguarded: an agent
  that read a page and wrote it back silently clobbered a newer edit made by a
  human or another agent in between. The write is now compare-and-set: the body
  is applied only if the authoritative LIVE document still hashes to the
  `baseHash` the caller read, inside one synchronous collaboration transaction
  (no TOCTOU window). `getPage` / `getPageJson` now return that `baseHash`, so
  the required flow is read → keep `baseHash` → write it back with the hash.
  *Migration (external MCP clients and scripts):* pass `baseHash` on every
  `updatePageJson`/`updatePageMarkdown` call that supplies `content` — without
  it the tool now fails with an explicit `baseHash is required …` error instead
  of overwriting (a title-only update still needs no hash). On a concurrent
  edit the write is REJECTED with `409` plus the `currentHash` and **nothing**
  is written — no history entry, no `updatedAt` bump; re-read for a fresh hash
  and retry a bounded number of times. If the live document owner is
  unreachable the write fails with `503` rather than applying against a stale
  hash (fail-closed — the comparison never falls back to the DB snapshot). The
  REST `/pages/update` endpoint is unchanged for other callers: `baseHash` is
  optional there and an omitted hash performs the previous unguarded replace.
  The in-app AI agent already passes the hash and is unaffected. (#647)

- **The embedded `/mcp` endpoint now authenticates ONLY with a Bearer api_key.**
  The three former inbound auth paths — HTTP Basic `email:password`, a Bearer
  human-session ACCESS token, and the `MCP_DOCMOST_EMAIL` / `MCP_DOCMOST_PASSWORD`
  env service account — are all removed. An agent must send
  `Authorization: Bearer <api_key>` (an api_key minted under Workspace settings →
  API keys); every other credential now gets a `401`.

  *Migration:* (1) MCP clients that authenticated with HTTP Basic `email:password`
  or a session ACCESS token must switch to a Bearer api_key. (2) Deploys that
  relied on the `MCP_DOCMOST_EMAIL` / `MCP_DOCMOST_PASSWORD` service account must
  mint an api_key and drop those two env vars (they are no longer read).
  `MCP_DOCMOST_API_URL` (the outbound loopback URL) and `MCP_TOKEN` (the optional
  shared `X-MCP-Token` guard) are unchanged. **Deploy order:** roll this out only
  after every agent has migrated to a Bearer api_key, since the old credentials
  stop working the moment this deploys. (The in-app AI agent does not use `/mcp`
  and is unaffected.)

- **External MCP tool names are now camelCase (all renamed).** Every tool on the
  external `/mcp` surface was renamed from `snake_case` to `camelCase`, so the
  external MCP name now matches the in-app tool name exactly (one logical tool,
  one name everywhere). For example `get_node` → `getNode`, `edit_page_text` →
  `editPageText`, `patch_node` → `patchNode`. The tools' behaviour, inputs and
  outputs are unchanged — only the names change. The single-word `search`
  keeps its name.

  *Migration (external MCP clients only — the in-app AI agent already used these
  names and is unaffected):* update anything that refers to a tool by its
  string name — permission allowlists (`mcp__gitmost-*__get_node` →
  `mcp__gitmost-*__getNode`), saved prompts/skills, `.mcp.json` tool filters,
  and metrics dashboards that group by the `tool` label — and roll it out in
  lockstep with this deploy, because the old snake_case names stop resolving.
  Released together with the `import_page_markdown`/`update_page_markdown`
  change below so external configs break exactly once.

  Full mapping (old → new):

  | Old (snake_case) | New (camelCase) |
  | --- | --- |
  | `check_new_comments` | `checkNewComments` |
  | `copy_page_content` | `copyPageContent` |
  | `create_comment` | `createComment` |
  | `create_page` | `createPage` |
  | `delete_comment` | `deleteComment` |
  | `delete_node` | `deleteNode` |
  | `delete_page` | `deletePage` |
  | `diff_page_versions` | `diffPageVersions` |
  | `docmost_transform` | `docmostTransform` |
  | `drawio_create` | `drawioCreate` |
  | `drawio_get` | `drawioGet` |
  | `drawio_guide` | `drawioGuide` |
  | `drawio_shapes` | `drawioShapes` |
  | `drawio_update` | `drawioUpdate` |
  | `edit_page_text` | `editPageText` |
  | `export_page_markdown` | `exportPageMarkdown` |
  | `get_node` | `getNode` |
  | `get_outline` | `getOutline` |
  | `get_page` | `getPage` |
  | `get_page_json` | `getPageJson` |
  | `get_workspace` | `getWorkspace` |
  | `insert_footnote` | `insertFootnote` |
  | `insert_image` | `insertImage` |
  | `insert_node` | `insertNode` |
  | `list_comments` | `listComments` |
  | `list_page_history` | `listPageHistory` |
  | `list_pages` | `listPages` |
  | `list_shares` | `listShares` |
  | `list_spaces` | `listSpaces` |
  | `move_page` | `movePage` |
  | `patch_node` | `patchNode` |
  | `rename_page` | `renamePage` |
  | `replace_image` | `replaceImage` |
  | `resolve_comment` | `resolveComment` |
  | `restore_page_version` | `restorePageVersion` |
  | `search` | `search` (unchanged) |
  | `search_in_page` | `searchInPage` |
  | `share_page` | `sharePage` |
  | `stash_page` | `stashPage` |
  | `table_delete_row` | `tableDeleteRow` |
  | `table_get` | `tableGet` |
  | `table_insert_row` | `tableInsertRow` |
  | `table_update_cell` | `tableUpdateCell` |
  | `unshare_page` | `unsharePage` |
  | `update_comment` | `updateComment` |
  | `update_page_json` | `updatePageJson` |
  | `update_page_markdown` | `updatePageMarkdown` |

  (#412)

- **External MCP: `import_page_markdown` removed, `update_page_markdown` added.**
  The external `/mcp` surface no longer exposes `importPageMarkdown` (the
  round-trip parser for a self-contained *exported* Docmost-Markdown file). In
  its place it now exposes **`updatePageMarkdown`** — a plain-Markdown
  full-body replace (`{pageId, content, title?}`) that pairs with
  `updatePageJson`, re-imports the whole body (block ids regenerate) and
  parses Docmost-flavoured markdown including `^[...]` inline footnotes.
  *Migration:* MCP clients that called `importPageMarkdown` to overwrite a
  page's body from Markdown should call `updatePageMarkdown` instead (pass the
  markdown as `content`). Round-tripping an exported Docmost-Markdown file with
  comment anchors/diagrams is no longer available on the external MCP surface;
  export remains via `exportPageMarkdown`. The in-app AI agent is unaffected —
  it keeps both `importPageMarkdown` and the renamed `updatePageMarkdown` (was
  `updatePageContent`). The total MCP tool count is unchanged (−1 / +1). The
  external names shown here are the post-#412 camelCase names. (#411)

- **`getNode` now returns Markdown by default (was ProseMirror JSON).** The
  block-level read/write tools default to Markdown so a block round trip is
  `getNode` (markdown) → edit → `patchNode` (markdown). `getNode` now returns
  `{ …, format: "markdown", markdown }` unless you pass `format: "json"` (which
  restores the previous `{ …, node }` ProseMirror subtree); comment anchors —
  including resolved ones — are preserved in the markdown so a write-back never
  orphans a thread, and a node that cannot be a document top-level block
  (`tableRow`/`tableCell`/`tableHeader` addressed via `#<index>`) auto-falls back
  to JSON with `format: "json"` in the response. `patchNode`/`insertNode` gain a
  `markdown` input alongside `node` (provide exactly one): the markdown fragment
  may rewrite/insert several blocks at once and supports `^[...]` footnotes.
  *Migration (external MCP clients only):* a client that consumed `getNode`'s
  `node` field must now either read `markdown`, or pass `format: "json"` to keep
  the old ProseMirror-JSON output. Released together with the `#411`/`#412`
  breaking window so external configs break exactly once. (#413)

- **The Prometheus `/metrics` listener now binds to `127.0.0.1` (loopback) by
  default instead of `0.0.0.0` (all interfaces).** This closes an unauthenticated
  endpoint that was previously reachable on every interface. **DEPLOY MIGRATION —
  cross-container scraping breaks silently otherwise:** if your scraper runs in a
  SEPARATE container and reaches the app as `docmost:9464` (the exact topology the
  old `0.0.0.0` hardcode served), you MUST now set `METRICS_BIND=0.0.0.0` — and,
  because that re-exposes the endpoint, also set `METRICS_TOKEN=<secret>` and
  configure the scraper with a matching Bearer token. Without `METRICS_BIND`, the
  scraper can no longer connect and metrics go dark with no error. See the
  `METRICS_BIND` / `METRICS_TOKEN` block in `.env.example` for the migration.
  Same-host (loopback) scrapers need no change. (#486)

### Added

- **Every member can attach their OWN external MCP servers.** Until now only an
  admin could give the agent external tools (web search, etc.), workspace-wide.
  A new account page — Settings → Account → MCP servers, mirroring the account
  API-keys page — lets any member register personal MCP servers; an agent turn
  run by that user gets the union of the admin-managed servers and their own
  personal ones (on a name collision the admin server keeps the canonical tool
  prefix). Personal servers are strictly private: every admin query is scoped to
  `user_id IS NULL`, personal CRUD is owner-scoped (someone else's id is a
  `404`), auth headers are write-only (encrypted at rest, never returned in any
  response or log), the outbound URL passes the same SSRF guard on create AND on
  every URL change, and deleting a member destroys their personal rows — with
  their encrypted secrets — in the same transaction. Two operator knobs (see
  `.env.example`): `MCP_PERSONAL_SERVERS_ENABLED` (default **on**; set to
  `false` to make the personal endpoints answer `403`, hide the page and drop
  personal rows from the agent's toolset, without a code revert) and
  `MCP_PERSONAL_SERVERS_MAX` (per-user cap, default `10`, enforced
  transactionally so a parallel burst cannot exceed it). Connect failures are no
  longer silent: the turn reports them to the client on the stream's start
  event, persists them into the assistant message metadata, and increments
  `ai_external_mcp_connect_failures_total{level=admin|personal}`; the combined
  tool-description block is capped at 16k with a loud ERROR on truncation.
  **Upgrade note:** migration `20260719T120000` adds a nullable `user_id` to
  `ai_mcp_servers` (additive, no backfill, no table rewrite). (#686)

- **The MCP structural read tools now read your own writes.** After an agent
  write, a follow-up `getOutline` / `getNode` / `searchInPage` / `tableGet` on
  the same page within a short window is served from the LIVE collaboration
  document instead of the (possibly lagging) database row, and each response
  carries a freshness marker saying which it was. The agent does not ask for
  this — the client decides locally, with no extra request, and a page with no
  recent write takes the byte-identical old path. If the live document is not
  loaded or its owner is unreachable the server falls back to the DB row
  (after, never before, the permission check). Freshness and degradation are
  visible on `/metrics` as `mcp_ryow_{live,dbrow,expired}_total`. (#654)

- **`searchInPage` matches through invisible characters in literal mode.** Like
  `editPageText`, literal search now folds soft hyphens, zero-width characters,
  the NBSP/thin-space family and collapsed whitespace runs on both sides (plus
  case folding), and maps hit offsets back onto the original text, so a query
  typed with ordinary spaces finds text the editor stored with an NBSP. The
  returned `match` keeps the original invisible characters — it is data for
  `createComment`, not a diagnostic — and an additive `folded: true` flags a
  fragment that only matched after folding. Regex mode is deliberately
  untouched (folding would break offsets, character classes and groups). (#659)

- **The right panel and the AI-chat window survive a reload.** Whether the
  right panel is open, its position/collapsed state and which tab it shows, and
  whether the AI-chat window is open plus its geometry, are now persisted.
  Deliberately NOT persisted (they reset to the defaults every load): the
  composer draft, the active chat, the selected role, the History expansion,
  the Open/Resolved tab and the scroll position. Window geometry is clamped to
  the viewport — size as well as position — so a window saved on a big monitor
  cannot land off-screen, and a browser that blocks site data degrades to the
  old behaviour instead of failing to load the app. (#662)

- **The Lucide icon picker now exposes the whole catalog, searchable by
  meaning.** It used to show 112 curated icons, with the rest reachable only by
  an English substring search capped at 120 hits. The full catalog (1746
  canonical icons) is now browsable in a virtualized grid and searchable by
  tags, aliases and common Russian words; a stored alias still resolves to its
  canonical icon, and the name tooltip that drifted while scrolling is gone.
  The catalog ships as a lazily-loaded chunk (it never enters the initial
  bundle), and if that chunk fails to load the picker says so and offers Retry
  in a visible limited mode rather than silently showing nothing. (#696)

- **Copy-link and trash actions straight from the page-tree row.** Copying a
  page link or moving a page to trash used to require opening the row's "⋮"
  menu. Both are now their own hover icons in the row (order: link → trash →
  menu → plus). They call exactly the same code paths as the menu items — the
  same "Link copied" notification, and the same soft delete whose removal
  notification already carries an Undo, so there is no confirmation dialog. The
  trash icon renders only for users who can edit, and turns red on hover.

- **More client-side latency and operation metrics for operators.** With client
  telemetry enabled, the browser now reports `operation_ms{op}` for 14 heavy
  user-perceived operations that previously ran blind — `comments_open`,
  `ai_chat_open`, `spotlight_open`, `search_full`, `comment_resolve`,
  `comment_apply`, `history_restore`, `tree_dragdrop`, `tree_expand`,
  `history_diff`, `code_highlight` and the three diagram renders (`mermaid`,
  `excalidraw`, `drawio`). Interaction-style operations are measured
  success-only, so retry-inflated failures cannot pollute the p95/p99, and
  `code_highlight` is timed only on a real decoration recompute, never on the
  keystroke fast path. Added alongside: `editor_key_latency_ms` — the full
  keydown→next-paint duration via the Event Timing API, which `editor_tx_ms`
  is structurally blind to (it only measures the synchronous ProseMirror
  transaction, not the React re-render that follows) — and, for the local-first
  work, `page_open_body_ms` (time to the first frame of real body content) with
  its `body_paint_timeout` survivorship-bias counter. Server-side,
  `ai_chat_bind_skipped_total{reason}` makes the silent "did not bind this chat
  to this page" outcomes (all of them HTTP 200) visible. (#683, #681, #639,
  #665)

- **The app shell no longer waits for `/me` before painting.** Under
  `LOCAL_FIRST_ENABLED` (default `false`), the first frame is rendered from the
  persisted current user (identity, workspace, role) instead of an empty frame
  held until the `/me` round-trip completes; the real response always wins and
  arrives within one RTT. A `401` clears the persisted user before any redirect,
  so a stale seeded user can never bounce the browser between `/login` and the
  app. With the flag off, nothing is read or written and behaviour is
  unchanged. (#642)

- **Offline: a transport failure is no longer treated as an application
  error.** Under `LOCAL_FIRST_ENABLED` (default `false`), an unreachable server
  no longer collapses the page into an error screen: with cached metadata and a
  local body you get the page chrome plus a read-only body and an "offline"
  banner (sticky until a real sync, so it cannot flicker); with metadata but no
  local body you get an explicit offline empty state; an auth error still
  resolves to not-found and evicts the cached copy. Crucially a `5xx` is NOT
  offline — a real server response gets an honest error screen and a safety
  metric, never the offline banner; only a genuinely unreachable server is
  absorbed into local rendering. The user provider degrades the same way: with
  data and a non-auth failure it mounts the app with a degraded indicator
  instead of blocking. The offline-critical requests (`/me`, `/pages/info`,
  `/spaces/*`) get a 15s per-request timeout so a hung request settles into a
  transport error instead of leaving the page pending forever. (#641)

- **Locally cached content now expires on its own, network or not
  (`OFFLINE_GRACE`).** A device that has not had a successful `/me` for longer
  than `OFFLINE_GRACE` refuses to draw ANY local content — chrome, tree and
  ydoc body — and purges it, so a laptop that stays offline cannot keep showing
  wiki content indefinitely after its session has died server-side. It defaults
  to `JWT_TOKEN_EXPIRES_IN` (the server considers the session dead after that
  anyway) and can be overridden in `.env` (see `.env.example`). In the same
  pass, a page that answered `403`/`404` is tombstoned: its local database is
  not merely deleted but blocked from being recreated, and the denylist fails
  CLOSED — if the store cannot be read or written, local painting is disabled
  for the rest of the session rather than drawing everything. (#640)

- **`editPageText` and comment-anchoring now match across invisible characters.**
  The matcher gained a `fold` tier: after the existing exact and markdown-strip
  passes miss, it retries with a fold pass that collapses soft-hyphens
  (`U+00AD`), zero-width and BOM characters (`U+200B`–`U+200D`, `U+FEFF`,
  `U+2060`), and the whole NBSP/figure/thin-space family into their visible
  equivalents — so a `find` typed with ordinary spaces still locates text that
  the editor stored with an NBSP, and vice versa. A `find`/`replace` that itself
  removes or inserts invisibles (e.g. stripping a stray soft-hyphen) keeps going
  through the exact tier, so those edits are unaffected. `replaceAll` merges the
  exact and fold hits into one disjoint plan; every reported match now carries a
  `matchedVia` field naming the tier that hit. When nothing matches, the tool
  now returns a targeted self-diagnosis of *why* (invisible-char mismatch,
  markdown-vs-plain, whitespace run) instead of a bare "not found". Comment
  anchoring gained the same two-tier (verbatim + fold) lattice. The invisible-
  folding, typography and dash/quote normalization tables are consolidated into
  one canon in `@docmost/prosemirror-markdown`, shared by the matcher, comment
  anchoring and footnote merging (previously duplicated across three files).

- **Excalidraw diagrams no longer vanish from external publications either.**
  The companion to the draw.io fix below: `habr-mcp` did not know the `excalidraw`
  node type and silently dropped it. Symmetric to draw.io, the excalidraw editor
  now embeds a PNG `data-raster` into the saved `.excalidraw.svg` on save (behind
  the new `EXCALIDRAW_RASTER_ENABLED` env var, default off), and the MCP consumers
  (`stashPage`, `viewImage`) accept the `excalidraw` node type. Unlike draw.io,
  excalidraw's SVG is itself valid (real `<text>`), so it has a correct degrade
  path: with no usable raster, `stashPage` rewrites the node to an `image` backed
  by the mirrored SVG (rather than dropping it), and `viewImage` rasterizes the
  SVG server-side — excalidraw never takes draw.io's "no raster → error" branch.

- **Page icons and AI-agent role glyphs are now Lucide icons, not native emoji.**
  A page icon is picked from the Lucide set plus a preset color palette
  (background + glyph); a role glyph is a Lucide icon over the role's existing
  gradient avatar. Both are stored as a small `{"name":…,"color":…}` JSON string
  in the existing `pages.icon` / `aiAgentRoles.emoji` columns (not renamed). A
  defensive parser renders the context's default glyph for anything that is not a
  valid icon reference, so a legacy emoji value — or any malformed value — never
  shows raw JSON; a boot migration NULLs the old emoji values so they fall back to
  the default. Callout and inline-text emoji are unchanged (out of scope).

- **draw.io diagrams reach external publications as a real raster instead of
  silently vanishing.** A draw.io diagram is a single `.drawio.svg` whose visible
  captions live in `<foreignObject>`, which only a browser renders — so any
  server-side rasterizer (resvg, Habr, Inkscape) saw truncated `<text>` fallbacks
  and a "Text is not SVG" banner, and the publication pipeline dropped the node
  entirely, its only trace a warning the agent never relayed. With the new
  `DRAWIO_RASTER_ENABLED` env var (default `false`, so file size stays unchanged
  until an operator opts in), the draw.io editor now embeds the browser-rendered
  PNG of the diagram INTO the same `.drawio.svg` as an inert root
  `data-raster="data:image/png;base64,…"` attribute on save. The visible vector
  body is untouched and re-opening the diagram still extracts its source, so the
  raster and the source can never drift — they are the same bytes written by the
  same writer. Consumers read it back: `stashPage` rewrites a rasterized diagram
  to an `image` node backed by the PNG (and reports `diagrams.{rasterized,degraded}`),
  `viewImage` feeds the model the embedded PNG instead of a garbage resvg render,
  and `drawioGet(format:"svg")` strips the heavy attribute out of the model
  context (with `meta.hasRaster`). Every consumer validates an 8-byte PNG
  signature, so a forged `data-raster` can never masquerade as a real image, and
  the client's write guardrail makes it impossible to overwrite the single source
  copy with a PNG. A diagram with no usable raster degrades loudly (an explicit
  "open it in the editor and save" message), never a silent captionless vector.
  Excalidraw is out of scope (its SVG is not broken); tracked separately (#632).
  The habr-mcp receiver's hard-fail safety net is a separate repo (habr-mcp#1).
  The embedded PNG is exported at 2x (retina) and steps down a 2 → 1 → 0.5
  scale ladder when it would exceed the byte budget, instead of being dropped
  on a false state-mismatch.

- **Page chrome paints from a local boot cache instead of waiting for the page
  request.** With the new `LOCAL_FIRST_ENABLED` env var (default `false`), the
  client keeps a small per-(workspace, user) `localStorage` cache of page
  metadata (title, icon), so opening or reloading a page renders its title,
  header and breadcrumbs without waiting for `/pages/info` — the page is still
  revalidated on every mount and the fresh response always wins. Edit
  affordances are deliberately NOT served from the cache: they stay disabled
  until the live response confirms the permissions. The cache holds no page
  content and no permissions, is purged on logout / sign-in / `401`, and a page
  that returns `403`/`404` is evicted immediately. With the flag off, nothing is
  read or written and behaviour is unchanged. (#563)
- **The page body paints from the local collab replica instead of waiting for
  the collab server.** Under `LOCAL_FIRST_ENABLED` (default `false`), reopening a
  page whose local ydoc already holds content renders the real body immediately —
  no network round-trip — and keeps it strictly READ-ONLY until the collab room
  confirms a sync: no keystroke, no programmatic command and no plugin
  transaction can reach the Y.Doc in that window, so a stale local copy can never
  clobber newer server content on merge. An empty local ydoc keeps today's
  server-seeded static copy (no blank body on a first visit), a real disconnect
  raises a page-wide "offline, showing the cached copy" banner (a healthy
  connection stays silent), and a page that returns `403`/`404` has its local ydoc
  destroyed on disk. With the flag off, behaviour is unchanged. (#564)


- **Changing the embedding model no longer empties semantic search.** The
  embeddings now have a versioned lifecycle: the workspace stores which embedding
  generation search actually serves, and a model/revision/prefix change starts a
  background reindex into a NEW generation while the OLD one keeps answering
  queries. The pointer flips to the new generation atomically, and only after the
  reindex has covered every page — a run with failures or a fatal provider abort
  leaves the previous generation serving instead of publishing a half-built index,
  and is retried automatically with backoff (a transient embedding-sidecar timeout
  no longer parks the workspace in a half-swapped state until someone notices).
  Superseded generations (including pre-existing rows written before fingerprints
  existed, which until now were silently invisible to search) are reclaimed by a
  generational GC capped at two live generations. Search responses report the
  state (`off` / `stale` / `full`) with an indexed/total count, so a degraded or
  in-progress index is visible instead of silently returning fewer results. If the
  configured model differs from the one the served generation was built with,
  search and the AI agent's retrieval fall back to lexical-only rather than
  comparing vectors from two different embedding spaces (which would rank random
  pages above genuine matches). A reindex of one workspace is serialised, so a
  retried background job can never corrupt an in-flight one. (#599)
- **A drifted comment suggestion can be re-synced instead of failing forever
  with a 409.** A suggestion whose stored anchor no longer matched the live
  document used to reject every apply attempt with an unrecoverable conflict; a
  new resync path re-reads the live anchor so the suggestion applies against the
  current text, and orphaned anchors (whose marked run was deleted) are
  reconciled rather than left blocking. (#496)
- **Save intentional page versions.** Press `Cmd/Ctrl+S` (or use the page menu)
  to save a named version of a page. The history panel now distinguishes
  intentional versions (a "Saved" / "Agent version" badge) from automatic
  snapshots, dims autosaves, and offers an "Only versions" filter. Automatic
  snapshots switched from a fixed interval to a trailing idle-flush with a
  max-wait ceiling, and a boundary snapshot is pinned whenever the editing source
  changes (e.g. a person's edits followed by the AI agent). (#370)
- **Open tabs pick up a new deploy on their own.** After the server is
  redeployed while a tab is left open for hours, the tab now learns the new
  build version over the existing WebSocket (announced per-connect, so a natural
  reconnect delivers it) and shows a "A new version is available" banner with an
  Update button. To avoid dropping a half-written comment or form, the tab is
  not reloaded when you merely switch away from it; instead it auto-reloads at
  the next safe point — the next in-app navigation (or immediately if you click
  Update) — before it can hit a stale lazy-loaded chunk. At most one automatic
  reload happens per 5-minute window, shared with the existing chunk-load
  recovery, so a permanent version skew degrades to the banner rather than a
  reload loop while a second deploy in the same tab still recovers. When the
  build carries no version info the feature stays inert. (#481)

- **Place several images side by side in a row.** A new "Inline (side by
  side)" alignment mode in the image bubble menu renders consecutive inline
  images as a row that wraps onto the next line on narrow screens. The row is
  centered horizontally by default in modern browsers (CSS `:has()`), falling
  back to start-aligned rows in browsers without support. Unlike the float
  modes, text does not wrap around inline images. The mode round-trips
  losslessly through markdown as `data-align`, like the other alignment
  values.

- **Editable captions for images.** Images gain an optional caption shown
  below them, edited inline from the image bubble menu and stored as a `caption` attribute. Captions round-trip
  losslessly through markdown as a `data-caption` attribute on the image, so
  they survive export/import unchanged. (#221)

- **Quick-create regular and temporary notes from the Home and Space screens.**
  The Home screen now shows a second action next to "New note" that creates a
  *temporary* note (one that auto-moves to Trash after the workspace lifetime),
  resolving the target space the same way the regular button does — created
  directly when you can write to a single space, or via a space picker when
  several. Each space overview screen gains two buttons — "New note" and "New
  temporary note" — that create the page directly in that space and open it,
  mirroring the existing space-sidebar actions and shown only to members who can
  manage pages.
- **Interrupt the AI agent and send a queued message now.** A queued AI-chat
  message gains a "send now" action that interrupts the streaming turn and
  immediately sends that message, keeping the agent's partial output. The
  follow-up turn is tagged as an interrupt so the model is told its previous
  answer was cut off and builds on it instead of restarting; the rest of the
  queue still flushes normally afterward. (#198)

- **Importable multilingual agent-roles catalog.** Admins can browse a curated
  catalog of agent roles, grouped into bundles and offered in several languages,
  and import the ones they want into the workspace (with skip-or-rename handling
  for name collisions); the same role in a different language imports as a
  separate install. An imported role remembers its catalog origin and offers a
  one-click update when the catalog ships a newer revision. Backed by four new
  admin endpoints — `POST /ai-chat/roles/catalog` (browse bundles),
  `/catalog/bundle` (read one bundle's roles), `/import`, and
  `/update-from-catalog` — and a new `source` column linking a role to its
  catalog slug/language/version. The catalog source is configured via the
  `AI_AGENT_ROLES_CATALOG_URL` env var — an `http(s)://` base URL to the
  catalog's raw files; the image ships a per-branch default baked in CI, and it
  can be overridden at runtime via the env var (see `.env.example`). (#222)
- **Author footnotes inline from an agent, and deterministic server-side footnote
  canonicalization on every non-editor write path.** A new MCP `insert_footnote`
  tool places a footnote at a body anchor by content only — the agent supplies
  WHERE (anchor text) and WHAT (markdown); the number and the bottom
  `footnotesList` are derived server-side, so an agent can never assign a number,
  edit the list, or desync, and a same-content note reuses one definition. Under
  the hood, the editor's footnote-integrity invariant (one trailing list,
  numbering by first reference, no orphans/duplicates, no raw `[^id]`) is now
  enforced as a pure `canonicalizeFootnotes(doc)` on the FULL-document write paths
  that bypass the editor's plugins: server markdown/HTML import, `PageService`
  create and full-document (`replace`) updates, the client markdown paste, and the
  MCP markdown page-import / `update_page` (markdown) / `update_page_json` /
  `docmost_transform` / `insert_footnote` / `copy_page_content` paths. It is
  idempotent (a no-op once canonical) and is deliberately NOT applied to
  append/prepend fragments, nor to COMMENT bodies — a comment may legitimately
  contain a standalone footnote definition, which canonicalization would drop.
  (#228)
- **Detached, autonomous agent runs that survive a browser disconnect.** When the
  new `settings.ai.autonomousRuns` workspace flag is on (off by default), an
  AI-chat turn becomes a first-class, server-side RUN tracked in a new
  `ai_chat_runs` table instead of a socket-bound stream: closing the tab or
  losing the connection no longer aborts the turn — it keeps executing and
  persisting server-side, and only an explicit Stop ends it. A client can
  reconnect and live-follow (or stop) an in-flight run via `POST /ai-chat/run`
  (resolve the latest run + its assistant message for a chat) and
  `POST /ai-chat/stop` (stop by `runId` or `chatId`). A partial unique index
  enforces one active run per chat, and a startup sweep settles any run left
  dangling by a restart. Phase 1 is single-instance-only (cross-instance Stop is
  not yet reliable); the server warns at startup on a horizontally-scaled
  deployment. (#184)
- **Server-side "interrupt and send now" (supersede) for AI chat.** `POST
  /ai-chat/stream` now accepts a `supersede: { runId }` field: when the user sends
  a new message while a run is active, the server atomically stops that run and
  waits for it to settle before the new turn claims the chat's single run slot,
  instead of the send being rejected as concurrent. The compare-and-set surfaces
  three codes on its non-proceed branches — `SUPERSEDE_INVALID` (the targeted run
  is malformed / belongs to another chat), `SUPERSEDE_TARGET_MISMATCH` (a
  different run is now active; carries the current `activeRunId`), and
  `SUPERSEDE_TIMEOUT` (the previous run did not stop within the settle window, so
  nothing was sent and the composer keeps the text). Tunable via
  `AI_CHAT_SUPERSEDE_TIMEOUT_MS` (default 10s). (#487)
- **Out-of-band page transfer via an in-RAM blob sandbox (`stash_page`).** A
  new MCP tool serializes a whole page (its full ProseMirror JSON, with every
  internal image/file mirrored) into an ephemeral in-RAM blob and returns only
  a short anonymous URL, so a large page can be handed to an external consumer
  without flooding the model context. Blobs are served by unguessable UUID over
  a new anonymous `GET /api/sb/:id` route (strong sha256 ETag, short TTL,
  `nosniff` + restrictive CSP + attachment disposition for non-image mimes) and
  are RAM-only, bound to the instance that created them. Tunable via five
  `SANDBOX_*` env vars (see `.env.example`). (#243)
- **Inline spoiler mark — hide text behind click-to-reveal blur.** Selected text
  can be marked as a spoiler from a new bubble-menu toggle, or typed Discord-style
  with the `||text||` input rule; the rendered span blurs until clicked to reveal.
  The mark is preserved losslessly through Markdown export/import (as a raw
  `<span data-spoiler="true">…</span>`) and on public shares. (#259)
- **Dock the AI chat window into the side menu.** The floating chat window can
  be pinned to the sidebar — drag it onto the navbar (a drop-zone highlight
  shows where it lands) or use the new "Dock to sidebar" header button; while
  docked it fills the sidebar area and follows its live size. "Undock" (or
  dragging it back out) restores the floating window, a collapsed/absent
  sidebar falls back to floating, and the docked state survives a reload.
  (#276, #282)
- **Hovering commented text shows the comment thread in a tooltip.** Pointing
  at a highlighted comment mark pops a small card with the author and plain
  text of the root comment and its replies, so a thread can be skimmed without
  opening the side panel. The card appears after a short delay (no flicker on a
  passing glance), skips resolved and text-less threads, and dismisses on
  scroll or click — clicking a mark still opens the comments panel. (#268,
  #271)
- **"Move to trash" button in the temporary-note banner.** Besides "Make
  permanent", the banner on an open temporary note now also offers to trash the
  note immediately instead of waiting out its lifetime. It reuses the regular
  soft-delete path, so the "Page moved to trash" undo toast is the safety net —
  no confirmation dialog. (#273, #277)
- **Code-block controls float as an overlay instead of taking a row above the
  code.** The language selector and copy button now sit in the block's top-right
  corner, and the selector stays invisible until the block is hovered or the
  selector is focused, so reading code is chrome-free. In read-only views only
  the copy button renders. (#275, #278)
- **The AI agent is told about your page edits between turns.** The server
  snapshots the open page's Markdown at the end of every agent turn and, on the
  next turn, injects a unified diff of what changed in between, so the agent
  knows its earlier copy of the page is stale and builds on the user's edits
  instead of reverting or overwriting them. The diff is whitespace-normalized
  (pure formatting churn injects nothing) and size-capped, with a hint to
  re-read the full page via `getPage` when truncated. (#274, #281)
- **Stress-accent button (U+0301) in the bubble menu.** Select a vowel and
  toggle a combining acute accent over it — a Russian-style stress mark. The
  accent is stored as plain text (no custom mark), so it survives Markdown/HTML
  export, full-text search and public shares unchanged; the toggle is a single
  undo step and re-clicking removes the accent. (#270, #280)
- **Reading position survives a reload.** The editor remembers how far you
  scrolled in each page (per tab, in `sessionStorage`) and restores that
  position after an F5 or reopening the document, waiting for the collaborative
  content to finish laying out first. A URL `#hash` anchor still wins — restore
  is a no-op then. (#266, #267)
- **The slash menu finds commands typed in the wrong keyboard layout.** A query
  typed with the wrong layout active (e.g. `/сщву` for `/code`, or `/cyjcrf`
  for the Cyrillic «сноска» → Footnote) is additionally remapped ЙЦУКЕН↔QWERTY
  by physical key position and matched against the commands; genuine Cyrillic
  search terms keep priority over remapped candidates, and short wrong-layout
  prefixes match by command title. (#283, #285, #287)
- **Opt-in substring "lookup" search mode for agents.** `/api/search` gains an
  additive, opt-in mode (guarded by a new `substring` flag) that matches literal
  substrings of page titles and body text — so technical tokens the full-text
  tokenizer mangles (`backup-srv.local`, `10.0.12.5`, `WB-MGE-30D86B`) are found
  even when the FTS query is empty. It returns a location `path`, a windowed
  `snippet` and a per-response relevance `score`, supports `titleOnly` and a
  `parentPageId` subtree scope, and applies the page-level permission filter
  before the limit. The web UI never sets `substring`, so its full-text search
  behaviour is byte-for-byte unchanged. The leading-wildcard `LIKE` predicates
  are backed by GIN trigram indexes on `LOWER(f_unaccent(title))` and
  `LOWER(f_unaccent(text_content))` so lookups use a bitmap index scan instead of
  a sequential scan. (#443)
- **MCP `search` tool returns richer, agent-oriented results.** The external MCP
  `search` response shape changes for the agent surface: each hit now carries
  `pageId` (renamed from `id`), plus `path`, `snippet` and `score`; the
  UI-oriented `spaceId`, `rank` and `highlight` fields are dropped. (#443)

### Changed

- **The page→chat binding now follows the chat you actually have open.** Which
  AI chat opens for a page used to be an implicit, write-once guess ("the most
  recent chat whose `page_id` is X"), so selecting a different chat from the
  history, or starting a new one, did not change what the page opened next
  time. The binding is now explicit, mutable, per-user state: selecting a chat
  re-binds it to the open page, "New chat" clears the binding (an empty chat is
  a legitimate "nothing bound"), and following a deep link from a chat badge
  deliberately does NOT move it. `ai_chats.page_id` keeps its original meaning —
  immutable provenance of where a chat was born, and the "· PageTitle" line in
  the history list. Also fixes a live bug: a chat opened from `/home` could
  latch onto the last page visited, because the open-page resolution read a
  stale placeholder instead of the current route. **Upgrade note:** migration
  `20260716T130000` creates `ai_chat_page_bindings` and backfills it from the
  retired heuristic (newest non-deleted chat per creator+page), so nothing is
  lost on release day. (#665)

- **Bigger, more legible page icons in the sidebar tree.** The icon tile was
  fixed at 18px inside a 28px button, leaving a wide dead gap before the title,
  and its background was a 10% tint that read as a washed-out square. Icons now
  scale with the tree density (20px compact / 24px standard) and the tile
  carries roughly 3x more colour, with the glyph tone decoupled from the tile
  hue so every palette colour still clears the 3:1 non-text contrast bar in
  both light and dark schemes.

- **MCP tool descriptions no longer promise block ids on nodes that have
  none.** Verified against the built schema, only paragraphs and headings carry
  a block anchor (plus the cross-reference keys on footnotes/mentions/
  transclusions) — the docs for `getNode`, `patchNode`, `deleteNode`, the six
  draw.io tools and both READMEs claimed callouts, images and diagrams did too,
  which stalled agents on "this block cannot be edited because it has no id".
  `patchNode` and `deleteNode` now carry the escape hatch (a nested paragraph is
  patchable by its own id if it has one; markdown-imported blocks often have
  none; `getOutline` never shows nested ids; an id-less container goes through a
  scripted transform), `docmostTransform`'s context helpers are documented by
  their real path (`ctx.helpers.X`, not `ctx.X`), and `editPageText`'s docs now
  distinguish the tolerant markdown handling of `find` from the literal
  treatment of `replace`. Text only — no behaviour, schema or parameter change.

- **The MCP/agent verify diff now uses the fixed in-app diff algorithm, and its
  DoS size guard was tightened to actually hold its ~200ms budget (byte cap
  `12 KiB` → `4 KiB`).** `diffDocs` (the precise diff behind every agent edit's
  verify report) switched from the published
  `@fellow/prosemirror-recreate-transform` to the same `recreateTransform` the
  editor's history diff uses (`@docmost/editor-ext`, fixed in `#581`): 1.5-5x
  faster on every measured shape, and MCP can no longer disagree with the UI about
  what changed. Re-benchmarking the pre-flight guard from `#464` against the new
  algorithm (`packages/mcp/scripts/diff-size-guard-bench.mjs`) showed the **byte
  cap was never holding the budget it advertised**: the byte-heavy worst case (text
  rewritten wholesale) costs its time inside `ChangeSet.addSteps` — which re-diffs
  the replaced range token by token and which `#581` did *not* touch (at 6 KB:
  `recreateTransform` 17ms vs `addSteps` 194ms) — so the old 12 KiB cap was
  **admitting 300-660ms event-loop blocks** (seconds before `#581`) while the docs
  claimed ~200ms. The byte cap therefore drops to **4 KiB**, the largest value under
  which every admitted shape stays inside ~200ms (worst admitted: 156ms; the
  adversarial short-token shape, which costs ~40-60% more per byte, peaks at 136ms).
  **This is a DoS fix, and it SHRINKS the precise-diff envelope**: byte-heavy pages
  that used to get precise change ranges now degrade to the coarse block-level diff.
  Operators who accept the block in exchange for precise diffs on such docs can opt
  back in with `MCP_DIFF_MAX_BYTES=6144` (~200-235ms) or `=12288` (~400-660ms, the
  previous behaviour). The node cap rises `150` → `200`, but note it is *subsumed*
  by the byte cap at the default setting (~55 B of JSON per text block means only
  ~68 blocks fit in 4 KiB) and only becomes live if `MCP_DIFF_MAX_BYTES` is raised;
  `MCP_DIFF_MAX_NODES` remains an env override. Fully-rewritten documents may now
  report a single whole-document change instead of a per-block list; the counts are
  unchanged.

- **Every AI-chat turn is now a first-class server-side run, and one run per chat
  is enforced in both modes.** The run machinery from `#184` was universalized: a
  turn is tracked in `ai_chat_runs` and gated by the single-active-run-per-chat
  index regardless of the `settings.ai.autonomousRuns` flag. **Behavior change:**
  a second tab (or a double-submit) that starts a turn while one is already active
  on the chat is now rejected up front with `409 A_RUN_ALREADY_ACTIVE` (carrying
  the `activeRunId`); previously, on the legacy path, it opened a second parallel
  stream on the same chat that interleaved history. The `autonomousRuns` flag no
  longer controls whether a turn is a run — it now governs **only** the
  browser-disconnect semantics (ON = detached/survives a disconnect; OFF = a
  disconnect stops the run). (#487)
- **Vendor `ai` patch: upstream-tracking + version-alignment plan documented.**
  The two local `ai@6.0.134` fixes (O(n²) `partialOutput` heap-OOM; the
  `writeToServerResponse` drain-hang) and the hocuspocus connect-vs-unload race
  now have explicit upstream-reporting and `ai`-version-alignment steps recorded
  in `AGENTS.md` (client `ai@6.0.207` vs server `ai@6.0.134`-patched drift). The
  patch bytes are unchanged — they feed the lockfile `patch_hash`, so the
  alignment is called out as an install-gated plan rather than a bare version
  bump. No runtime change.
- **Client markdown paste/copy and AI-chat rendering now go through the canonical
  converter.** Pasting markdown into the editor, "Copy as markdown", the AI title
  generator, and the AI-chat markdown renderer all now use
  `@docmost/prosemirror-markdown` (via its new `browser` entry — native
  `DOMParser`, no jsdom in the client bundle) instead of the hand-written
  `marked`/`turndown` markdown layer in `editor-ext`, which was **deleted**. As a
  result, pasting canonical markdown (`^[…]` footnotes, `<!--img …-->`,
  `> [!type]` callouts, `$…$` math, `==…==` highlight, standalone `<!--subpages-->`
  comments) now produces the SAME nodes the server import produces for the same
  text. Chat/reasoning markdown now renders through the editor schema (list items
  are wrapped in `<p>`; CSS keeps them tight). (#347)

- **Enabling a public share no longer auto-shares the whole sub-tree.** Turning
  a page "Shared to web" now defaults to the page alone; descendant pages become
  public only when you explicitly turn on the dedicated "Include sub-pages"
  toggle. Previously the create call defaulted to including sub-pages, silently
  exposing every child of a freshly shared page. (#216)

- **The agent-roles catalog is now stored as YAML instead of JSON.** Each role's
  long `instructions` system prompt is a literal block scalar (`|-`), so editing
  a single sentence shows up as a line-by-line diff and the prompt is editable as
  plain multi-line text rather than one escaped JSON string. The catalog content
  files become `index.yaml` and `bundles/<id>/<lang>.yaml` (old `.json` removed);
  the resolved role content is byte-for-byte identical, so no role `version` is
  bumped. The server fetches `<base>/index.yaml` and
  `<base>/bundles/<id>/<lang>.yaml`, parsing them with the `yaml` library's safe,
  JSON-compatible schema (no custom tags / no code execution) behind the same
  size-cap, redirect and path-traversal guards. The `AI_AGENT_ROLES_CATALOG_URL`
  base-URL contract is unchanged. (#229)

### Fixed

- **Safari no longer burns 100% CPU with the editor open on a page containing
  tables, and pinned table headers finally pin.** Four coupled feedback loops,
  each measured on a live instance rather than guessed. (1) No table node view
  was ever installed, so ProseMirror's default mutation handling "repaired"
  every class write on the table wrapper by re-rendering the node, which
  destroyed the wrapper, which re-applied the same classes — a self-feeding
  loop at 150 Hz and ~9000 DOM mutations per second. That is also why header
  pinning never actually worked in edit mode: the wrappers were destroyed
  before their IntersectionObserver could settle (measured 0 pinned tables
  before, 5/5 after). (2) The pin-offset watcher observed `document.body` and
  wrote an inherited custom property on the document element, so its own write
  changed the body box and re-triggered it, oscillating by 1px forever; it now
  observes only the fixed anchors, takes viewport changes from a `resize`
  event, runs only while something consumes the value, and latches with a
  warning if it ever oscillates again. (3) floating-ui's `autoUpdate` ran with
  `layoutShift` enabled, which rebuilds an IntersectionObserver in a loop until
  two ratios compare exactly equal — never, for table cells in a fixed-layout
  table clipped by an overflow wrapper, in WebKit — and one click into any cell
  left three such watchers spinning for the rest of the session; layout-shift
  tracking is now off at all seven call sites and the table handle state is
  cleared on editor blur. (4) The read-only table sort plugin swept every table
  in the document on EVERY transaction, including each mouse-move during a
  table drag and each remote collaborative step; it is now gated on real
  document/editability changes.

- **A failed image, video or diagram no longer pulses forever and stays
  unclickable, and the editor no longer gets slower the longer a session
  runs.** The media placeholder shimmer was removed only in the `load` handler,
  so a `404`/`403`/deleted attachment kept pulsing AND kept
  `pointer-events: none` permanently; it now settles on error too, logs the
  specific failure, and animates opacity instead of a 400%-wide gradient that
  could not be composited. Separately, every resizable node view (image, video,
  draw.io, excalidraw, pdf) leaked an update listener on every rebuild — typing
  got monotonically slower over a session — and a failing collaboration socket
  reconnected as fast as the browser could fail it, because a hook dependency
  re-ran the reconnect effect on every render and each attempt cancelled the
  backoff; ordinary failures are now left to the backoff.

- **The sort affordance on read-only table headers comes back, and a nested
  table no longer steals the outer table's sort state.** A redraw with no
  document change drops the chevron from the header cell, which on a read-only
  page may never be re-rendered; a click-time self-heal restores it on the
  first header click. The chevron lookup is also scoped to direct children — a
  plain descendant query found a NESTED table's chevron and wrote the outer
  table's sort state onto it.

- **Opening a page no longer leaks a timer, and no longer burns an 800ms poll
  looking for a scroll target that does not exist.** The scroll-restore helper
  polled with an interval that had no deadline and no cleanup, created one per
  retry (up to ten) and ran on every editor construction — including the common
  case of a URL with no `#hash` at all. The target and retry budget are now
  resolved before waiting, both timers are cleared on every exit path, and a
  give-up warns instead of failing silently.

- **A page's local editor cache is no longer shared across users on the same
  device.** The offline ydoc was stored in IndexedDB under `page.<pageId>` with no
  workspace/user namespace and was never purged on logout, so on a shared machine
  the next person who opened the same page (or a same-id page in another
  workspace) got the previous user's local content as the starting state — and,
  with the local-first boot cache, it could flash on screen before the server
  answered 403/404. The ydoc database is now namespaced by the same
  `<workspace>:<user>` scope key the tree/meta caches use, so different users'
  copies can never physically collide; the `page.*` databases are purged on an
  explicit logout and on sign-in as a different user; and a one-time boot
  migration drops the old un-namespaced databases. A bare `401` deliberately does
  NOT purge the ydoc — unlike the server-authoritative tree/meta caches, the local
  ydoc can hold unsynced offline edits, and a session that expired while offline
  gets a `401` on reconnect before the edits sync, so purging there would lose
  them; the namespacing is what isolates users in the meantime. (Firefox lacks
  `indexedDB.databases()`, so the purge there falls back to a name registry; the
  namespacing is the primary, browser-independent defense.)

- **`editPageText` no longer writes literal markdown markers from a `replace`
  into the page.** The tool documents that a `replace` carrying `**bold**` /
  `~~strike~~` / `` `code` `` wrappers is refused, but it only refused a *pure*
  formatting toggle — a mixed edit (text change plus markers in `replace`) slipped
  through and wrote literal asterisks (silent content corruption for an agent that
  copied markdown out of `getNode`). It now refuses any `replace` containing a
  balanced marker pair, and — because the refusal checks now run *after* the find
  is located — it no longer wrongly blocks a legitimate cleanup of literal
  `**bold**` that is verbatim in the page (that applies, with a self-correcting
  warning). A refused edit fails closed; sibling edits in the batch are unaffected.

- **Copying a PARTIAL table selection no longer puts GFM table syntax into the
  plain-text clipboard.** Selecting one cell used to copy `| T2 |` plus a
  `| --- |` header-separator line instead of the cell's text; selecting one row
  copied the pipe row plus a spurious `| --- |` under it. The separator is GFM
  header syntax, not data — pasted into an existing markdown table it broke the
  structure, read by a human it was noise. Now: a single cell copies its bare
  text; a partial multi-cell selection (row / column / block) copies pipe rows
  WITHOUT the separator; a whole table copied in full still yields a complete,
  valid GFM table (header + separator) as before. Only the `text/plain` payload
  changes — the `text/html` payload (and internal copy/paste back into the
  editor) is untouched. A spanned or multi-block cell still serializes to the
  converter's raw `<table>` HTML fallback, whose interior is left verbatim.

- **`/.well-known/*` no longer answers with the SPA's HTML, and a `/mcp` `401`
  now says how to authenticate.** The SPA catch-all served `index.html` with
  `200 text/html` for *any* unknown GET — including the `/.well-known/`
  namespace that RFC 8615 reserves for machine-readable metadata. An MCP client
  that (per the 2025-06-18 spec) starts OAuth discovery after a `401` from
  `/mcp` fetched `/.well-known/oauth-protected-resource`, got the HTML shell
  with a `200`, and died on `SDK auth failed: Failed to parse JSON` — after
  showing the user a useless **Authenticate** button. `/.well-known` and
  `/.well-known/*` now return `404` with a JSON body — including the spellings
  that do not literally start with `/.well-known/` but resolve to it, such as
  `/%2ewell-known/...` and `/a/..%2f.well-known/...`; ordinary SPA routes (`/`,
  `/p/<slug>`, `/settings/...`, the app's own 404 page) still get `index.html`
  with `200`. In addition, every `401` from `/mcp` now carries the RFC 6750 §3
  challenge naming the credential it actually wants:

  ```
  WWW-Authenticate: Bearer realm="mcp", error="invalid_token", error_description="MCP requires a Bearer api_key token (Authorization: Bearer <api_key>)."
  ```

  On a deployment that sets `MCP_TOKEN`, a request missing (or mis-sending) the
  shared secret is told about *that* header instead — adding the api_key alone
  would never satisfy it, so the old challenge looped such a client forever:

  ```
  WWW-Authenticate: Bearer realm="mcp", error="invalid_token", error_description="MCP requires the shared secret in the X-MCP-Token header (X-MCP-Token: <MCP_TOKEN>) plus a Bearer api_key token (Authorization: Bearer <api_key>)."
  ```

  Per RFC 6750 §3.1 the `error="invalid_token"` code is emitted only when the
  credential *that challenge asks for* was actually presented and rejected: a
  request with no `Authorization` header (or, above, no `X-MCP-Token`) gets the
  same challenge without the code, so it is never told a token it never sent is
  invalid. An empty header value counts as not presented. The challenge deliberately
  carries **no** `resource_metadata` parameter: under the MCP spec that would
  advertise an OAuth authorization server, and Gitmost has none — that false
  promise was the bug. `WWW-Authenticate` is also added to the CORS
  `exposedHeaders`, so a browser-based MCP client (e.g. MCP Inspector) can read
  the challenge at all. OAuth (the "Authenticate" button) is **not supported**;
  the only accepted scheme is `Authorization: Bearer <api_key>` (Workspace
  settings → API keys):

  ```bash
  claude mcp add --transport http gitmost https://<host>/mcp \
    --header "Authorization: Bearer <api_key>"
  ```

  *Migration:* an MCP config left over from before the Bearer-api_key-only
  change above (still sending `Authorization: Basic <base64 email:password>`,
  a session ACCESS token, or relying on the removed
  `MCP_DOCMOST_EMAIL`/`MCP_DOCMOST_PASSWORD` service account) now gets a `401`
  and, in a spec-conformant client, falls straight into that broken OAuth path.
  Replace the header with `Authorization: Bearer <api_key>`.

- **CI: the client is now typechecked on every PR.** The client's `test` script
  is `vitest run`, i.e. esbuild — it *strips* types without checking them, while
  the release path (`build`, the same one the docker image takes) is
  `tsc && vite build`. A type error in any client file therefore passed the PR
  gate fully green and only surfaced when the image was built; four TS errors
  reached develop that way, in new test files. An explicit `Typecheck client`
  step (`pnpm --filter client typecheck` → `tsc --noEmit`) now runs after the
  workspace packages whose `.d.ts` it reads are built, and before the tests.
  Test files live under `src/` and are covered by `include`, so they are
  checked too — as intended.

- **A public share no longer serves an attachment whose page has been trashed.**
  The public file endpoint validated the share token but never re-read the
  soft-delete state, so a valid (1-hour) attachment token kept streaming the
  bytes after the page was moved to the trash. This became reachable with the
  `approved` share mode: the published content is a FROZEN saved version that
  still references the attachment, whereas a live draft simply drops the node.
  The endpoint now re-checks the page (and the attachment row) on every public
  hit and answers with the same `404 File not found` it already used for a
  mismatched token, so nothing about the file's existence leaks. Note that an
  already-served response stays cacheable for up to an hour (`Cache-Control:
  public, max-age=3600`), so the guard applies to origin hits. (#574)

- **The MCP integrity guard now names a lost attachment / media / embed /
  transclusion, not only diagrams.** Extending the draw.io/Excalidraw fix below,
  the structural integrity guard behind `diffPageVersions` and the post-write
  verify report now counts every remaining block ATOM whose whole payload lives
  in its attributes — `attachment`, `video`, `audio`, `pdf`, `embed`, `youtube`,
  `htmlEmbed`, `mathBlock`, `pageEmbed`, `subpages`, and the two transclusion
  nodes. Deleting one of these moves no prose and no marks, so it left only the
  single leaf placeholder an atom emits in the text delta — a 1-char change
  indistinguishable from fixing a typo (the same blind spot code blocks and
  diagrams already closed). This is most painful for `attachment`: an agent that
  uploads a file and inserts the node could silently drop it on a later edit with
  nothing to name the loss. Each type is now its own `[old, new]` integrity kind
  — a `video: N -> N-1` line in `## Integrity` and a `structure.video` entry in
  the write report. They are counted SEPARATELY, never in one `media`/`embeds`
  bucket: a bucket would report a `video` swapped for an `audio` as `1 -> 1`
  (clean) and omit it from the report, recreating the very blind spot. Detection
  only, as before: it makes such a loss loud, it does not prevent it. Like
  `images`, the count catches CARDINALITY, not a mutated `src`/`attrs` on a
  surviving node.

- **A lost draw.io/Excalidraw diagram is no longer unnamed in the MCP integrity
  guard.** The structural integrity guard behind `diffPageVersions` and the
  post-write verify report counted images/links/tables/callouts/code blocks, but
  no diagram kind — and a diagram is a block ATOM whose whole payload lives in
  its attributes, so deleting one moves no prose and no marks: the only trace was
  the single leaf placeholder an atom leaves in the text delta, i.e. a 1-char
  change indistinguishable from fixing a typo (the same blind spot a vanished
  code block used to have). `drawio` and `excalidraw` are now counted as their
  own integrity kinds: losing (or gaining) one raises the same class of flag as
  losing a table — a `drawio: N -> N-1` line in the diff's `## Integrity` block
  and a `structure.drawio` entry with `changed: true` in the write report, so the
  loss is NAMED rather than hidden in a text delta. They are deliberately two
  keys, not one `diagrams` bucket: a bucket would report a drawio swapped for an
  excalidraw as `1 -> 1` (clean) and omit it from the report entirely. Detection
  only: this makes such a loss loud, it does not prevent it.

- **MCP write tools no longer report a false failure that provokes a duplicate
  write.** `drawioCreate` used to throw when the diagram landed as a NESTED block
  (anchored inside a callout or table cell) because there is no `#<index>` handle
  for it — but the diagram was already written, so a retry-prone agent re-created
  it and produced a duplicate. It now returns success with `nodeId: null` plus a
  warning that explains the write landed and how to re-read it (via
  `getOutline` / `getPageJson` by `attachmentId`). Separately, when the live
  collaboration-session cache hits its LRU entry cap, evicting a session whose
  write is still in flight no longer rejects that write as a hard failure — it is
  reported as INDETERMINATE ("the update may already have persisted; verify
  before retry") so the agent re-reads instead of blind-retrying, and a
  still-connecting session is no longer picked as an idle eviction victim by a
  parallel acquire. (#494)
- **A long AI chat no longer bricks on the model's context window, and each turn
  stops re-persisting the whole tool-output history.** Tool outputs are now
  stored ONCE, in `metadata.parts`; the `tool_calls` trace keeps only per-step
  outcome flags (a v2 trace shape), ending the O(N²) write amplification that
  re-wrote every prior output on every step (measured on a live Postgres via the
  `pg_current_wal_lsn()` delta: the trace column shrank ~3200×, the full
  assistant row ~51%). The persisted record is unchanged in content — the full
  history still lives in `metadata.parts`. At REPLAY time only, the history sent
  to the provider is now bounded by a deterministic, prompt-cache-friendly token
  budget: `floor(0.7 × chatContextWindow)` when a window is configured (no cap —
  anti-brick protection, not a cost limiter), a flat 100k fallback for installs
  with no window set (exactly the ones that hit terminal overflow), or off when
  the window is explicitly `0`. Trimming truncates old tool outputs first, then
  mechanically collapses the oldest turns, always keeping the recent turns full
  and the tool-call/result pairing balanced. A provider context-overflow 400 is
  now classified and used as a reactive signal: the row is stamped so the NEXT
  turn re-trims aggressively (0.5×), which un-bricks a chat that just 400'd. The
  client token badge and the server budgeter now share one estimator (new
  `@docmost/token-estimate` package) so they can never diverge. Deferred-tool
  activation is also cached in the chat metadata to avoid re-resolving it each
  turn. (#490)
- **Cyrillic (and any non-ASCII) draw.io labels no longer turn into mojibake
  when a diagram is opened in the draw.io editor.** Agent-created diagrams
  (`drawioCreate`) and Confluence-imported diagrams stored their model in the
  SVG's `content=` attribute as base64; the draw.io editor decodes that via
  Latin-1 `atob` (no UTF-8 step), so every non-ASCII char (e.g. `Старт-бит`,
  `ё`, `—`) split into garbage and the editor's autosave then persisted the
  corrupted model, breaking the page preview too. Both write paths
  (`buildDrawioSvg`, the import service's `createDrawioSvg`) now write `content=`
  as XML-entity-escaped mxfile XML — draw.io's own native form, decoded by the
  DOM as UTF-8 — so labels open intact. The decoder reads both the new
  entity-encoded form and the old base64 form, so existing diagrams still open.
  *Healing pre-fix diagrams:* only a diagram that still holds its original
  (correct-UTF-8) base64 — i.e. one not yet opened/autosaved in the draw.io
  editor — can be repaired in place by `drawioGet` → `drawioUpdate` with the
  same XML (rewrites the attachment in the new form); no migration script is
  needed. A diagram that was already opened in the editor persisted the
  mojibake at rest, so `drawioGet` reads the already-corrupted text and
  `drawioUpdate` faithfully rewrites it — that text is lost and is not
  recoverable by a rewrite. (#507)
- **A chat with one malformed message part no longer 500s on every turn, and a
  failed send no longer duplicates the user's message.** Incoming client parts
  are now whitelisted to `text` (a forged tool-result part can no longer reach
  the persisted history or the model context), and the turn is converted BEFORE
  the user row is inserted, so a mid-flight failure cannot leave a duplicate
  user row that a retry then compounds. A single part that still fails to convert
  degrades to a `[tool context omitted]` marker on that one row instead of
  bricking the whole chat. (#489)
- **A transport drop to an external MCP server now heals within the same turn.**
  On an undici transport error, a read-only MCP tool reconnects its server and
  retries once within the run; a write is never auto-retried (it may already have
  applied). One flapping server no longer nulls the shared client cache, so other
  servers' cached clients are untouched. The SSE transport also gets a raised
  body-timeout so a legitimate >1-min idle between the model's tool calls no
  longer breaks a long-lived SSE socket (new `AI_MCP_SSE_BODY_TIMEOUT_MS`, default
  10 min; see `.env.example`). (#489)
- **Decisions on comment suggestions now leave a durable audit record.**
  Applying or dismissing a comment suggestion hard-deletes the (childless)
  subject comment, so the only surviving trace of who decided what is the audit
  event — but the audit trail was wired to a Noop service that silently
  swallowed every event. The trail is now DB-backed, so
  `comment.suggestion_applied` / `comment.suggestion_dismissed` (and the other
  comment-decision events) persist to the `audit` table and can be reviewed
  after the comment is gone. A persistence failure is still swallowed with a
  warning so it never breaks the originating request. (#496)
- **Applying a comment suggestion no longer strips the replaced run's inline
  formatting.** The suggested text was re-inserted carrying only the comment
  anchor mark, silently dropping bold/italic/code/link on the affected run; the
  prevailing formatting of the replaced run is now carried onto the applied
  text. (#496)
- **Markdown round-trips no longer silently drop a line that opens with a block
  trigger.** When a document is exported to Markdown and re-imported (git-sync
  stabilize, agent writes), a paragraph or continuation line (after a hard break)
  that begins with a block marker — an ATX heading `#`, a blockquote/callout `>`,
  a list marker (`-`/`*`/`+`/`N.`/`N)`), a code fence, a table `|`, a thematic
  break (`---`), or a setext underline (`--`, `----`, or a lone `=`) — is now
  backslash-escaped so it round-trips as text instead of being re-parsed into a
  heading/list/quote/rule and losing its content. Front-matter stripping is
  scoped to the import path only. (#493)
- **The server no longer runs out of heap during long autonomous agent runs.** A
  new pnpm patch on `ai@6.0.134` stops the SDK from building a cumulative
  snapshot of the ENTIRE turn text on every streamed text-delta when no output
  strategy was requested (our server never requests one). Unpatched, those
  O(n²) `partialOutput` snapshots piled up in a never-consumed internal
  `tee()` branch of the stream result — a ~20-step, ~28k-chunk agent run
  retained ~1.7 GB and OOM'd the 2 GB JS heap. Streaming granularity is
  unchanged; the patch must be re-created if `ai` is ever bumped. (#184)

- **The server no longer leaks a hung stream pipe on every mid-run client
  disconnect.** The same `ai@6.0.134` pnpm patch now also fixes the SDK's
  `writeToServerResponse`, which awaited only a `"drain"` event under
  backpressure: when a client disconnected mid-write the socket never drained, so
  the write loop parked forever, `response.end()` was unreachable, and the stream
  reader plus buffered chunks were pinned until process restart (every mid-run
  disconnect in autonomous mode leaked one). The patch races `"drain"` against
  `"close"`/`"error"`, cancels the reader and ends the response on disconnect, and
  swallows the fire-and-forget read rejection instead of crashing on an
  unhandledRejection. (#486)

- **A failed autonomous agent-run start no longer becomes an unstoppable ghost
  run.** When `beginRun` failed for a transient reason (e.g. a DB-pool blip),
  the turn previously continued with NO run row — invisible to `/stop`, not
  aborted on disconnect, and able to slip a second run past the one-run-per-chat
  gate, leaving an unstoppable run until restart. The turn now fails fast with an
  honest `503 A_RUN_BEGIN_FAILED` before the first byte (no orphan state), and the
  client shows a "temporary — please try again" message instead of a misleading
  "provider not configured". (#486)

- **A pathological draw.io graph can no longer wedge the whole server.** The ELK
  auto-layout (`layout:"elk"`) ran elkjs synchronously on the main event loop, so
  a graph at the node/edge cap blocked ALL HTTP/SSE/loopback traffic while it
  churned — and the old `setTimeout` "timeout" could never fire because the same
  thread was blocked. Layout now runs in a worker thread with the timeout enforced
  by `worker.terminate()`; the main loop stays responsive. (#486)

- **The `/health` Redis probe no longer leaks a client on every tick while Redis
  is down.** It built a new `ioredis` client per probe and disconnected it only on
  success, so during an outage each health tick added another forever-reconnecting
  client (an unbounded handle leak). A single long-lived probe client is now
  reused and closed on shutdown. (#486)
- **Internal links in exported Markdown no longer lose their visible text.** A
  link whose target page name had no file extension (e.g. a bare title) was
  collapsed to empty text during export, producing an unclickable, label-less
  link; the page name is now preserved. (#204)
- **Deep pages no longer render a blank breadcrumb while the sidebar tree loads.**
  The breadcrumb now falls back to the page's own ancestor chain (fetched
  independently of the lazily-built sidebar tree) so a deep page resolves its
  trail immediately; navigating away no longer leaves the previously-viewed
  page's breadcrumb showing until the new one resolves. (#206, #218)
- **Pasted GitHub-style callouts (`> [!NOTE]` …) now convert to real callouts.**
  GitHub admonition blocks pasted as Markdown are recognized and rendered as
  callout blocks instead of plain block-quotes. (#192)
- **The editor stays read-only until collaboration has synced.** While a page is
  connecting, the body is shown as a non-editable static view with a
  "Connecting… (read-only)" banner, so edits typed before the document finishes
  syncing can no longer be silently dropped. (#218)
- **A shared page now keeps EXACTLY ONE custom address (`/l/:alias`).** Editing a
  page's vanity slug previously inserted a second `share_aliases` row instead of
  renaming the existing one, leaving the old `/l/<old>` link live forever and
  making the share modal's lookup nondeterministic. Slug edits and confirmed
  reassigns now rename/retarget the single row, and a new partial unique index on
  `(workspace_id, page_id)` enforces the invariant in the database. **Upgrade
  note:** the accompanying migration `20260627T120000` IRREVERSIBLY deletes the
  orphaned duplicate alias rows the old bug created (keeping the newest per
  page), so any previously-live duplicate `/l/<old>` link begins returning the
  generic 404 after upgrade — intended, but not undoable by `down()`. (#226,
  #227)
- **Typing a custom address already used by another page no longer looks like a
  dead end.** The share modal previously flagged such a name with a red "This
  address is already in use" error, hiding the fact that saving offers to MOVE
  the address to the current page. The field now shows an informational hint —
  "This address is in use. Saving will move it to this page." — and keeps Save
  enabled, so the existing reassign-confirm flow (`409 ALIAS_REASSIGN_REQUIRED` →
  "Move custom address?") is discoverable instead of reading as terminal. (#227)
- **A non-empty page can no longer be silently lost to a momentarily-empty live
  document.** The server's persistence guard now refuses to overwrite non-empty
  persisted content with an empty live Y.Doc — a transient emptiness from a
  glitch, a bad merge, or an emptying transclusion no longer wipes the saved
  page. A *deliberate* clear still works: a select-all + Delete in the editor
  emits a single-use "intentional clear" signal that lets exactly that one empty
  write through the guard, so genuinely emptying a page is persisted while
  accidental empties are blocked. (#248, #251)
- **Ctrl+Z works again right after using a table menu.** Closing a table
  row/column menu (grip or chevron) left focus on the menu's portaled target
  outside the editor, so undo keystrokes went nowhere until you clicked back
  into a cell. The editor is now refocused after the menu closes — unless you
  deliberately moved focus to another input or editable (e.g. the page title).
  (#269, #279)
- **The AI reindex progress counter no longer freezes at 0.** Right after
  "Reindex now" the client could read the stale pre-reindex snapshot of an
  already-indexed workspace (`reindexing=false`, all pages counted) as
  "finished" and stop polling on the very first tick, leaving the counter
  frozen until a manual reload. Polling now keeps going until it has actually
  observed the active run. (#262, #264)
- **An MCP edit can no longer be silently lost to a duplicate collab document.**
  When the agent addressed a page by its short slugId, the MCP opened a
  collaboration document named after that slugId while the web editor always
  uses the page's canonical UUID — two independent live documents for one page,
  whose debounced stores clobbered each other. The MCP now resolves every page
  id to the canonical UUID before opening the collab doc (a UUID input
  short-circuits locally; a slugId is resolved once and cached). (#260, #265)

### Security

- **An external MCP server whose stored auth headers cannot be decrypted is now
  SKIPPED instead of being connected without them.** After an `APP_SECRET`
  rotation the encrypted header blob becomes unreadable; the old behaviour fell
  open and opened an anonymous, header-less connection to the external server.
  It now fails closed — the server is dropped from the turn with an
  `auth-unreadable` outcome, a WARN carrying the server/workspace id (never the
  blob) and an `ai_external_mcp_connect_failures_total` sample, so the operator
  sees the outage instead of a silently unauthenticated connection. Applies to
  admin-managed and personal servers alike. (#686)

- **The anonymous public-share page payload is trimmed to an explicit allowlist.**
  The `/shares/page-info` route (the only unauthenticated path serializing a
  page + its share) now returns only the fields the public renderer needs;
  internal metadata — creator/last-updater/contributor ids, space/workspace ids,
  AI/source bookkeeping, lock/template flags, parent/position and raw timestamps
  — is no longer exposed to anonymous viewers. (#218)
- **A forged or mismatched share id can no longer render a page off its slug
  alone.** When the public URL carries a share id/key, the page must be reachable
  through that exact share (its own share or an ancestor `includeSubPages`
  share); any other value now returns the generic "not found" instead of
  serving the page. (#218)
- **MCP tool-allowlist semantics flipped: an empty `[]` now means deny-all
  (previously it was coerced to "no restrictions").** For an external MCP server,
  a stored `tool_allowlist` of `[]` now denies **every** tool of that server
  (zero tools reach the agent) instead of being treated as an empty/unset filter
  that allowed all of them. A corrupt or non-array stored value now **fails
  closed** to deny-all rather than silently allowing everything. The admin form
  no longer silently widens an existing deny-all server: leaving its tag field
  empty preserves `[]` (deny-all) on save instead of NULL-ing the column to
  allow-all, so a routine rename/toggle can no longer grant the agent every tool.
  "No restrictions" is still expressible — a genuinely unrestricted server stores
  NULL, and clearing the field on such a server keeps it NULL. Operationally
  significant: audit any server that was created or left with a literal `[]`, as
  it now exposes no tools until an explicit allowlist (or NULL) is set. The same
  semantics now also apply on the per-run transport-recovery reconnect path,
  which still read an empty allowlist as allow-all. (#476, #685)

- **Tool and provider error text no longer leaks to anonymous readers in the
  public-share AI chat.** A failing tool's raw error (which could carry an
  internal page title or a stack fragment) and a provider error (which bundles the
  provider `statusCode` and response body — potentially the internal baseUrl or
  model name) were streamed verbatim to the anonymous reader over SSE. Errors are
  now sanitized at the source: the share toolset collapses any unclassified tool
  error to a safe generic string (safe, classified tool messages still pass
  through for the model's self-correction), and the anonymous stream `onError`
  maps provider failures to a fixed set of neutral strings — the full detail goes
  only to the server log. A UI render gate is layered on top. (closes #394)

- **The Prometheus `/metrics` endpoint can now require Bearer authentication and
  is loopback-bound by default.** Previously it listened on all interfaces with no
  auth. Setting `METRICS_TOKEN` requires every scrape to present
  `Authorization: Bearer <token>` (compared in constant time), and the listener
  defaults to `127.0.0.1` (see the Breaking Changes entry for the cross-container
  migration). (#486)

## [0.94.0] - 2026-06-26

This release makes AI chat durable and fast: assistant turns are persisted to
the database step by step and exported server-side, the desktop app no longer
freezes at 100% CPU on long agent runs, and MCP writes are badged with
unspoofable AI attribution. It also reworks footnotes (Pandoc-style reuse and
per-reference back-links), hardens page moves and duplication against cycles
and lost edits, and caps the anonymous public-share assistant with a
per-workspace rolling-day token budget.

### Added

- **Custom pretty-links for shared pages (`/l/:alias`).** A page editor can give
  any publicly shared page a short, memorable, workspace-scoped vanity address
  backed by a new `share_aliases` table. Hitting `/l/<alias>` issues a `302`
  (never `301`, since the target is retargetable) to the canonical
  `/share/<key>/p/<slug>` page; an unknown, dangling, or no-longer-readable alias
  serves the plain SPA index so that the existence of a name never leaks. An
  alias can be moved to another page (with a confirm-reassign guard) and the
  foreign key is `ON DELETE SET NULL`, so deleting the target leaves a dangling
  alias any workspace member can reclaim. (#205)

- **Temporary notes — auto-move to Trash after a workspace lifetime.** A note can
  be marked temporary so it auto-moves to Trash once a configurable workspace
  lifetime elapses (default `DEFAULT_TEMPORARY_NOTE_HOURS` = 24h) unless made
  permanent first. The deadline is frozen at creation time, so later changes to
  the workspace setting never reschedule existing notes; an hourly background
  sweep trashes notes past their deadline (children ride along). An open
  temporary note shows a banner with a "Make permanent" rescue action; restoring
  a note from Trash disarms the timer so it is not immediately re-trashed.
  Operators configure the lifetime per workspace. (#201)

- **Persistent AI-chat history as the source of truth + server-side export.**
  An assistant turn is now persisted to the database step by step: the row is
  inserted upfront as `streaming` and updated as each agent step finishes, then
  finalized once to `completed`/`error`/`aborted`. A process that dies mid-turn
  keeps every finished step, and a startup sweep flips any dangling `streaming`
  row (untouched for 10 minutes) to `aborted`. Chat "Copy" now exports
  server-side from these rows (`POST /ai-chat/export`) rather than from live
  client state, so the export is identical whether a chat is freshly streaming,
  just switched to, or reloaded — and is available from the first turn of a new
  chat. (#183, #174)

- **AI-agent attribution for MCP writes.** Comments (and pages) created through
  the MCP endpoint by a dedicated agent account are now badged as "AI", with
  unspoofable provenance derived from a per-user `is_agent` flag (not from the
  request body). **Operator setup:** use a _dedicated_ service account for the
  MCP fallback and set the flag with SQL —
  `UPDATE users SET is_agent = true WHERE email = '<mcp-account>'`. Never flag a
  human or shared account, or its normal edits get mis-attributed as AI. See the
  AI-agent block in `.env.example`. (#143)
- **Footnote import diagnostics.** The MCP page-write tools (`create_page`,
  `update_page`, `import_page_markdown`) now return a `footnoteWarnings` array
  flagging dangling references, empty or duplicate definitions, and `[^id]`
  markers inside table rows, so an agent can fix its own markup. The page is
  still created; the field is omitted when there are no problems. (#166)
- **AI chat "Protocol" setting (`chatApiStyle`).** A new admin choice in AI
  settings for the `openai` driver: `openai-compatible` (default) routes chat
  through `@ai-sdk/openai-compatible`, which surfaces a provider's streamed
  reasoning (`reasoning_content` → reasoning parts) for z.ai/GLM, DeepSeek,
  OpenRouter, etc.; `openai` uses the official provider (real-OpenAI
  reasoning-model request shaping). Chosen explicitly rather than inferred from
  the base URL, since a custom URL can front real OpenAI too. (#175, #177)
- **Per-MCP-server instructions in the agent prompt.** Each external MCP server
  now has an admin-authored `instructions` field ("how/when to use this server's
  tools") that is injected into the agent's system prompt next to that server's
  tool descriptions. Trusted text, rendered inside the prompt safety sandwich;
  shown only for a server that actually connected and contributed ≥1 callable
  tool. (#180)
- **Footnote multi-backlinks.** A footnote referenced more than once now shows a
  back-link per reference (↩ a b c …), each scrolling to its own occurrence, like
  Pandoc/Wikipedia; a single-reference footnote keeps the plain ↩. (#168)
- **Generate a page title from its content.** A "sparkles" button in the page
  byline reads the live editor content (including unsaved edits), generates a
  title via the workspace AI provider (`POST /ai-chat/generate-page-title`), and
  applies it through the existing `/pages/update` route — reflecting it in the
  title field and broadcasting to other clients. Gated by the `settings.ai.generative`
  flag and throttled per user. (#199)
- **AI chat: header button auto-opens the chat bound to the current document.**
  Clicking the AI-chat button in the header while viewing a page now reopens the
  latest chat tied to that document instead of whatever chat was last active,
  reusing the existing `ai_chats.page_id` provenance (no migration). The newest
  chat you created on the page wins; with no bound chat — or off a page, or if
  the lookup fails — it falls soft to a fresh chat and keeps the current
  selection otherwise. (#191)

### Changed

- **AI chat now feeds the model the full stored transcript.** The per-turn model
  conversation was rebuilt from a sliding window of the 50 most recent stored
  rows, which silently dropped the beginning of any longer chat. It is now
  rebuilt from the complete non-deleted transcript in chronological order, so
  the model sees every turn (a 5000-row backstop guards process memory — a
  safety net far above any realistic chat, not a conversational limit). On a
  very long chat this can eventually reach the model's context window; the
  client already surfaces that as "start a new chat". (#202)

- **AI chat default provider is now `openai-compatible` (reasoning surfaced).**
  For the `openai` driver the chat provider defaults to the openai-compatible
  implementation, so a workspace pointing at z.ai/GLM/DeepSeek now streams the
  model's reasoning out of the box. An endpoint that is real OpenAI behind a
  custom base URL should set the new `chatApiStyle` "Protocol" to `openai`. (#177)

- **Footnotes now reuse (Pandoc semantics).** Multiple `[^a]` references to the
  same id are ONE footnote — one number, one definition, several back-references
  — instead of being renamed to `a__2`, `a__3`. Duplicate `[^a]:` definitions are
  first-wins on import (the rest are dropped and reported via `footnoteWarnings`),
  and a reference with no definition yields a single empty footnote rather than
  one per occurrence. This supersedes the 0.93.0 "survive duplicate-id
  definitions" behavior for the import path. (#166)

- **Public share AI: default per-workspace hourly assistant cap lowered
  300 → 100.** The limiter falls back to this default whenever
  `SHARE_AI_WORKSPACE_MAX_PER_HOUR` is unset, so a `0.93.0` deployment that
  never set the env var has its anonymous public-share assistant hourly cap
  cut from 300 to 100 on upgrade. Set `SHARE_AI_WORKSPACE_MAX_PER_HOUR` to
  keep the previous limit. (#62)

### Fixed

- **AI chat: the desktop app no longer freezes at 100% CPU on long agent runs.**
  `useChat` re-rendered on every streamed token and `MessageItem`/`ReasoningBlock`
  re-parsed the whole transcript markdown (marked + DOMPurify) on every delta, so
  per-turn work grew quadratically and saturated the main thread. The stream is now
  throttled (`experimental_throttle`) to ~20 Hz and each finalized message row /
  markdown part / reasoning block is memoized, so a long turn no longer re-parses
  already-finished content. (#182)
- **Editor: caret/selection landed on the wrong line when clicking inside code
  blocks and footnotes.** The affected NodeViews rendered their non-editable
  chrome (language menu, footnotes heading, footnote number marker) before the
  editable content, so the browser's click hit-testing missed the contentDOM and
  snapped the caret to a previous node. Content now renders first in the DOM
  (chrome is lifted back into place via CSS flex `order`), and scroll containers
  are nudged after a paste to refresh stale hit-testing geometry. The caret
  symptom is macOS-specific and was confirmed manually on macOS; the automated
  guard pins the DOM-order invariant, not the caret behavior itself. (#146, #147)
- **AI chat: the live token counter now ticks between agent steps.** During a
  multi-step turn the header token badge (and the "Thinking… · N tokens" line)
  no longer froze on the previous step's authoritative usage; the current step's
  estimate is combined per-component with `max`, so the count rises smoothly and
  never jumps backwards. (#163)
- **AI chat: "New chat" during a streaming first turn now resets the whole
  chat, not just the role badge.** Starting a new chat mid-stream cleared the
  header but left the in-flight turn's messages behind, so the fresh chat opened
  pre-populated with the previous conversation; it now fully resets. (#161)
- **AI chat: a dropped tool argument now yields an actionable error.** When the
  model omitted a required parameter (typically `pageId`) in a parallel/batch
  tool call, the assistant forwarded zod's raw "expected string, received
  undefined" text; tool inputs now return a message naming each missing/invalid
  parameter (the JSON Schema contract is unchanged and nothing is backfilled).
  (#190)
- **Page move: cycle checks are now atomic and depth-bounded.** Moving a page
  under one of its own descendants is rejected in the same transaction as the
  update (closing a TOCTOU window where two concurrent A→B / B→A moves could
  form a cycle), and the recursive tree-traversal CTEs carry a cycle/depth guard
  so a pre-existing cycle can no longer spin a query. (#207)
- **Page/editor robustness batch.** Duplicating a page now copies shared
  attachments for every referencing page (not just the first); colliding block
  ids are de-duplicated on import/normalize so MCP addressed edits can't hit the
  wrong node; transient collab store failures are retried so autosave edits
  aren't lost; and an out-of-order tree move no longer drops the moved subtree.
  (#206)

### Security

- **Public share AI: per-workspace rolling-day token budget.** The anonymous
  share assistant now caps a workspace's actual token spend (input + output,
  summed across every accepted turn) over a trailing day, on top of the hourly
  request cap — so a caller who evades the per-IP throttle still cannot run up
  the owner's provider bill without bound. Cluster-wide via Redis and FAILS
  CLOSED if Redis is down; default 1,000,000 tokens/day, overridable via
  `SHARE_AI_WORKSPACE_TOKEN_BUDGET_PER_DAY`. (#159)

## [0.93.0] - 2026-06-21

This release builds on the 0.91.0 AI foundation: admin-defined AI agent roles,
an anonymous AI assistant on public shares, server-side voice dictation, an
editor footnotes model, live page-template embeds, and sandboxed arbitrary-HTML
embeds — plus a large batch of security hardening and test coverage.

### Breaking Changes

- **MCP shared-token auth moved to its own header.** The `/mcp` shared guard
  no longer reads `Authorization: Bearer <MCP_TOKEN>`; it now reads only the
  `X-MCP-Token` header. The `Authorization` header is now reserved for per-user
  HTTP Basic / Bearer access-JWT credentials, so each `/mcp` request
  authenticates as a specific user (the `MCP_DOCMOST_*` service account is only
  a fallback). Existing MCP clients (e.g. Claude Desktop) configured with
  `Authorization: Bearer <MCP_TOKEN>` must be reconfigured to send
  `X-MCP-Token: <MCP_TOKEN>` instead. See `MCP_TOKEN` in `.env.example`. As a
  one-time aid, the server logs a single migration warning when it sees the
  old-style header.

### Added

- **AI agent roles**: admin-defined assistant personas with an optional
  per-role model override, selectable in chat.
- **Anonymous AI assistant on public shares**: public-share visitors can chat
  with a selectable agent-role identity that reuses the internal chat
  presentation, with per-request output-token caps and a fail-closed Redis
  limiter.
- **Voice dictation (STT)**: server-side speech-to-text with a mic button in
  the chat and the editor, OpenRouter STT support, an endpoint test, and real
  provider-error surfacing.
- **Footnotes**: an editor footnotes model (inline references + a definitions
  list).
- **Page templates**: live whole-page embed (MVP) with a template-marker icon
  in the page tree and a working Refresh action.
- **Arbitrary HTML/CSS/JS embeds**: a sandboxed-iframe embed block gated by a
  per-workspace toggle (default OFF); insertable by any member when the toggle
  is on.
- Admin-only **"Analytics / tracker"** workspace setting: a raw HTML/JS snippet
  injected into the `<head>` of public share pages only (for analytics such as
  Google Analytics or Yandex.Metrika), kept separate from the member-facing
  HTML-embed feature.
- **MCP**: a hierarchical tree mode for `list_pages`, and per-user auth for the
  embedded `/mcp` endpoint.
- **Page tree**: Expand all / Collapse all for the space tree, and
  server-authoritative realtime tree updates.
- **AI chat UX**: a `get_current_page` tool for proxy-robust page context, a
  current-context-size readout, an agent step cap raised 8→20 with a forced
  final text answer, and auto-collapse of the chat window on page focus.
- **AI settings**: a Clear control inside the API-key field and an endpoint
  status dot bound to "configured × enabled".
- **Client**: an always-visible space grid replacing the space-switcher popover,
  removal of the sidebar Overview item, tighter comments-panel density, and no
  auto-open of the comments panel when adding a comment.

### Changed

- HTML embed blocks now render inside a sandboxed iframe (separate origin) and,
  when the workspace HTML-embed toggle is on, can be inserted by any member
  (previously admin-only). Turning the toggle off hides existing embeds and
  stops serving them on public share pages.
- Remove the server-side role-based stripping of HTML-embed blocks from the
  write paths (collab/REST/MCP, page create/duplicate, import, transclusion
  unsync); sandboxing makes per-write gating unnecessary. The only remaining
  server-side strip is the public-share read path, which still honors the
  workspace HTML-embed toggle.

### Fixed

- AI chat: preserve scroll position during streaming, record chats that fail on
  their first turn, and resolve the current page for agent context behind
  proxies.
- AI roles: guard `update()` against concurrent soft-delete; harden the model
  override, role-name uniqueness, and id validation; sandwich the safety
  framework around the role persona.
- Auth: handle null-password (SSO/LDAP-only) accounts without a bcrypt throw.
- Footnotes: survive duplicate-id definitions without collab divergence.
- HTML embed: fix stale iframe height and damp the resize loop; strip embeds at
  serve time on authenticated read paths and the plain page-create path.
- Page templates: import `ThrottleModule` so collab boots, never strand an
  in-flight page-embed id, and add defense-in-depth workspace checks.
- Pages: `movePage` cycle guard with no phantom `PAGE_MOVED` event.
- Import: surface the real error cause from `/pages/import` instead of a generic 400.

### Security

- MCP: close an SSO/MFA bypass on Basic auth and stop minting non-init sessions;
  close a brute-force limiter check-then-act race.
- Public share: block restricted descendants in the anonymous assistant, cap
  per-request output, fail closed when Redis is unavailable, and reject non-text
  message parts to close a size-cap bypass.
- Make `trustProxy` env-configurable with a safe default.

### Internal

- CI: gate the `develop` and release image builds on the test suite, run the
  suites on push/PR, and build the `:develop` image on push to `develop`.
- Docs: replace `CLAUDE.md` with `AGENTS.md` codifying the agent workflow and
  the release procedure, add migration-ordering guidance, and prune implemented
  plans.
- A large batch of new server/client test coverage.

## [0.91.0] - 2026-06-18

Gitmost is a community-focused fork of Docmost. This release drops the
Enterprise-Edition code paths and introduces the in-app AI agent chat, a RAG
knowledge layer, an embedded MCP server, and the Gitmost rebrand.

### Breaking Changes

- Remove all frontend Enterprise-Edition code — the project now builds as a pure
  community edition.
- AI agent: drop the `updateComment` tool from the agent toolset.

### Added

- **AI agent chat**: per-user in-app AI agent with a floating chat window.
  Includes live streaming responses, open-page context awareness, a typing
  indicator, a Stop control, and copy/export of a conversation as Markdown.
- **AI agent write tools & provenance**: reversible write tools (page
  create/update/move/soft-delete, comment reply/resolve) enforced by Docmost
  CASL, plus non-spoofable agent provenance signed into access/collab tokens and
  recorded on pages and comments. No permanent/force delete.
- **RAG knowledge retrieval**: workspace bulk reindex with a manual "Reindex
  now" action, hybrid RRF retrieval with heading-breadcrumb chunks and a merged
  search tool, dimension-agnostic embeddings, and RAG indexing coverage shown in
  AI settings.
- **MCP**: embedded community MCP server served at `/mcp`; an admin UI to
  list/add/edit/delete external MCP servers with per-server enable toggle, Test,
  write-only auth headers, a tool allowlist, and a Tavily preset; `insert_image`/
  `replace_image` can now fetch sources from web URLs.
- **AI configuration**: dedicated AI provider settings with separate base URL and
  API key for the chat vs. embedding model, and per-endpoint test buttons.
- **Branding**: Gitmost logo, favicon, and app name.
- **Collaboration**: comment resolution for the community build; agent edits are
  separated from human edits in page history.
- **Editor / client**: page-tree open/closed state is persisted per
  workspace+user; the brand logo shows the current `git describe` version.

### Changed

- Move AI settings to a dedicated `/settings/ai` page and redesign it with
  per-endpoint test buttons.
- `edit_page_text` now returns verifiable mutation results and refuses
  formatting-only edits; the agent tolerates Markdown in
  `edit_page_text`/`insert_node` locators.
- Compact large tool outputs before persisting them.
- Reduce the chat window corner radius, shrink the chat message font size, and
  shrink the default page-tree indentation from 16px to 8px.

### Fixed

- AI chat: stable streaming store id so optimistic and streamed messages render
  immediately; provider errors stay visible and surface the real provider
  status/message; the composer draft survives the new-chat id-adoption remount;
  the workspace AI-chat enable toggle is restored for self-hosted.
- AI providers: use OpenAI Chat Completions for multi-turn requests; self-heal
  the stored provider settings JSON; drop the hard output-token cap that
  truncated complex tool calls.
- RAG: make the indexer observable and bound hung embedding calls; stop the
  coverage bar from sticking below 100% on empty pages.
- Collaboration: use `-` instead of `:` in the agent page-history job id.
- Accessibility fixes (#2275) and table jitter on the edit/read toggle (#2252).

### Removed

- Non-functional DOCX / PDF / Confluence import buttons.

### Documentation

- README: rebrand to the Gitmost fork with EE-free positioning, an MCP
  comparison, a grouped roadmap, a Russian translation, a "Migration from
  Docmost" section, and AI agent chat documentation.
- Add plans for mobile app, voice dictation, arbitrary HTML/CSS/JS embeds, and
  offline sync & PWA.

### Internal

- Add `.claude/worktrees/` to `.gitignore`.
- CI: add a `develop` workflow with `workflow_dispatch`; ignore cache errors in
  the develop and release builds.
- Build: drop the private EE submodule, retarget CI to GHCR, and update the
  Docker image to the GHCR registry.

[Unreleased]: https://github.com/vvzvlad/gitmost/compare/v0.96.0...HEAD
[0.96.0]: https://github.com/vvzvlad/gitmost/compare/v0.94.0...v0.96.0
[0.94.0]: https://github.com/vvzvlad/gitmost/compare/v0.93.0...v0.94.0
[0.93.0]: https://github.com/vvzvlad/gitmost/compare/v0.91.0...v0.93.0
[0.91.0]: https://github.com/vvzvlad/gitmost/compare/v0.90.1...v0.91.0
