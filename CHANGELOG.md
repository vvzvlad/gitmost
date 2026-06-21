# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Releases prior to `0.91.0` predate this changelog; see the
> [git tags](https://github.com/vvzvlad/gitmost/tags) for earlier history.

## [Unreleased]

### Added

- Admin-only "Analytics / tracker" workspace setting: a raw HTML/JS snippet
  injected into the `<head>` of public share pages only (for analytics such as
  Google Analytics or Yandex.Metrika).

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

### Breaking Changes

- **MCP shared-token auth moved to its own header.** The `/mcp` shared guard
  no longer reads `Authorization: Bearer <MCP_TOKEN>`; it now reads only the
  `X-MCP-Token` header. Existing MCP clients (e.g. Claude Desktop) configured
  with `Authorization: Bearer <MCP_TOKEN>` must be reconfigured to send
  `X-MCP-Token: <MCP_TOKEN>` instead. The `Authorization` header is now
  reserved for per-user HTTP Basic / Bearer access JWT credentials. See
  `MCP_TOKEN` in `.env.example`. As a one-time aid, the server logs a single
  migration warning when it sees the old-style header.

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

[Unreleased]: https://github.com/vvzvlad/gitmost/compare/v0.91.0...HEAD
[0.91.0]: https://github.com/vvzvlad/gitmost/compare/v0.90.1...v0.91.0
