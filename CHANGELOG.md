# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Releases prior to `0.91.0` predate this changelog; see the
> [git tags](https://github.com/vvzvlad/gitmost/tags) for earlier history.

## [Unreleased]

### Added

- Space home pages, account-synced page pins, search by label with result paths, and starter templates for new notes.
- Import Confluence HTML archives, Word documents, and text-based PDFs. Export pages and spaces as DOCX or server-generated PDF.
- Search the text of PDF, DOCX, Markdown, and plain-text attachments within accessible pages.

### Fixed

- Registered audit services in the collaboration server so it can start.

### Changed

- Applied the DozoR-WIKI branding to application logos, browser metadata, and install icons.
- Rebuilt the document header, space tree, and page actions in light and dark mode with a blue accent.
- Kept page actions accessible on narrow screens and moved the connection status clear of document text.

## [1.0.1] - 2026-10-12

The 1.0.0 code with release images: the `v1.0.0` tag was pushed, but a failing integration test
stopped its images and GitHub release from being built. Use 1.0.1 for everything listed under 1.0.0.

### Fixed

- The share-search integration test no longer fails on the search query echoed in the response.

## [1.0.0] - 2026-10-12

Git sync: a space is mirrored to a git repository of Markdown files both ways, with a built-in
`git clone` / `push` host, and edits from both sides merge block by block. The modes 0.96.0 kept
behind switches are now the only ones: the wiki is always local-first and every AI-chat turn is a
detached server-side run. Search reports real matches and similar pages separately, so it can say
"not found". Large pages open and edit much faster. A release-wide review closed security and
stability issues in share search, collaboration access checks, share links, the AI chat and git sync.

### Added

- **Git sync: a space mirrored to a git repository of Markdown files, both ways.** Off by default:
  set `GIT_SYNC_ENABLED=true` and `GIT_SYNC_SERVICE_USER_ID` (the user git-made changes are
  attributed to; the server refuses to start without it), then turn on **Enable Git sync** in the
  space settings. Put `GIT_SYNC_DATA_DIR` on a persistent volume; the other `GIT_SYNC_*` options are
  in `.env.example`. With the flag off no route, timer or space switch is registered.
- **`git clone` / `fetch` / `push` a space over HTTP** at `/git/<space>.git`, with a Gitmost email
  and password (`GIT_SYNC_HTTP_ENABLED`, defaults to `GIT_SYNC_ENABLED`). Members who can read the
  space can fetch, pushing needs the right to edit its pages, a non-member gets a plain 404.
- **Git sync merges block by block.** In a block both sides changed, git wins and the wiki's text
  stays in page history. A push based on an older `main` is refused as non-fast-forward. Changes
  from git carry a "Git sync" badge in page history.
- **Git sync status for operators:** `POST /api/git-sync/status` (per-space health),
  `POST /api/git-sync/trigger` (admins; runs one cycle) and the metrics `git_sync_cycles_total{result}`,
  `git_sync_failing_spaces` and `git_sync_push_failing_spaces`.
- **Git sync limits.** A space with page-level restrictions cannot enable sync and is not served
  over `/git` (git cannot enforce them). A push is refused past its size and file-count budget
  (`.md` files are capped), `/git` answers 413 to an oversized request and 503 when too many git
  processes run; a cycle is stopped after 30 minutes, Markdown conversion runs in worker threads,
  and pages that fail to export are counted in the space status instead of only logged.
- **A stalled or disconnected `git` client cannot hold the space lock**: the `git http-backend`
  process and its children are killed as a group. A server error on `/git` answers 500 instead of
  401, so git does not drop the saved password.
- **Recently opened pages stay warm.** Up to five pages left in the last five minutes keep their
  collaboration session, so going back shows an editable body at once. The collab server re-checks
  page access whenever a connected client re-sends its token and closes the page if it was revoked.
- **Workspace setting "Sidebar quick actions"** (Workspace settings → General, `treeQuickActions`,
  default on) hides the copy-link and trash icons on page-tree rows; the row menu keeps both.
- **"Source code" link in the user menu** (AGPL-3.0 §13).
- `CONTRIBUTING.md`, and `packages/mcp/LICENSE` with the MIT licence of the upstream MCP server it
  was forked from.
- **"Similar pages" on public share search**, and semantic neighbours in the share assistant's search
  tool, as in the main search.

### Changed

- **Local-first is the only mode.** Page chrome, tree and body paint from the local cache and
  replica, the app shell does not wait for `/me`, an unreachable server shows the read-only offline
  view and offline-critical requests time out after 15 s — always (`LOCAL_FIRST_ENABLED` is removed).
- **Every agent run is detached.** A browser disconnect never stops a run (except a new chat left
  before its first frame), Stop always asks the server and "send now" is always available; the
  admin toggle and `AI_CHAT_RESUMABLE_STREAM` are removed.
- **A dropped AI-chat connection follows the run through the delta poll** instead of re-attaching
  on a 1–16 s backoff ladder. A reloaded tab still live-follows the run; the banner reads
  "Connection lost — following the answer…" with no counter or Retry.
- **Search says "not found".** `total`, `items` and paging count lexical matches only (semantic
  search still re-ranks them), so a query matching nothing returns `total: 0` instead of 50
  arbitrary pages. Up to five semantic neighbours come back separately as `related` — "Similar pages"
  in the web UI and a new field in the MCP `search` result.
- **The agent's `searchPages` runs the web search** with the user's permissions and returns
  `{ results, related, total }`, so it can learn that a page does not exist; it accepts `"phrase"`,
  `+required` and `-excluded`.
- **Imported Markdown gets the editor's attribute shapes.** The converter's schema is built from
  editor-ext's `documentExtensions`, so imports carry numeric media sizes, `internal=false` on links,
  indent 0 and YouTube start 0; an image `title` and a YouTube `align` are dropped on import.
- **Large pages open much faster:** main-thread blocking on a ~400K-character page fell from ~5.9 s
  to ~1.4 s (links are plain DOM with one shared popover, each editor builds its document once,
  repeated full re-renders are gone).
- **Typing in large pages is faster:** heading link buttons, code highlighting and table header
  pinning rebuild only what changed (one keystroke in a code block of a 2000-block page cost 0.75 s).
- **Opening a page syncs only the difference:** the collab provider attaches after the local copy
  has loaded, instead of exchanging the whole document both ways (1.4 MB each way on big pages).
- **Git sync vaults made by earlier builds are upgraded once on first run:** the vault becomes a
  bare repository, the `docmost` branch and `refs/docmost/{pulling,recording,last-pushed}` are
  deleted and `refs/docmost/last-export` is added. The old working-tree files stay on disk and can
  be deleted by hand.
- **The Docker image runs `tini` as PID 1**, so orphaned child processes such as `git` are reaped
  instead of piling up as zombies.

### Removed

- `LOCAL_FIRST_ENABLED`: local-first is always on.
- `AI_CHAT_RESUMABLE_STREAM`, the workspace setting `settings.ai.autonomousRuns` and its toggle in AI
  settings; stored values are ignored.
- `GIT_SYNC_REMOTE_TEMPLATE`; the engine never read it.
- The git-sync space setting **Auto-merge conflicts on push** (`autoMergeConflicts`): pushes with
  conflict markers are no longer held back.
- `SEARCH_DRIVER` and `TYPESENSE_*`, with the Typesense routing and dependency: it was EE code this
  fork does not ship, and `SEARCH_DRIVER=typesense` broke every web, MCP and share search. A leftover
  value is ignored.
- Column `page_embeddings.fts` and its GIN index (migration `20261011T120000`; `down()` restores them).

### Fixed

- **Bold, italic and strikethrough survive a Markdown round trip** when the marked text starts or
  ends with a space (`**Model: **`) or its edge punctuation touches a word (`**x:**A`); the mark used
  to be lost and literal `**` written into the text (updatePageMarkdown, export, git sync, paste).
- **The agent keeps the tools it activated in the previous turn**: the activation is saved before
  the turn ends, so a turn started right after no longer starts from an empty set.
- **A new chat stopped (or disconnected) before its first reply stops its run**; the run used to
  keep going server-side.
- **The public-share assistant stops when the visitor leaves** instead of finishing the turn and
  spending provider tokens.
- **A client that leaves before the stream starts no longer leaks memory**: the SSE heartbeat kept
  the closed response and its buffered frames alive for the life of the process.
- **Pages with more than 32 chunks are indexed for semantic search**: embeddings go in requests of at
  most 32 values (TEI rejects more), each with its own `AI_EMBEDDING_TIMEOUT_MS`, and chunking no
  longer blocks the server (32 s on a 9000-block page).
- **Sidebar titles are no longer cut short** by the hidden quick-action icons of idle rows.
- **Closed editors are no longer kept in memory** by their Y.Doc (yjs 13.6.33).
- **A page without local persistence switches from the read-only copy to the live editor**; it used
  to stay read-only.
- **Links on public share pages use the share-relative address again**, and a link's stored `class`,
  `rel`, `target` and `title` no longer reach the DOM; "Copy link" cannot turn into another host.
- **The public-share token budget counts every completed step**, so a turn the visitor left is still
  charged for the steps the provider already billed.
- **A Stop after the first AI-chat step ends the turn once, as aborted**, not also as completed; the
  turn-end writes finish before the run is settled and the MCP leases are released.
- **A run-stream reader that stops reading no longer pins server memory**: the attach replay is torn
  down after 30 s and the client falls back to the delta poll.
- **Pages of more than ~5,400 chunks are indexed for semantic search**; the embedding write no
  longer fails on Postgres's parameter limit after all the work was done.
- **A stale tab can no longer open collaboration sessions with the previous user's token** after a
  user switch in another tab, and a warm page stays read-only until its edit rights are confirmed.
- **A failing AI-chat delta poll is shown**: when the poll that follows a dropped run keeps failing,
  the chat says it cannot reach the server, with the reason, instead of waiting silently.

### Security

- **Public share search no longer returns drafts**: a share that publishes only saved versions
  answers search with an empty result and a `disabledReason`; search is refused when sharing is off.
- **Share search result paths stop at the share root**, so no title above the share reaches an
  anonymous reader.
- **Collaboration access re-checks are rate-limited per connection and fail closed** on an
  infrastructure error; a re-sent token of a different user is rejected.
- **Losing access through a group, space or workspace change closes the pages the user has open**
  in the editor (in every collaboration process), instead of leaving them editable until reconnect.
- **Imported Markdown can no longer stall the server**: regular expressions that backtracked
  quadratically on long whitespace runs were replaced with linear scans.

## [0.96.0] - 2026-09-21

An opt-in local-first mode (`LOCAL_FIRST_ENABLED`, off by default): page chrome and body paint from
a local cache and the local replica, an unreachable server degrades to a read-only offline view, and
cached content expires after `OFFLINE_GRACE`. AI chat gains opt-in detached runs, a server-side
"interrupt and send now", personal external MCP servers and an importable agent-roles catalog. The
MCP surface is reworked: camelCase tool names, api_key-only authentication, Markdown from `getNode`,
read-your-own-writes and a `baseHash` write guard. The editor adds image rows and captions, a
spoiler mark and saved versions (`Cmd/Ctrl+S`), and Safari no longer burns 100% CPU on tables.

### Breaking Changes

- **MCP `updatePageJson` / `updatePageMarkdown` require a `baseHash`.** `getPage` / `getPageJson`
  return it; a write whose hash no longer matches the live document gets `409` with `currentHash` and
  writes nothing, an unreachable live document gets `503`. *Migration:* pass `baseHash` on every call
  that supplies `content` (a title-only update needs none). REST `/pages/update` keeps it optional.
- **`/mcp` authenticates only with `Authorization: Bearer <api_key>`** (Workspace settings → API keys).
  HTTP Basic `email:password`, session access tokens and the `MCP_DOCMOST_EMAIL` /
  `MCP_DOCMOST_PASSWORD` service account are removed. *Migration:* switch every client to an api_key
  before deploying and drop those two env vars; `MCP_DOCMOST_API_URL` and `MCP_TOKEN` are unchanged.
- **External MCP tool names are camelCase.** Every snake_case tool is renamed (`get_node` →
  `getNode`, `edit_page_text` → `editPageText`); `search` keeps its name. *Migration:* update
  allowlists (`mcp__gitmost-*__getNode`), prompts, `.mcp.json` filters and dashboards grouped by `tool`.
- **External MCP: `importPageMarkdown` removed, `updatePageMarkdown` added** (`{pageId, content,
  title?}`, a full-body replace from Markdown with `^[...]` footnotes). *Migration:* call
  `updatePageMarkdown`; re-importing an exported Docmost-Markdown file is no longer offered over
  `/mcp` (`exportPageMarkdown` stays).
- **`getNode` returns Markdown by default** (`format: "markdown"`, `markdown`); pass `format: "json"`
  for the old `node`. `patchNode` / `insertNode` accept `markdown` (several blocks) besides `node`.
- **`/metrics` binds to `127.0.0.1` by default.** *Migration:* a scraper in another container needs
  `METRICS_BIND=0.0.0.0` plus `METRICS_TOKEN` and a matching Bearer token, or metrics go dark silently.

### Added

- **Personal external MCP servers** (Settings → Account → MCP servers): the agent gets the admin
  servers plus the user's own; headers are write-only and encrypted, URLs pass the SSRF guard.
  `MCP_PERSONAL_SERVERS_ENABLED` (default on) and `MCP_PERSONAL_SERVERS_MAX` (default 10); connect
  failures are reported and counted in `ai_external_mcp_connect_failures_total{level}`. Migration
  `20260719T120000` adds a nullable `ai_mcp_servers.user_id`.
- **MCP structural reads see your own writes:** `getOutline`, `getNode`, `searchInPage` and `tableGet`
  read the live document shortly after a write, with a freshness marker (`mcp_ryow_*_total` metrics).
- **`searchInPage` literal mode matches through invisible characters** (soft hyphens, zero-width,
  NBSP family, whitespace runs, case); `folded: true` marks such hits. Regex mode is unchanged.
- **The right panel and the AI-chat window keep their state across a reload** (open, position, tab,
  window geometry clamped to the viewport); drafts, the active chat and scroll do not.
- **The Lucide icon picker offers the whole catalog** (1746 icons), virtualized and searchable by
  tags, aliases and Russian words; it loads lazily and offers Retry if the chunk fails.
- **Copy-link and trash icons on page-tree rows**, the same actions as the row menu.
- **More client telemetry:** `operation_ms{op}` for 14 heavy operations, `editor_key_latency_ms`,
  `page_open_body_ms` with `body_paint_timeout`; on the server `ai_chat_bind_skipped_total{reason}`.
- **The app shell paints from the persisted user** instead of waiting for `/me` (`LOCAL_FIRST_ENABLED`).
- **Offline is not an error** (`LOCAL_FIRST_ENABLED`): an unreachable server shows the cached chrome
  and a read-only body with an "offline" banner; a `5xx` still shows an error; offline-critical
  requests time out after 15 s.
- **Locally cached content expires** after `OFFLINE_GRACE` (default `JWT_TOKEN_EXPIRES_IN`) without a
  successful `/me`; pages that answered 403/404 are tombstoned, and the denylist fails closed.
- **`editPageText` and comment anchoring match across invisible characters** (a `fold` tier); each
  match reports `matchedVia`, and a miss says why.
- **Excalidraw diagrams reach external publications**: a PNG `data-raster` is embedded on save
  (`EXCALIDRAW_RASTER_ENABLED`, default off); `stashPage` and `viewImage` fall back to the SVG.
- **Page icons and agent-role glyphs are Lucide icons** with a colour palette, stored as JSON in
  `pages.icon` / `ai_agent_roles.emoji`; a migration clears the old emoji values (default icon shown).
- **draw.io diagrams reach external publications as a raster**: the editor embeds the rendered PNG in
  the `.drawio.svg` on save (`DRAWIO_RASTER_ENABLED`, default off), used by `stashPage`, `viewImage`
  and `drawioGet`; a diagram without one fails with an explicit message.
- **Page chrome paints from a local metadata cache** (`LOCAL_FIRST_ENABLED`); edit rights wait for
  the server.
- **The page body paints from the local collab replica** (`LOCAL_FIRST_ENABLED`), read-only until the
  server confirms the sync.
- **Changing the embedding model no longer empties semantic search:** a new index generation is built
  while the old one serves and switched in only when complete; search reports `off` / `stale` /
  `full` and falls back to lexical search on a model mismatch.
- **A drifted comment suggestion can be re-synced** against the live text instead of failing with 409.
- **Saved page versions:** `Cmd/Ctrl+S` or the page menu; history marks saved and agent versions,
  dims autosaves and filters "Only versions".
- **Open tabs pick up a new deploy:** the server announces its version over the socket and the tab
  shows "A new version is available", reloading at the next navigation.
- **Images side by side** ("Inline (side by side)" alignment, `data-align` in Markdown).
- **Image captions** (`data-caption` in Markdown).
- **New note and new temporary note buttons** on Home and the space overview.
- **"Send now" for a queued AI-chat message** interrupts the agent and keeps its partial answer.
- **Importable multilingual agent-roles catalog:** admins browse bundles, import roles and update them
  from the catalog. The source is `AI_AGENT_ROLES_CATALOG_URL` (a default is baked in at build).
- **MCP `insertFootnote`** (the agent gives anchor and content, the server numbers it) and server-side
  footnote canonicalization on every full-document write path.
- **Detached agent runs behind `settings.ai.autonomousRuns`** (default off): a run in `ai_chat_runs`
  survives a disconnect, `POST /ai-chat/run` re-attaches and `POST /ai-chat/stop` stops it. Single
  instance only (warning on a scaled deployment).
- **Server-side "interrupt and send now":** `POST /ai-chat/stream` takes `supersede: { runId }`, with
  `SUPERSEDE_INVALID`, `SUPERSEDE_TARGET_MISMATCH` and `SUPERSEDE_TIMEOUT` (`AI_CHAT_SUPERSEDE_TIMEOUT_MS`).
- **MCP `stashPage`:** a whole page as a short-lived in-RAM blob at the anonymous `GET /api/sb/:id`
  (`SANDBOX_*` env vars).
- **Spoiler mark** (`||text||` or the bubble menu), blurred until clicked.
- **Dock the AI-chat window into the sidebar.**
- **Hovering commented text shows the thread in a tooltip.**
- **"Move to trash" in the temporary-note banner.**
- **Code-block controls float in the corner** and appear on hover.
- **The agent is told about your page edits between turns** (a size-capped diff).
- **Stress-accent button (U+0301)** in the bubble menu.
- **Reading position survives a reload** (per tab); a URL `#hash` wins.
- **The slash menu finds commands typed in the wrong keyboard layout** (ЙЦУКЕН ↔ QWERTY).
- **Substring "lookup" search for agents:** `/api/search` with `substring` matches literal tokens
  (`10.0.12.5`, `WB-MGE-30D86B`) and returns `path`, `snippet`, `score`; the web UI is unchanged.
- **MCP `search` results** carry `pageId` (was `id`), `path`, `snippet` and `score`, and drop `spaceId`,
  `rank` and `highlight`.
- **Custom pretty-links for shared pages (`/l/:alias`)**, a `302` to the share page; an unknown alias
  serves the plain app, so names do not leak. New table `share_aliases`.
- **Temporary notes** move to Trash after a workspace lifetime (default 24 h); the deadline is fixed at
  creation and the banner offers "Make permanent".
- **Generate a page title from its content** (sparkles button; needs `settings.ai.generative`).
- **The header AI-chat button opens the latest chat of the current page**, or a new one.

### Changed

- **The page → chat binding follows the chat you open:** selecting a chat binds it to the page and
  "New chat" clears it. Migration `20260716T130000` creates `ai_chat_page_bindings` and backfills it.
- **AI chat sends the model the full stored transcript** instead of the last 50 rows.
- **Bigger page icons in the sidebar tree** (20/24 px by density) with stronger colour.
- **MCP tool descriptions no longer promise block ids** on nodes that have none (text only).
- **The MCP verify diff uses the editor's algorithm** (1.5–5× faster) and its byte cap drops from
  12 KiB to 4 KiB to hold ~200 ms; byte-heavy pages get the block diff unless `MCP_DIFF_MAX_BYTES` is raised.
- **One run per chat in both modes:** a second concurrent turn gets `409 A_RUN_ALREADY_ACTIVE`;
  `autonomousRuns` now only decides whether a disconnect stops the run.
- **Documented the upstream and alignment plan for the local `ai@6.0.134` patch** (no runtime change).
- **Client Markdown paste, copy and AI-chat rendering use `@docmost/prosemirror-markdown`**; pasted
  canonical Markdown gives the same nodes as a server import.
- **A new public share no longer includes sub-pages** unless "Include sub-pages" is turned on.
- **The agent-roles catalog is YAML** (`index.yaml`, `bundles/<id>/<lang>.yaml`); the
  `AI_AGENT_ROLES_CATALOG_URL` contract is unchanged.

### Fixed

- **Safari no longer burns 100% CPU on a page with tables**, and pinned table headers pin.
- **A failed image, video or diagram stops pulsing and is clickable**; node views no longer leak
  listeners (typing slowed over a session), and collab reconnects back off.
- **Read-only table headers get their sort chevron back**; a nested table no longer takes the outer
  table's sort state.
- **Opening a page no longer leaks a timer** or polls for a missing scroll target.
- **The local editor cache is per workspace and user** (it was shared between users of one device)
  and is purged on logout or sign-in as someone else.
- **`editPageText` refuses a `replace` with Markdown markers**, which used to write literal asterisks.
- **Copying part of a table puts plain text, not GFM table syntax, on the clipboard.**
- **`/.well-known/*` returns a JSON 404 instead of the app, and a `/mcp` 401 says how to
  authenticate** (OAuth is not supported; `WWW-Authenticate` is exposed to CORS):

  ```
  WWW-Authenticate: Bearer realm="mcp", error="invalid_token", error_description="MCP requires a Bearer api_key token (Authorization: Bearer <api_key>)."
  ```

  With `MCP_TOKEN` set, a missing or wrong `X-MCP-Token` gets:

  ```
  WWW-Authenticate: Bearer realm="mcp", error="invalid_token", error_description="MCP requires the shared secret in the X-MCP-Token header (X-MCP-Token: <MCP_TOKEN>) plus a Bearer api_key token (Authorization: Bearer <api_key>)."
  ```

  `error="invalid_token"` appears only when that credential was sent.
- **CI type-checks the client** (`pnpm --filter client typecheck`).
- **A public share no longer serves an attachment of a trashed page.**
- **The MCP integrity guard names a lost attachment, media, embed, math, page embed or transclusion
  node**, each as its own kind.
- **The MCP integrity guard names a lost draw.io or Excalidraw diagram.**
- **MCP writes no longer report false failures that provoke duplicates:** `drawioCreate` into a nested
  block succeeds with `nodeId: null`, a write evicted from the session cache is reported as indeterminate.
- **A long AI chat no longer breaks on the context window:** tool outputs are stored once, the replayed
  history has a token budget (0.7 × the context window, 100k without one), and an overflow makes the
  next turn trim harder.
- **Non-ASCII draw.io labels no longer turn into mojibake** in the draw.io editor; diagrams the editor
  already saved corrupted stay so.
- **One malformed message part no longer breaks a chat**; incoming parts are limited to `text`, and a
  failed send no longer duplicates the message.
- **A transport drop to an external MCP server heals within the turn** for read-only tools;
  `AI_MCP_SSE_BODY_TIMEOUT_MS` (default 10 min).
- **Comment-suggestion decisions are written to the `audit` table.**
- **Applying a comment suggestion keeps the text's formatting.**
- **Markdown round trips keep lines that start with a block marker** (`#`, `>`, `-`, `|`, `---`, …).
- **The server no longer runs out of heap on long agent runs** (pnpm patch on `ai@6.0.134`).
- **A mid-run client disconnect no longer leaks a stream pipe** (the same patch).
- **A failed run start returns `503 A_RUN_BEGIN_FAILED`** instead of leaving an unstoppable run.
- **A pathological draw.io graph can no longer block the server** (ELK layout in a worker thread).
- **The `/health` Redis probe no longer leaks a client per tick** while Redis is down.
- **Internal links in exported Markdown keep their text.**
- **Deep pages no longer show an empty breadcrumb** while the tree loads.
- **Pasted GitHub-style callouts (`> [!NOTE]`) become callouts.**
- **The editor stays read-only until collaboration has synced** ("Connecting… (read-only)").
- **A shared page keeps exactly one custom address.** Migration `20260627T120000` irreversibly deletes
  duplicate alias rows, so old duplicate `/l/<old>` links return 404.
- **An address used by another page is offered as a move** ("Saving will move it to this page").
- **A non-empty page can no longer be wiped by a momentarily empty live document.**
- **Ctrl+Z works right after using a table menu.**
- **The AI reindex progress counter no longer freezes at 0.**
- **An MCP edit can no longer be lost to a second collab document** opened by slugId.

### Security

- **An external MCP server whose stored headers cannot be decrypted is skipped**, not connected without
  them (e.g. after an `APP_SECRET` rotation).
- **The anonymous share payload (`/shares/page-info`) is limited to the fields the renderer needs.**
- **A forged or mismatched share id can no longer render a page by its slug.**
- **An empty MCP tool allowlist `[]` now denies every tool** (it allowed all); a corrupt value fails
  closed and NULL means unrestricted. Check servers stored with a literal `[]`.
- **Tool and provider errors no longer reach anonymous public-share chat readers.**
- **`/metrics` can require `METRICS_TOKEN`** (Bearer) and binds to loopback by default.

## [0.94.0] - 2026-06-26

AI chat becomes durable and fast: assistant turns are persisted step by step and exported
server-side, the desktop app no longer freezes on long agent runs, and MCP writes are badged with
AI attribution. Footnotes get Pandoc-style reuse and back-links, page moves are hardened against
cycles, and the anonymous share assistant gets a daily token budget.

### Added

- **Persistent AI-chat history:** an assistant turn is saved step by step (`streaming` → `completed`
  / `error` / `aborted`), a startup sweep settles dangling rows, and Copy exports server-side.
- **AI attribution for MCP writes** from an account flagged `users.is_agent = true` (set by SQL, only
  on a dedicated account).
- **Footnote import diagnostics:** MCP page writes return `footnoteWarnings`.
- **AI chat "Protocol" setting (`chatApiStyle`):** `openai-compatible` (streams reasoning) or `openai`.
- **Per-MCP-server instructions** injected into the agent prompt.
- **Footnote multi-backlinks** (↩ a b c).

### Changed

- **The default chat provider is openai-compatible**; real OpenAI behind a custom URL should set the
  Protocol to `openai`.
- **Repeated `[^a]` references are one footnote** (Pandoc); duplicate definitions are first-wins.
- **The public-share assistant's default hourly cap per workspace drops from 300 to 100**; set
  `SHARE_AI_WORKSPACE_MAX_PER_HOUR` to keep the old limit.

### Fixed

- **The desktop app no longer freezes at 100% CPU on long agent runs.**
- **The caret no longer lands on the wrong line when clicking in code blocks and footnotes** (macOS).
- **The live token counter ticks between agent steps.**
- **"New chat" during a streaming first turn resets the whole chat.**
- **A dropped tool argument yields an error naming the parameter.**
- **Page-move cycle checks are atomic and depth-bounded.**
- **Page duplication, block ids and tree moves:** shared attachments are copied for every page,
  colliding block ids are de-duplicated, collab store failures are retried, out-of-order moves keep
  the subtree.

### Security

- **Per-workspace daily token budget for the public-share assistant** (default 1,000,000,
  `SHARE_AI_WORKSPACE_TOKEN_BUDGET_PER_DAY`); it fails closed without Redis.

## [0.93.0] - 2026-06-21

Admin-defined AI agent roles, an anonymous AI assistant on public shares, server-side voice
dictation, editor footnotes, live page-template embeds and sandboxed HTML embeds, plus security
hardening.

### Breaking Changes

- **The MCP shared token moved to its own header:** `/mcp` reads `X-MCP-Token`, no longer
  `Authorization: Bearer <MCP_TOKEN>`. Reconfigure clients to send `X-MCP-Token: <MCP_TOKEN>`.

### Added

- **AI agent roles:** admin-defined personas with an optional model override.
- **Anonymous AI assistant on public shares**, with output-token caps and a fail-closed Redis limiter.
- **Voice dictation** in the chat and the editor (server-side STT, OpenRouter supported).
- **Footnotes** in the editor.
- **Page templates:** live whole-page embeds.
- **Sandboxed HTML/CSS/JS embeds** behind a workspace toggle (default off).
- **"Analytics / tracker" setting:** an admin HTML/JS snippet injected into public share pages.
- **MCP:** a tree mode for `list_pages` and per-user auth on `/mcp`.
- **Page tree:** Expand all / Collapse all and realtime updates.
- **AI chat:** a `get_current_page` tool, a context-size readout and a step cap of 20.
- **AI settings:** a Clear control for the API key and an endpoint status dot.
- **Client:** an always-visible space grid replaces the space switcher, the sidebar Overview item is
  gone, and the comments panel is denser and no longer opens by itself when a comment is added.

### Changed

- **HTML embeds render in a sandboxed iframe** and any member can insert them when the toggle is on;
  turning it off hides existing embeds.
- **Write paths no longer strip HTML embeds by role**; only the public share read path honours the toggle.

### Fixed

- AI chat: scroll position while streaming, chats that fail on their first turn, current page behind
  proxies.
- AI roles: concurrent soft-delete, model override, name uniqueness and id validation.
- Auth: SSO/LDAP-only accounts without a password.
- Footnotes: duplicate-id definitions no longer diverge in collaboration.
- HTML embed: stale iframe height and resize loop; embeds stripped at serve time where required.
- Page templates: collab boot, stranded embed ids, workspace checks.
- Pages: `movePage` cycle guard.
- Import: `/pages/import` reports the real error.

### Security

- MCP: SSO/MFA bypass on Basic auth closed; brute-force limiter race closed.
- Public share: restricted descendants blocked in the assistant, output capped, fails closed without
  Redis, non-text message parts rejected.
- `trustProxy` is configurable with a safe default.

### Internal

- CI gates the `develop` and release images on the test suite.
- `AGENTS.md` replaces `CLAUDE.md`.

## [0.91.0] - 2026-06-18

Gitmost, a community fork of Docmost: the Enterprise-Edition code is dropped, and the release adds
the in-app AI agent chat, a RAG knowledge layer, an embedded MCP server and the Gitmost brand.

### Breaking Changes

- All Enterprise-Edition frontend code is removed; the project builds as a pure community edition.
- AI agent: the `updateComment` tool is removed from the agent toolset.

### Added

- **AI agent chat:** a per-user floating chat with streaming, open-page context, Stop and Markdown export.
- **AI agent write tools:** reversible page and comment operations under CASL, with agent provenance
  on pages and comments; no permanent delete.
- **RAG retrieval:** bulk reindex ("Reindex now"), hybrid retrieval and coverage in AI settings.
- **MCP:** the embedded server at `/mcp`, an admin UI for external MCP servers (toggle, Test,
  write-only headers, tool allowlist, Tavily preset), and web URLs for `insert_image`/`replace_image`.
- **AI configuration:** separate base URL and API key for chat and embeddings, with test buttons.
- **Branding:** Gitmost logo, favicon and name.
- **Collaboration:** comment resolution; agent edits separated from human edits in page history.
- **Client:** page-tree state persisted per workspace and user; the logo shows the `git describe` version.

### Changed

- AI settings move to `/settings/ai`.
- `edit_page_text` returns verifiable results and refuses formatting-only edits.
- Large tool outputs are compacted before they are stored.
- Smaller chat corner radius and font; page-tree indentation 16px → 8px.

### Fixed

- AI chat: optimistic and streamed messages render at once, provider errors stay visible, the draft
  survives a new chat, the AI-chat toggle is back for self-hosted.
- AI providers: Chat Completions for multi-turn requests, self-healing settings, no hard output cap.
- RAG: observable indexer, bounded embedding calls, coverage reaches 100%.
- Collaboration: agent page-history job ids use `-` instead of `:`.
- Accessibility fixes and table jitter on the edit/read toggle.

### Removed

- The non-functional DOCX / PDF / Confluence import buttons.

### Documentation

- README: the Gitmost fork, an MCP comparison, a roadmap, a Russian translation, migration from
  Docmost and AI chat docs.

### Internal

- CI builds to GHCR; the private EE submodule is dropped.

[Unreleased]: https://github.com/vvzvlad/gitmost/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/vvzvlad/gitmost/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/vvzvlad/gitmost/compare/v0.96.0...v1.0.0
[0.96.0]: https://github.com/vvzvlad/gitmost/compare/v0.94.0...v0.96.0
[0.94.0]: https://github.com/vvzvlad/gitmost/compare/v0.93.0...v0.94.0
[0.93.0]: https://github.com/vvzvlad/gitmost/compare/v0.91.0...v0.93.0
[0.91.0]: https://github.com/vvzvlad/gitmost/compare/v0.90.1...v0.91.0
