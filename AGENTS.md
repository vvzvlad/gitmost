# AGENTS.md

This file guides AI agents (Claude Code, opencode, …) working in this
repository. It has two layers: **how to run a task end-to-end** (the
sections below), and **how the codebase is built** (the technical sections
further down, formerly in `CLAUDE.md`).

## Task lifecycle

### 1. Start: sync with develop

Before starting **any** work, update your local `develop` and branch off it:

```bash
git checkout develop
git fetch gitea
git pull --ff-only gitea develop
git checkout -b <short-feature-name>
```

Never build a feature directly on `develop`, and never branch off a stale
`develop` — otherwise the PR will carry extra commits or conflict.

### 2. Implementation

Run the task through the workflow from the system prompt (Phase 1 analysis →
Phase 3 implementation → Phase 4 review → Phase 5 verification → Phase 6
report). Delegate large changes to a general subagent; review via the review
subagent.

**Create worktrees only inside the `.claude` folder** (e.g.
`.claude/worktrees/<name>`). Creating a git worktree anywhere else — the repo
root, sibling directories, or temp folders — is forbidden.

### 3. Commit — ONLY to Gitea and ONLY as `claude_code`

This rule has no exceptions:

- **Where:** the only remote for commits/pushes is **`gitea`**
  (`gitea.vvzvlad.xyz`). **Never** push to `origin` (the GitHub mirror), and
  especially not to `upstream` (the original Docmost). The GitHub mirror is
  updated by the owner's CI process, not by the agent.
- **Who:** commit **only** as the agent identity. Any commit whose author or
  committer is `vvzvlad` is an error and must be rewritten.
  - **name:** `claude_code`
  - **email:** `claude_code@vvzvlad.xyz`

Use `--reset-author` when amending, otherwise git keeps the original author
(the default config on this machine is `vvzvlad`, so check after every commit):

```bash
GIT_AUTHOR_NAME="claude_code" \
GIT_AUTHOR_EMAIL="claude_code@vvzvlad.xyz" \
GIT_COMMITTER_NAME="claude_code" \
GIT_COMMITTER_EMAIL="claude_code@vvzvlad.xyz" \
git commit --amend --no-edit --reset-author
```

For a regular new commit, set the branch-local config once and commit normally:

```bash
git config user.name "claude_code"
git config user.email "claude_code@vvzvlad.xyz"
```

Check before push:

```bash
git log -1 --format='Author: %an <%ae>%nCommitter: %cn <%ce>'
# both lines must show claude_code <claude_code@vvzvlad.xyz>
```

### 4. Push and PR to develop

