<div align="center">
    <h1><b>Gitmost</b></h1>
    <p>
        Open-source collaborative wiki and documentation software.
        <br />
        A fully-open community fork of <a href="https://github.com/docmost/docmost">Docmost</a>.
    </p>
</div>
<br />

**English** · [Русский](README.ru.md)

## About this fork

**Gitmost** is a community fork of [Docmost](https://github.com/docmost/docmost), an open-source
collaborative wiki and documentation app.

The goal of the fork is a **100% open, AGPL-only build with no Enterprise-Edition (EE) code**:

- **No EE code at all.** All proprietary Enterprise-Edition sources were removed — the private
  `apps/server/src/ee` submodule, the `apps/client/src/ee` directory (201 files) and the
  `packages/ee` package are gone. There is no license gating: every feature is available to everyone.
- **Replacements are written from scratch.** Features that previously lived behind the enterprise
  license (e.g. comment resolution, the `/mcp` server) were re-implemented from scratch on top of the
  community codebase. No EE code is reused, and there is no entitlement/feature-flag wall.
- **No upsell.** There are no "buy a license" / "upgrade to Enterprise" banners, trial nags, or
  locked-feature placeholders anywhere in the UI.
- Authentication is plain email + password (no SSO/LDAP/cloud/billing flows).

## What's different from Docmost

| Change | Details |
| --- | --- |
| **EE code removed** | Stripped all client and server Enterprise-Edition code; ships as a clean community/AGPL build with no license checks. |
| **Comment resolution** | Re-implemented from scratch as a community feature (resolve / re-open with Open/Resolved tabs). No EE code reused, available to anyone who can comment. |
| **Embedded MCP server** | A community MCP server (`@docmost/mcp`, 38 tools) is served over HTTP at `/mcp` — no enterprise license required. Replaces the removed license-gated EE MCP. |
| **Rebranding** | App logo / name changed from *Docmost* to *Gitmost*. |
| **Compact page tree** | Default page-tree indentation reduced from 16px to 8px per nesting level. |
| **CI / images** | Release CI publishes container images to GHCR (`ghcr.io/vvzvlad/gitmost`) using the built-in `GITHUB_TOKEN` instead of Docker Hub. |

### Embedded MCP server

Gitmost has **our own MCP server** — [docmost-mcp](https://github.com/vvzvlad/docmost-mcp),
which we wrote — **built directly into the app** and served at `/mcp`. It exposes **38
agent-native tools**: surgical per-block edits (patch / insert / delete by id),
structure-preserving find/replace, scripted `(doc) => doc` transforms with a dry-run diff,
structured table editing, version history with diff / restore, comments, images and share
links — all applied through Docmost's real-time-collaboration layer, so a write never
clobbers a concurrent human edit.

**Better than Docmost's own MCP.** Docmost's built-in MCP is an enterprise feature, and its
tools are coarse — read a page as Markdown, create / move / delete pages, replace a whole
page. Ours is built around how an agent actually edits: address one block and patch it, or
*program* the change, instead of round-tripping a ~100 KB document through the model on
every little fix. And it needs no enterprise license.

| | **Gitmost `/mcp` (our docmost-mcp)** | Docmost's built-in MCP |
| --- | :---: | :---: |
| **Enterprise license** | Not required | Required |
| **Tools** | 38, agent-native | Coarse (read Markdown, page CRUD, replace whole page) |
| **Per-block edits / find-replace / scripted transforms** | ✅ | — |
| **Structured table editing, version diff / restore** | ✅ | — |
| **Comments, images, share links** | ✅ | — |
| **Safe real-time-collab writes (no clobber)** | ✅ | — |

**Same server as standalone docmost-mcp — just bundled.** This is the exact
[docmost-mcp](https://github.com/vvzvlad/docmost-mcp) you can also run on its own; embedding
it doesn't make it more capable, you simply don't have to install and run a separate
process. An admin flips one toggle in **Workspace settings → AI & MCP** and any MCP client
points at `${APP_URL}/mcp`.

## Roadmap

### Done

- ✅ **MCP server** — embedded community MCP server served at `/mcp`.
- ✅ **macOS app** — native macOS app ([docmost-app](https://github.com/vvzvlad/docmost-app)) that embeds the UI with multi-server tabs.

### In progress

- 🚧 **AI chat** — built-in AI agent chat over your wiki content.
- 🚧 **Git synchronization** — two-way sync of pages with a Git repository.

### Planned

- 🔭 **Templates** — reusable page templates.
- 🔭 **Viewer comments** — let read-only viewers leave comments.
- 🔭 **Password-protected pages** — protect individual pages / shares with a password.
- 🔭 **Windows / Linux app** — native desktop app for Windows and Linux.
- 🔭 **Mobile app** — native mobile application.
- 🔭 **Offline mode** — offline sync & PWA support.
- 🔭 **Editor & UX improvements** — blocks inside tables (lists, to-do items), column layout, additional heading levels, highlight blocks, custom emoji in callouts, floating images, anchor links for page mentions, toggles (shared-page width, aside/sidebar, spellcheck, ligatures), sanitized space-tree export, and mentions in breadcrumbs.

## Getting started

Gitmost follows the upstream Docmost setup. See the Docmost
[documentation](https://docmost.com/docs) for self-hosting and development instructions; replace the
`docmost/docmost` image with `ghcr.io/vvzvlad/gitmost` where applicable.

## Features

- Real-time collaboration
- Diagrams (Draw.io, Excalidraw and Mermaid)
- Spaces
- Permissions management
- Groups
- Comments (with resolve / re-open)
- Page history
- Search
- File attachments
- Embeds (Airtable, Loom, Miro and more)
- Translations (10+ languages)
- Embedded MCP server (`/mcp`)

### Screenshots

<p align="center">
<img alt="home" src="https://docmost.com/screenshots/home.png" width="70%">
<img alt="editor" src="https://docmost.com/screenshots/editor.png" width="70%">
</p>

### License

Gitmost is licensed under the open-source AGPL 3.0 license.

Unlike upstream Docmost, this fork contains **no Enterprise-Edition code** — the `apps/server/src/ee`,
`apps/client/src/ee` and `packages/ee` directories have been removed, so there are no files governed
by an enterprise license.

### Credits

Gitmost is based on [Docmost](https://github.com/docmost/docmost) by the Docmost team. Huge thanks to
them for the original open-source project.

<img width="100" alt="Crowdin" src="https://github.com/user-attachments/assets/a6c3d352-e41b-448d-b6cd-3fbca3109f07" />

[Crowdin](https://crowdin.com/) for providing access to their localization platform.

<img width="48" alt="Algolia-mark-square-white" src="https://github.com/user-attachments/assets/6ccad04a-9589-4965-b6a1-d5cb1f4f9e94" />

[Algolia](https://www.algolia.com/) for providing full-text search to the docs.
