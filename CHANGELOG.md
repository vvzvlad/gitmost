# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Releases prior to `0.91.0` predate this changelog; see the
> [git tags](https://github.com/vvzvlad/gitmost/tags) for earlier history.

## [Unreleased]

### Changed

- **Public share AI: default per-workspace hourly assistant cap lowered
  300 → 100.** The limiter falls back to this default whenever
  `SHARE_AI_WORKSPACE_MAX_PER_HOUR` is unset, so a `0.93.0` deployment that
  never set the env var has its anonymous public-share assistant hourly cap
  cut from 300 to 100 on upgrade. Set `SHARE_AI_WORKSPACE_MAX_PER_HOUR` to
  keep the previous limit. (#62)

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
- Import: surface the real error cause from `/pages/import` instead of a generic
  400.

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
