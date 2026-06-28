# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Releases prior to `0.91.0` predate this changelog; see the
> [git tags](https://github.com/vvzvlad/gitmost/tags) for earlier history.

## [Unreleased]

### Added

- **Editable captions for images.** Images gain an optional caption shown
  below them, edited inline from the image bubble menu stored as a `caption` attribute. Captions round-trip
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

### Changed

- **Enabling a public share no longer auto-shares the whole sub-tree.** Turning
  a page "Shared to web" now defaults to the page alone; descendant pages become
  public only when you explicitly turn on the dedicated "Include sub-pages"
  toggle. Previously the create call defaulted to including sub-pages, silently
  exposing every child of a freshly shared page. (#216)

### Fixed

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

### Security

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

[Unreleased]: https://github.com/vvzvlad/gitmost/compare/v0.93.0...HEAD
[0.93.0]: https://github.com/vvzvlad/gitmost/compare/v0.91.0...v0.93.0
[0.91.0]: https://github.com/vvzvlad/gitmost/compare/v0.90.1...v0.91.0