PRs always target `develop`. The `claude_code` password lives in the macOS
keychain as a **generic password** under service `gitea-claude-code` (do not
duplicate it as an internet-password for `gitea.vvzvlad.xyz` — that creates a
conflict with the owner's account in the git credential helper):

```bash
AGENT_PASS=$(security find-generic-password -s gitea-claude-code -w)
```

Push by temporarily injecting the credentials into the remote URL, then always
restore the URL to its clean form (the password must not linger in git
config / reflog):

```bash
ORIG_URL=$(git remote get-url gitea)
SAFE_PASS=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$AGENT_PASS")
git remote set-url gitea "https://claude_code:${SAFE_PASS}@gitea.vvzvlad.xyz/vvzvlad/gitmost.git"
git push -u gitea <branch>
git remote set-url gitea "$ORIG_URL"
unset AGENT_PASS SAFE_PASS
```

The PR is created via the Gitea REST API (Basic Auth as `claude_code`):

```bash
curl -s -X POST \
  -u "claude_code:$(security find-generic-password -s gitea-claude-code -w)" \
  -H "Content-Type: application/json" \
  -d @pr_body.json \
  "https://gitea.vvzvlad.xyz/api/v1/repos/vvzvlad/gitmost/pulls"
```

`base: develop`, `head: <branch>`. In the PR body: what was done, what is out
of scope, verification results (tsc/lint/tests).

> If push fails with `User permission denied for writing`, then `claude_code`
> lacks collaborator rights on the repo. Ask the owner to add them (once, via
> the Gitea UI or `PUT /api/v1/repos/vvzvlad/gitmost/collaborators/claude_code`
> with `{"permission":"write"}` from their account).

### 5. Merge and cleanup

- **The user merges the PR into develop** (not the agent). The agent does not
  press the merge button.
- **After implementing a task, delete its plan from `docs/backlog/<task>.md`** —
  this is part of closing the task, not the user's work. Files in
  `docs/backlog/` are the work queue; completed items get cleaned out of it.
  Do this in a separate commit from the same `claude_code` on the same branch
  (or ask the user to delete it if the PR is already open and you don't want to
  repush it).
- Any junk left uncommitted in the working tree? Check `git status` before the
  final report.

## Release cycle: staging a new version

When enough changes have accumulated on `develop` for a release, a **final
review by three orchestrator skills** runs before the merge/tag:

1. **test-orchestrator** (the `code-review-orchestrator` skill focused on test
   coverage) — verifies new code is covered by tests and there are no
   regressions in existing ones.
2. **review-orchestrator** (the `code-review-orchestrator` skill) —
   multi-aspect code review: security, stability, convention conformance,
   regressions, over-complexity.
3. **red-team-orchestrator** (the red-team skill) — adversarial analysis of
   attack scenarios against the affected components.

Order: the orchestrators return finding lists → the agent fixes everything they
found (via a subagent or itself, per the delegation rules) → re-runs the review
on the affected areas → cuts the tag per the "Cutting a release" procedure
below.

## Accounts & endpoints cheat sheet

| Item | Value |
| --- | --- |
| Only remote for commits | `gitea` → `https://vvzvlad@gitea.vvzvlad.xyz/vvzvlad/gitmost.git` |
| Agent user (Gitea/git) | `claude_code` |
| Agent email | `claude_code@vvzvlad.xyz` |
| Keychain password | `security find-generic-password -s gitea-claude-code -w` |
| PR API | `https://gitea.vvzvlad.xyz/api/v1/repos/vvzvlad/gitmost/pulls` (here `gitmost` is the repo's real slug on the server) |
| Base branch | `develop` |
| `origin` | GitHub mirror `vvzvlad/gitmost` — **do not push**, updated by the owner's CI |
| `upstream` | The original Docmost — **never push** |

## Creating issues (Gitea `tea` CLI)

Issues are filed with the official Gitea CLI `tea`, already logged in as
`claude_code` (`tea logins list` shows the `gitea` login as default):

```bash
tea issues create --repo vvzvlad/gitmost --labels feature \
  --title '<title>' --description "$(cat body.md)"
```

> Gotcha (tea 0.14.1): the issue body flag is `--description`/`-d`, **not**
> `--body` — passing `--body` fails with `flag provided but not defined: -body`.

---

# Architecture and codebase

## What this is

**Gitmost** is a community fork of [Docmost](https://github.com/docmost/docmost) — an open-source collaborative wiki / documentation app. The fork's defining constraint: **100% open, AGPL-only, with no Enterprise-Edition (EE) code**. The upstream `apps/server/src/ee`, `apps/client/src/ee` and `packages/ee` directories were deleted; there is no license gating or feature-flag wall. Features that upstream hides behind the enterprise license (comment resolution, the embedded `/mcp` server, the AI agent chat) are **re-implemented from scratch** on the community codebase.

**Naming gotcha:** only the *product* is rebranded. Internal identifiers are still `docmost` everywhere — npm package names (`docmost`, `@docmost/mcp`, `@docmost/editor-ext`), the default DB name, env-var prefixes (`MCP_DOCMOST_*`), and the TS path aliases (`@docmost/db/*`, `@docmost/transactional/*`). Do not "fix" these to `gitmost`; they are load-bearing for Docmost data/image compatibility (the DB schema is a strict superset of Docmost's, so an existing instance migrates by swapping images).

## Monorepo layout

pnpm workspace (`pnpm@10.4.0`) orchestrated by **Nx**. Four workspace packages:

| Path | Name | Stack | Role |
| --- | --- | --- | --- |
| `apps/server` | `server` | NestJS 11 + Fastify, Kysely (Postgres), Redis | Backend API, collaboration, AI |
| `apps/client` | `client` | React 18 + Vite + Mantine 8 + TanStack Query + Jotai | SPA frontend |
| `packages/editor-ext` | `@docmost/editor-ext` | Tiptap/ProseMirror | Shared Tiptap node/mark extensions, imported by both the client and the server |
| `packages/mcp` | `@docmost/mcp` | MCP SDK, Tiptap, Yjs | Standalone MCP server, also bundled into the server at `/mcp`. Does **not** import `editor-ext` — it keeps its own vendored mirror of the schema in `packages/mcp/src/lib/` |

`build` targets are Nx-cached and dependency-ordered (`dependsOn: ["^build"]`), so `editor-ext` builds before the apps. `nx.json` sets `affected.defaultBase: main`.

## Commands

Run from the repo root unless noted. The dev workflow needs **Postgres (with the `pgvector` extension) and Redis** reachable per `.env` (copy `.env.example` → `.env`).

```bash
pnpm install                 # install all workspaces (uses pnpm patches; see package.json `pnpm.patchedDependencies`)
pnpm dev                     # client (Vite) + server (Nest watch) concurrently — primary dev loop
pnpm client:dev              # frontend only (Vite proxies /api to APP_URL)
pnpm server:dev              # backend only (nest start --watch)
pnpm build                   # nx run-many -t build (all packages)
pnpm collab:dev              # run the collaboration server process standalone (see "Two server processes")
```

**Lint** (per package — there is no root lint script):
```bash
pnpm --filter server lint    # eslint --fix on server .ts
pnpm --filter client lint    # eslint on client
```

**Tests** (per package — no root test script):
```bash
pnpm --filter server test                       # Jest, matches *.spec.ts under src
pnpm --filter server test -- ai-chat.service     # single file by name pattern
pnpm --filter server test -- -t "resolves a comment"   # single test by name
pnpm --filter client test                       # Vitest (vitest run)
pnpm --filter client test -- message-list        # single Vitest file by name
pnpm --filter @docmost/mcp test                  # node --test (unit + mock)
pnpm --filter @docmost/mcp test:e2e              # MCP end-to-end against a live instance
```

**Database migrations** (Kysely, run from `apps/server`). **Where they auto-apply:** in **production** (the built image / `start:prod`) pending migrations run automatically on server boot. In **local dev** (the `pnpm dev` stand / `nest start --watch`) they do **NOT** auto-run — after you pull or switch branches you must apply them yourself with `pnpm --filter server migration:latest`, or any endpoint touching a new column/table 500s (e.g. a freshly-added `ai_chats.page_id` blanket-500s all of AI chat until migrated).
```bash
pnpm --filter server migration:create --name=my_change   # new empty migration
pnpm --filter server migration:latest                    # apply all pending
pnpm --filter server migration:down                      # revert last
pnpm --filter server migration:codegen                   # regenerate src/database/types/db.d.ts from the live DB
```
Migration files live in `apps/server/src/database/migrations/` and are named `YYYYMMDDThhmmss-description.ts`. Fork-specific migrations only **add** tables (`page_embeddings`, `ai_chats`, `ai_chat_messages`, `ai_provider_credentials`, `ai_mcp_servers`, `page_template_references`) and columns (e.g. `pages.is_template`, a `NOT NULL DEFAULT false` boolean) — never drop/rewrite Docmost data.

**Migration ordering — always check when merging branches/features.** Kysely runs migrations in **alphabetical (= timestamp) order** and refuses to start if a *new* migration sorts **before** one already applied to the DB (`corrupted migrations: ... must always have a name that comes alphabetically after the last executed migration`). When you merge a branch or land a feature, verify your migration's timestamp still sorts **after every migration that may already be applied on the target** (`/bin/ls -1 apps/server/src/database/migrations | sort | tail`). Branches developed in parallel routinely break this: a feature branch adds `…T130000-…`, `main` meanwhile ships and deploys `…T150000-…`, and after the merge the older-timestamped file is rejected at boot. **Fix = rename your migration to a timestamp after the latest one already in the target** (content unchanged — the filename is the ordering key), then rebuild so the compiled `dist/database/migrations/` picks up the new name.

## Architecture — the big picture

### Two server processes
`apps/server` builds one codebase but runs as **two distinct entrypoints**, both required in production:
- **API server** — `dist/main` (`apps/server/src/main.ts`), the Fastify HTTP app (`AppModule`).
- **Collaboration server** — `dist/collaboration/server/collab-main` (`pnpm collab`), a Hocuspocus/Yjs WebSocket server (`apps/server/src/collaboration/`) handling real-time document editing, persistence, and page-history snapshots. It listens on `COLLAB_PORT` (default `3001`), separate from the API server's `PORT` (default `3000`), and shares state with the API server through Redis.

The API server is a Fastify app with a global `/api` prefix (`main.ts` excludes `robots.txt`, public share pages, and `mcp` from the prefix). A `preHandler` hook enforces that a resolved `workspaceId` exists for most `/api` routes (multi-tenant by hostname/subdomain via `DomainMiddleware`). `GET /api/sb/:id` (the anonymous blob-sandbox read route) is listed in that preHandler's `excludedPaths`, so it is exempt from workspace resolution and carries no session auth at all (its capability is the unguessable UUID + TTL + TLS) — unlike `/api/files/public/...`, which still resolves a workspace and requires a workspace-bound attachment JWT. Auth is JWT (cookie + bearer); authorization is **CASL** (`core/casl`) — every data access is scoped to the user's abilities.

### Module structure (server)
`AppModule` wires integration modules (`integrations/*`: storage [local/S3/Azure], mail, queue [BullMQ on Redis], security, telemetry, throttle, `mcp`, `ai`) plus `CoreModule`, `DatabaseModule`, and `CollaborationModule`. `CoreModule` (`core/*`) holds the domain modules: `page`, `space`, `comment`, `workspace`, `user`, `auth`, `group`, `attachment`, `search`, `share`, `ai-chat`, etc. Each domain module follows NestJS controller → service → repo layering; DB repos live under `database/repos` and are injected app-wide from the global `DatabaseModule`.

**EE removal artifact:** `app.module.ts` still contains a `try/require('./ee/ee.module')` stub. That path no longer exists, so the require fails and is swallowed (it only hard-exits when `CLOUD === 'true'`). Treat EE as gone — do not add code that depends on it.

### Persistence
- **Postgres via Kysely** (`nestjs-kysely`), typed by the generated `src/database/types/db.d.ts`. Use the camelCase Kysely query builder, not an ORM. After schema changes, write a migration *and* regenerate the DB types.
- **pgvector is mandatory** — the RAG feature stores embeddings in `page_embeddings`. `docker-compose.yml` uses `pgvector/pgvector:pg18` for this reason; the stock `postgres` image will fail the `CREATE EXTENSION vector` migration.
- **Redis** backs caching, the BullMQ queues, the WebSocket Socket.IO adapter, and collaboration sync.

### The two AI subsystems (the main fork additions)
1. **Embedded MCP server** (`integrations/mcp/` + `packages/mcp`). The standalone `@docmost/mcp` server (40 agent-native tools: per-block patch/insert/delete by id, scripted `(doc)=>doc` transforms with dry-run diff, table editing, version diff/restore, comments, images, shares) is bundled and served over HTTP at `/mcp`. It writes through Docmost's real-time-collaboration layer so concurrent human edits aren't clobbered. Each request authenticates **per-user** via the `Authorization` header — either HTTP Basic (`base64(email:password)`, the user's own Docmost login, validated through `AuthService`) or a Bearer access JWT (the user's `authToken`) — and the session acts under that user's permissions. `MCP_DOCMOST_EMAIL` / `MCP_DOCMOST_PASSWORD` are an **optional service-account fallback**, used only when a request carries neither Basic nor Bearer credentials (back-compat for CI/scripts). An admin enables MCP with a workspace toggle (Workspace settings → AI). Optionally protected by a shared `MCP_TOKEN`: when set, every `/mcp` request must carry a matching `X-MCP-Token` header (its own header, separate from `Authorization`, which now carries the per-user Basic/Bearer credentials). Note: this changed from the older `Authorization: Bearer <MCP_TOKEN>` scheme — see `.env.example` and the CHANGELOG Breaking Changes entry.
2. **AI agent chat** (`core/ai-chat/` server + `apps/client/src/features/ai-chat/` client). A built-in agent over the wiki using the Vercel **AI SDK** (`ai`, `@ai-sdk/*`) against any OpenAI-compatible provider configured per workspace (`integrations/ai/` — credentials encrypted at rest via `integrations/crypto`, stored in `ai_provider_credentials`). Key pieces:
   - `core/ai-chat/tools/` — the agent's ~40 read+write tools. Every tool runs under the **calling user's** CASL permissions via a per-user loopback access token (`docmost-client.loader.ts`), so the agent can never exceed what the user could do. Only **reversible** operations are exposed (page history + trash; no permanent delete). Agent edits get an "AI agent" provenance badge in page history (`20260616T130000-agent-provenance` migration).
   - `core/ai-chat/embedding/` — RAG indexer + a BullMQ consumer on `AI_QUEUE` that embeds pages into `page_embeddings` (vector search), complementing Postgres full-text search. Pages are (re)indexed on edit; `AI_EMBEDDING_TIMEOUT_MS` bounds a hung embeddings endpoint.
   - `core/ai-chat/external-mcp/` — admins can attach external MCP servers (e.g. Tavily) to give the agent web access. **`ssrf-guard.ts` validates outbound MCP URLs against SSRF** — keep that guard in the path when touching external-MCP connection logic.

### Client structure
Vite SPA. Code is organized by feature under `apps/client/src/features/*` (mirrors the server domains: `page`, `space`, `comment`, `ai-chat`, `editor`, …). Conventions:
- **TanStack Query** for server state (one `queries/` file per feature), **Jotai** atoms for local/shared UI state, **Mantine 8** + CSS modules (`*.module.css`) + `postcss-preset-mantine` for UI.
- The editor is Tiptap; shared node/mark extensions live in `packages/editor-ext` and are imported by **both the client and the server** (collaboration, import/export) — editor schema changes often need to be made in `editor-ext`, not just the client. Note `packages/mcp` does *not* depend on `editor-ext`; it carries its own mirrored copy of the schema, so keep the two in sync manually when the document schema changes.
- API access goes through `apps/client/src/lib/api-client.ts` (axios). The `@` alias maps to `apps/client/src`.
- Runtime config is injected at build time by `vite.config.ts` via `define` (`APP_URL`, `COLLAB_URL`, `APP_VERSION`, …) — these come from the root `.env`, not from `import.meta.env`.

## Conventions

- **Code comments must be in English.**
- **Errors must never be swallowed or shown as generic messages.** Every caught error MUST (1) be logged in full to the console/logger — error name, message, stack, `cause`, and (for HTTP/provider failures) the status code and response body — and (2) be surfaced to the user with a *specific, human-readable explanation of what actually went wrong*, never a bare generic string like "Something went wrong" / "Could not start recording" / "Transcription failed". Include the real reason (the underlying error/provider message) in the user-facing text. On the server, wrap third-party/provider failures with `describeProviderError` (or equivalent) and rethrow as a meaningful HTTP status + message — never let them collapse into an opaque 500. On the client, `console.error(<context>, err)` the raw error AND show the extracted reason (e.g. `err.response?.data?.message`, or the error `name: message`) in the notification.
- The version string shown in the UI comes from `APP_VERSION` (CI/Docker) or `git describe --tags --always` (local), resolved in `vite.config.ts` — not from `package.json`.
- Server TS config is permissive (`noImplicitAny: false`, `strictNullChecks: false`, `no-explicit-any` lint disabled). Follow the existing relaxed style rather than tightening types broadly.
- Dependency versions are heavily pinned via `pnpm.overrides` and `pnpm.patchedDependencies` (`scimmy`, `yjs`) in the root `package.json`. Don't bump pinned/patched deps casually; the patches and overrides exist for compatibility/security reasons.

## CI / release

- `.github/workflows/develop.yml` — on push to `develop`, builds and pushes `ghcr.io/vvzvlad/gitmost:develop`.
- `.github/workflows/release.yml` — on `v*` tags (or manual dispatch), builds multi-arch (amd64 + arm64) images, pushes a manifest list to GHCR (`latest` + semver tags), and creates a draft GitHub Release with image tarballs. Uses the built-in `GITHUB_TOKEN` (not Docker Hub).
- The `Dockerfile` is a multi-stage pnpm build; `APP_VERSION` is passed as a build arg because `.git` isn't in the build context.

### Cutting a release

The git tag is the source of truth for the displayed version (the client UI reads `git describe --tags` via `vite.config.ts`); the `package.json` bump is metadata that backs the server `/version` endpoint (`version.service.ts`).

**Golden rule — tag on `develop` first, merge to `main` afterwards.** Cut the version-bump commit on `develop`, put the tag on *that* commit, and push it. Merge `develop` into `main` later (it does not block the tag or the release). Because the tag is in `develop`'s ancestry from the moment it is created, `git describe` on `develop` — and the `ghcr.io/vvzvlad/gitmost:develop` image — reports the new version immediately, with **no back-merge dance**. Do **not** tag `main`'s merge commit; that is the mistake described in the pitfall below (we hit it twice).

Steps:

1. Make sure `develop` is up to date, clean, and pushed to **both** remotes (`git status`; `git push gitea develop && git push github develop`).
2. Pick `vX.Y.Z` (SemVer): **minor** bump for a batch of features, **patch** for fixes only. Review what landed with `git log <last-tag>..HEAD --no-merges`.
3. Bump `"version"` to `X.Y.Z` in the **root** `package.json`, `apps/client/package.json`, and `apps/server/package.json` (keep all three in sync). Leave `packages/mcp` alone — it is versioned independently. Commit **on `develop`** with the bare version as the subject, e.g. `0.94.1` (matches past bump commits).
4. For a real release (skip for a bare hotfix tag), update `CHANGELOG.md` (Keep a Changelog format): add a `## [X.Y.Z] - YYYY-MM-DD` section summarising `git log vPREV..HEAD --no-merges` grouped by type (Breaking / Added / Changed / Fixed / Removed), and the `compare/vPREV...vX.Y.Z` link at the bottom. Fold it into the bump commit.
5. Tag that develop commit with a **lightweight** tag (existing release tags are lightweight): `git tag vX.Y.Z`.
6. Push the branch **and** the tag to **both** writable remotes — `git push <branch>` does **not** push tags, and tags are per-remote:
   ```bash
   git push gitea develop && git push gitea vX.Y.Z
   git push github develop && git push github vX.Y.Z
   ```
   Pushing the `v*` tag to `github` triggers `release.yml` (multi-arch GHCR images + a draft GitHub Release). The tag *must* exist on `github`, because the `:develop` and release images are built there by GitHub Actions and `git describe` on the runner only sees the tags present on `github` (not your local clone or `gitea`).
7. Merge `develop` into `main` when ready (commonly later — this does not gate the release):
   ```bash
   git checkout main
   git merge --ff-only develop   # or a merge commit if fast-forward is not possible
   git push gitea main && git push github main
   ```
   The tag is already reachable from `main` (it lives in the `develop` history that `main` now contains), so `main` reports `vX.Y.Z` too — no extra tagging needed.

#### Pitfall: tagging `main` instead of `develop` (the mistake to avoid)

`git describe --tags --always` (see `vite.config.ts`) walks **backwards from the current commit** and picks the **nearest tag reachable in that commit's ancestry**, then appends `-<commits-since-tag>-g<short-hash>`.

The wrong flow we fell into twice: merge `develop` into `main` *first*, then tag `main`'s **release merge commit**. That merge commit is **not** in `develop`'s history, so `git describe` on `develop` cannot see the new tag and falls back to the *previous* reachable one. Result: every develop build — and the `ghcr.io/vvzvlad/gitmost:develop` image — keeps reporting e.g. `v0.93.0-NNN-g<hash>` even though a release was "cut". Tagging on `develop` (the golden rule above) avoids this entirely: the tag is in `develop`'s ancestry from the start, and `main` still gets it once `develop` is merged in.

Second gotcha — the tag must exist on the remote CI builds from. `git describe` names a tag **ref**, not just a commit. The `:develop` and release images are built by GitHub Actions (`develop.yml` / `release.yml`, `actions/checkout` with `fetch-depth: 0`), so the version they print depends on which tags exist **on the `github` remote** — not on your local clone or on `gitea`. `git push <branch>` does **not** push tags; push them explicitly to **each** remote (`gitea` and `github`). A tag that only lives on `gitea` is invisible to the GitHub build.

If you already tagged `main` (or `develop` still shows the old version), recover without re-tagging:

1. Make the tagged commit reachable from `develop` — either back-merge `main → develop` (`git checkout develop && git merge --no-ff main`), or confirm the tagged commit is already an ancestor of `develop`.
2. Make sure the tag exists on `github`: compare `git ls-remote --tags github` with `gitea`, and push the missing one (`git push github vX.Y.Z` / `git push gitea vX.Y.Z`). Pushing a `v*` tag to `github` also fires `release.yml` — expected, just be aware.
3. Re-run the develop build (`gh workflow run Develop`, or push any commit to `develop`) so `git describe` re-resolves with the tag now in scope.

(There is no `origin` remote here — push to `gitea` **and** `github` explicitly, and always push release tags to both.)

## Planning docs

`docs/*.md` hold design plans for in-progress / planned features (mobile app, offline sync, RAG improvements, voice dictation). Arbitrary HTML embed has **shipped** — it renders inside a sandboxed iframe and, when the `htmlEmbed` workspace toggle is on, is insertable by any member (no longer admin-only); turning the toggle off hides/stops serving existing embeds on public share pages. `docs/backlog/*.md` track known issues / follow-ups (e.g. AI-chat review follow-ups). Consult the relevant plan before working on one of those areas.
