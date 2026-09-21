# AGENTS.md

This file guides AI agents (Claude Code, opencode, …) working in this
repository. It has two layers: **how to run a task end-to-end** (the
sections below), and **how the codebase is built** (the technical sections
further down, formerly in `CLAUDE.md`).

## ARCHITECTURAL INVARIANTS — NON-NEGOTIABLE

THE TEN RULES BELOW ARE HARD CONSTRAINTS. Each one was paid for with a real
production incident or a multi-PR bug chain in THIS repository (cited inline).
They override convenience, deadlines and "it's just a small feature". A PR that
violates any of them MUST be rejected in review regardless of how good the rest
of it is. If a task genuinely seems to require breaking one — STOP and raise it
with the owner; do not code around it.

### 1. EVERY BUFFER, CACHE, HISTORY AND PAYLOAD HAS AN EXPLICIT SIZE BUDGET

Nothing accumulates unboundedly. A row/item cap is NOT a byte cap. Anything
replayed to a model, buffered in memory, persisted per step, or refetched by a
poll must state its budget in bytes/tokens and enforce it. Rewriting a growing
structure in full on every increment is FORBIDDEN — append or diff instead;
O(n²) write/serialize patterns do not pass review.
(Paid for by: full-row rewrite on every agent step — hundreds of MB of Postgres
writes per 50-step run, with every tool output serialized twice; unbounded
history replay killing long chats on the provider context window; 32 MB replay
buffers per active run.)

### 2. EVERYTHING LONG-RUNNING TERMINATES BY CONSTRUCTION

Every run / row / session / lease / subscriber / queue entry must define AT
DESIGN TIME: its owner; every terminal state; who writes the terminal state on
EVERY path (success, error, abort, disconnect in each phase, process restart);
retries for the terminal write; and a periodic sweeper that does not depend on
a reboot. A best-effort terminal write with no retry and no sweep is FORBIDDEN.
(Paid for by: assistant rows stuck 'streaming' forever; runs stuck 'running'
409-locking their chat until a restart — the #183/#184 follow-up chain.)

### 3. EVERY AWAIT IS CANCELLABLE AND DEADLINED; NEVER BLOCK THE EVENT LOOP

Every async step inside a request or agent turn honors the turn's AbortSignal
AND a wall-clock deadline — including in-app tools, lock queues and pagination
loops, not just external calls. Synchronous CPU work beyond ~50 ms goes to a
worker_thread. Promise.race DOES NOT cancel synchronous work — using it as a
"timeout" for sync computation is forbidden (the timer only fires after the
event loop is free again, i.e. after the damage is done).
(Paid for by: in-app tools ignoring abortSignal and writing pages AFTER Stop;
the synchronous ELK layout freezing every SSE stream in the process; the
step-0 MCP handshake hang — #397.)

### 4. ONE SOURCE OF TRUTH; EVERYTHING ELSE IS A REBUILDABLE CACHE

Postgres is the authoritative state. Every in-memory structure (registries,
caches, client stores) must be reconstructible from the DB and treated as
lossy. The client renders SERVER-DECLARED state — "a run is active" is a server
fact delivered as data, never inferred from side signals (204 vs 2xx, the
flavor of a disconnect). A new feature must name the owner of each piece of
state before implementation starts.
(Paid for by: the strip/restore resume machinery, silently frozen UIs and
ghost sends after unmount — the #381→#432→#456 chain.)

### 5. STATE MACHINES ARE EXPLICIT — ONE-SHOT FLAGS ARE FORBIDDEN

A complex lifecycle (chat thread, resume/reconnect, run) lives in a named-state
automaton (reducer / enum) where every state has an owner and a rendered
representation — including the failure states. Adding a boolean ref that one
callback arms and another reads-and-clears is FORBIDDEN in the AI-chat client.
New behavior = a new named state + explicit transitions, and the interruption
matrix (disconnect in each phase × restart × stop × supersede) is enumerated at
design time, not discovered one incident at a time.
(Paid for by: 26 one-shot useRef flags in chat-thread.tsx and the drip of
"one more missing transition" across #381→#386/#389→#432→#456.)

### 6. NO NEW MODE FORKS; A FLAG IS FOR ROLLOUT, THEN IT DIES

A behavior flag that forks a code path must ship with a written sunset
condition; stacking a new flag onto the existing matrix without deleting or
scheduling an old one is forbidden. While a temporary fork exists, BOTH sides
must share identical lifecycle handling (abort semantics, error listeners,
concurrency gates) — asymmetric forks are outlawed.
(Paid for by: legacy vs autonomous divergence — the one-active-run gate and
the socket 'error' listener each existing on only ONE side; 2^4 flag
combinations each with different abort semantics.)

### 7. NO HAND-SYNCED MIRRORS — CODEGEN OR A CI PARITY TEST, NOTHING LESS

Two copies of the same knowledge (schema, tool registry, glyph map, probe
body, hash/normalize algorithm, label list) require either generation from a
single source or a CI test that FAILS on drift. A "mirror this change over
there" comment is NOT a guard and does not pass review.
(Paid for by: #293 — three drifting converter copies losing data; #447 —
REGISTRY_STAMP covering only one of the mirrored files; ~10 still-unguarded
mirrors across the MCP layer.)

### 8. CACHES, HEADERS, BUFFERS AND FSM TRANSITIONS GET AN INTEGRATION TEST OF THE OBSERVABLE PROPERTY

A unit test of a pure helper DOES NOT COUNT for these. Test the real header on
the real HTTP response, the real cache hit under real token sources, the real
transition under a really-killed socket. If the observable property cannot be
tested, the design is wrong — fix the design, not the test.
(Paid for by: #431→#439 — a cache keyed on a fresh-per-call JWT, so it NEVER
hit and became prod incident #435 while its unit tests stayed green; and by
the #352→#455 immutable-cache header silently overwritten by a framework
default AFTER the unit-tested code ran.)

### 9. CLIENT INPUT IS HOSTILE UNTIL VALIDATED — ALSO BEFORE PERSISTENCE

Anything from the browser (message parts, ids, titles, selections, flags) is
validated/sanitized BEFORE it is persisted into a row that will later be
replayed into a prompt, a converter or another subsystem. A poisoned row must
never be able to permanently brick a chat or a page on every subsequent read.
(Paid for by: unvalidated UIMessage parts persisted verbatim — one bad row
500s the chat on every later turn; #159 client-spoofed page titles; #388
selection re-sanitized server-side for the same reason.)

### 10. FAILURES ARE LOUD AND SPECIFIC; SILENT DEGRADATION IS FORBIDDEN

Extends the error convention below: a fire-and-forget write is allowed ONLY
with a metric or a greppable ERROR log; a degraded mode (dead cached MCP
client, stopped poll, exhausted retries, evicted buffer) must be VISIBLE to
the user or the operator. A feature that can quietly stop working — a frozen
"streaming…" UI, a poll that silently gives up, a cache serving corpses — does
not pass review.
(Paid for by: the degraded poll's silent 10-minute death leaving a forever-
"streaming" answer; dead MCP clients served from cache while every external
tool call failed; #435 being caught in minutes ONLY because metrics — #403 —
existed.)

## Default skill for feature design

For any feature-design request — the user hands over a raw feature idea, asks
to design or think through a feature, or to draft an issue («спроектируй»,
«продумай фичу», «составь ишью», "design X", "write an issue for X") — invoke
the `orchestrator-feature-designer` skill (Skill tool) BEFORE any other work.
It is the default operating mode for design work in this repository: research
→ premise ledger agreed with the human BEFORE designing on it → design
checklist (R1–R11) → forks resolved with the human → adversarial self-attack
(premise lens included) → filed PR-sized issues. Do not design features or write issues
ad-hoc while this skill is available. This does not apply to non-design work
(bug fixes, reviews, retrospectives, refactors already specified by an issue).

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

PRs always target `develop`. Two different mechanisms are involved: **pushing
commits is git-native** (the Gitea MCP cannot push local git history, so the
branch is still pushed with `git push`), while **the PR itself is opened through
the Gitea MCP** (see below). The `claude_code` password lives in the macOS
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

The PR is opened through the **Gitea MCP** (server `gitea`), not `curl`/`tea` —
the MCP authenticates in-process, so no keychain lookup or Basic-Auth is needed.
Call `pull_request_write` with:

- `method: "create"`
- `owner: "vvzvlad"`, `repo: "gitmost"`
- `base: "develop"`, `head: "<branch>"`
- `title`, `body` — in the body: what was done, what is out of scope,
  verification results (tsc/lint/tests).

Manage and read PRs through the same server: `list_pull_requests`,
`pull_request_read` (`get`, `get_diff`, `get_files`, `get_status`),
`pull_request_review_write`.

**Identity note:** the MCP acts under its **own** configured Gitea token (verify
with `get_me`), a different account from the `claude_code` used for git
commits/pushes in §3. Only the forge API calls (PR / issue / review) go through
the MCP account; the commits themselves stay authored as `claude_code`.

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
| Forge API (PR / issue / review / reads) | **Gitea MCP** — server `gitea` (`pull_request_write`, `issue_write`, `list_pull_requests`, `pull_request_read`, `label_read`, …). Authenticated in-process; acts under its own token — check with `get_me`. Repo slug on the server is `gitmost`. |
| Base branch | `develop` |
| `origin` | GitHub mirror `vvzvlad/gitmost` — **do not push**, updated by the owner's CI |
| `upstream` | The original Docmost — **never push** |

## Creating issues (Gitea MCP)

File issues through the **Gitea MCP** (server `gitea`), not a CLI — call
`issue_write` with:

- `method: "create"`
- `owner: "vvzvlad"`, `repo: "gitmost"`
- `title`, `body`
- `labels` — an array of label **IDs** (numbers), *not* names. Resolve a name
  such as `feature` to its id first with `label_read` (`method: "list"`), then
  pass e.g. `labels: [<id>]`.

Read issues with `list_issues`, `issue_read`, or `search_issues`. The MCP is
authenticated in-process, so no `tea`/`curl` and no keychain lookup are needed.

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
| `packages/mcp` | `@docmost/mcp` | MCP SDK, Tiptap, Yjs | Standalone MCP server, also bundled into the server at `/mcp`. Consumes the shared converter/schema from `@docmost/prosemirror-markdown` (#293) — it no longer carries its own vendored converter/schema copy |
| `packages/prosemirror-markdown` | `@docmost/prosemirror-markdown` | Tiptap, marked; jsdom (Node only) | The single, canonical ProseMirror↔Markdown converter + Docmost schema mirror (#293). Consumed by `mcp`, `git-sync`, `apps/server` (server-side markdown import/export, #345), AND `apps/client` (markdown paste/copy + AI-chat render, via the `browser` entry — native `DOMParser`, no jsdom in the client bundle, #347); there is exactly ONE copy of the converter now |

`build` targets are Nx-cached and dependency-ordered (`dependsOn: ["^build"]`), so `editor-ext` builds before the apps. `nx.json` sets `affected.defaultBase: main`.

## Commands

Run from the repo root unless noted. The dev workflow needs **Postgres (with the `pgvector` extension) and Redis** reachable per `.env` (copy `.env.example` → `.env`).

> **Bringing up a full local stand** (API + client + the separate realtime
> collaboration process) has several non-obvious gotchas — a missing collab
> server, `APP_SECRET` mismatch between processes, a stale `editor-ext` white-
> screening the client, LAN exposure. See **[docs/dev-stand.md](docs/dev-stand.md)**
> for the step-by-step and the traps.
>
> **Testing the app against a stand** (browser E2E + out-of-band verification) has
> its own non-obvious traps — the page has two ProseMirror editors (only the body is
> collab-bound), a ~10s store debounce, and API-seeding the thing under test is a
> silent no-test. See **[docs/how-to-test.md](docs/how-to-test.md)** before writing
> UI tests.

```bash
pnpm install                 # install all workspaces (uses pnpm patches; see package.json `pnpm.patchedDependencies`)
pnpm dev                     # client (Vite) + server (Nest watch) concurrently — primary dev loop
pnpm client:dev              # frontend only (Vite proxies /api to APP_URL)
pnpm server:dev              # backend only (nest start --watch)
pnpm build                   # nx run-many -t build (all packages)
pnpm collab:dev              # run the collaboration server process standalone (see "Two server processes")
```

> **Build the shared packages before running a consumer's `tsc`/tests in
> isolation.** The `build/` dirs of `@docmost/prosemirror-markdown`,
> `@docmost/git-sync`, and `@docmost/mcp` are **gitignored** (not committed), and
> a single-package `pnpm --filter <pkg> test` / `tsc` or a bare `pnpm -r test`
> does **NOT** honour the Nx `dependsOn: ["^build"]` ordering. So a consumer — the
> server's `tsc`, `git-sync`'s vitest typecheck, `mcp`'s `pretest: tsc` — fails
> with `error TS2307: Cannot find module '@docmost/…'` until those packages are
> built first:
> ```bash
> pnpm --filter @docmost/prosemirror-markdown build
> pnpm --filter @docmost/editor-ext build
> pnpm --filter @docmost/git-sync build && pnpm --filter @docmost/mcp build
> ```
> `pnpm build` (nx run-many) does this for you; CI does it explicitly in
> `.github/workflows/test.yml` (prosemirror-markdown → git-sync/mcp → server, in
> that order). Reach for it whenever you run a consumer package's checks on their
> own rather than through the full `pnpm build`.

> **Editing an MCP tool spec requires a rebuild (issue #447).** The running
> server loads the **compiled** `packages/mcp/build/` of `@docmost/mcp` (via the
> runtime loader in `apps/server/src/core/ai-chat/tools/docmost-client.loader.ts`),
> but the parity/tier guard tests read `packages/mcp/src/tool-specs.ts`. So if you
> edit `tool-specs.ts` (any tool name, description, tier, catalog line, or input
> schema) **without rebuilding**, `build/` and `src/` silently diverge — the tests
> stay green while the server serves the OLD tools. To close that gap, the build
> emits a `REGISTRY_STAMP` (a deterministic hash of the tool-specs content, via
> `scripts/gen-registry-stamp.mjs` before `tsc`); on dev/test startup the loader
> recomputes it from `src/` and **refuses to start with a "@docmost/mcp build is
> stale …" error** on a mismatch (a pure no-op in prod, where only `build/` ships).
> After editing tool specs, rebuild:
> ```bash
> pnpm --filter @docmost/mcp build     # or: pnpm --filter @docmost/mcp watch
> ```

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

**Migration ordering — always check when merging branches/features.** Kysely runs migrations in **alphabetical (= timestamp) order**. A *new* migration that sorts **before** one already applied to the DB is a "back-dated" migration, which branches developed in parallel routinely produce: a feature branch adds `…T130000-…`, `develop` meanwhile ships and deploys `…T150000-…`, and after the merge the older-timestamped file has been skipped. Two layers guard this (both added for incident #361, where a back-dated migration crash-looped prod for ~11 min):

- **CI gate (primary):** the `migration-order` job in `.github/workflows/test.yml` fails a PR whose added migration sorts at/before the newest on the base branch. **So the fix is to rename your migration to a timestamp after the latest one already in the target** (`/bin/ls -1 apps/server/src/database/migrations | sort | tail`; content unchanged — the filename is the ordering key), then rebuild so the compiled `dist/database/migrations/` picks up the new name.
- **Runtime safety net:** both Migrators (`migration.service.ts` startup auto-migrate + `migrate.ts` CLI) set `allowUnorderedMigrations: true`, so the app does **not** refuse to start on an out-of-order migration — it applies the skipped older one instead of crash-looping. Kysely's `#ensureNoMissingMigrations` guard is still on (a *removed* applied migration is still an error). Because apply order can then differ from lexicographic across instances, migrations must stay **independent** (each creates its own objects) — the CI gate remains the primary line; this net only covers a gate bypass (manual push / hotfix branch).

## Architecture — the big picture

### Two server processes
`apps/server` builds one codebase but runs as **two distinct entrypoints**, both required in production:
- **API server** — `dist/main` (`apps/server/src/main.ts`), the Fastify HTTP app (`AppModule`).
- **Collaboration server** — `dist/collaboration/server/collab-main` (`pnpm collab`), a Hocuspocus/Yjs WebSocket server (`apps/server/src/collaboration/`) handling real-time document editing, persistence, and page-history snapshots. It listens on `COLLAB_PORT` (default `3001`), separate from the API server's `PORT` (default `3000`), and shares state with the API server through Redis.

`pnpm dev` starts **only** the API server + client — the collaboration process is separate and must be started too, or the editor never connects. See **[docs/dev-stand.md](docs/dev-stand.md)** for running both locally (and why `APP_SECRET` must match between them).

The API server is a Fastify app with a global `/api` prefix (`main.ts` excludes `robots.txt`, public share pages, and `mcp` from the prefix). A `preHandler` hook enforces that a resolved `workspaceId` exists for most `/api` routes (multi-tenant by hostname/subdomain via `DomainMiddleware`). `GET /api/sb/:id` (the anonymous blob-sandbox read route) is listed in that preHandler's `excludedPaths`, so it is exempt from workspace resolution and carries no session auth at all (its capability is the unguessable UUID + TTL + TLS) — unlike `/api/files/public/...`, which still resolves a workspace and requires a workspace-bound attachment JWT. Auth is JWT (cookie + bearer); authorization is **CASL** (`core/casl`) — every data access is scoped to the user's abilities.

### Module structure (server)
`AppModule` wires integration modules (`integrations/*`: storage [local/S3/Azure], mail, queue [BullMQ on Redis], security, telemetry, throttle, `mcp`, `ai`) plus `CoreModule`, `DatabaseModule`, and `CollaborationModule`. `CoreModule` (`core/*`) holds the domain modules: `page`, `space`, `comment`, `workspace`, `user`, `auth`, `group`, `attachment`, `search`, `share`, `ai-chat`, etc. Each domain module follows NestJS controller → service → repo layering; DB repos live under `database/repos` and are injected app-wide from the global `DatabaseModule`.

**EE removal artifact:** `app.module.ts` still contains a `try/require('./ee/ee.module')` stub. That path no longer exists, so the require fails and is swallowed (it only hard-exits when `CLOUD === 'true'`). Treat EE as gone — do not add code that depends on it.

### Persistence
- **Postgres via Kysely** (`nestjs-kysely`), typed by the generated `src/database/types/db.d.ts`. Use the camelCase Kysely query builder, not an ORM. After schema changes, write a migration *and* regenerate the DB types.
- **pgvector is mandatory** — the RAG feature stores embeddings in `page_embeddings`. `docker-compose.yml` uses `pgvector/pgvector:pg18` for this reason; the stock `postgres` image will fail the `CREATE EXTENSION vector` migration.
- **Redis** backs caching, the BullMQ queues, the WebSocket Socket.IO adapter, and collaboration sync.

### The two AI subsystems (the main fork additions)
1. **Embedded MCP server** (`integrations/mcp/` + `packages/mcp`). The standalone `@docmost/mcp` server (40 agent-native tools: per-block patch/insert/delete by id, scripted `(doc)=>doc` transforms with dry-run diff, table editing, version diff/restore, comments, images, shares) is bundled and served over HTTP at `/mcp`. It writes through Docmost's real-time-collaboration layer so concurrent human edits aren't clobbered. Each request authenticates an agent **exclusively** with a Bearer api_key via the `Authorization` header (`Authorization: Bearer <api_key>`, minted under Workspace settings → API keys, validated through `ApiKeyService`) — the session acts under that key owner's permissions, and revoking the key revokes access immediately. No other inbound credential is accepted (no HTTP Basic email:password, no human session token, no env service account). An admin enables MCP with a workspace toggle (Workspace settings → AI). Optionally protected by a shared `MCP_TOKEN`: when set, every `/mcp` request must carry a matching `X-MCP-Token` header (its own header, separate from `Authorization`, which carries the Bearer api_key). Note: this changed from the older `Authorization: Bearer <MCP_TOKEN>` scheme — see `.env.example` and the CHANGELOG Breaking Changes entry.
2. **AI agent chat** (`core/ai-chat/` server + `apps/client/src/features/ai-chat/` client). A built-in agent over the wiki using the Vercel **AI SDK** (`ai`, `@ai-sdk/*`) against any OpenAI-compatible provider configured per workspace (`integrations/ai/` — credentials encrypted at rest via `integrations/crypto`, stored in `ai_provider_credentials`). Key pieces:
   - `core/ai-chat/tools/` — the agent's ~40 read+write tools. Every tool runs under the **calling user's** CASL permissions via a per-user loopback access token (`docmost-client.loader.ts`), so the agent can never exceed what the user could do. Only **reversible** operations are exposed (page history + trash; no permanent delete). Agent edits get an "AI agent" provenance badge in page history (`20260616T130000-agent-provenance` migration).
   - `core/ai-chat/embedding/` — RAG indexer + a BullMQ consumer on `AI_QUEUE` that embeds pages into `page_embeddings` (vector search), complementing Postgres full-text search. Pages are (re)indexed on edit; `AI_EMBEDDING_TIMEOUT_MS` bounds a hung embeddings endpoint.
   - `core/ai-chat/external-mcp/` — admins can attach external MCP servers (e.g. Tavily) to give the agent web access. **`ssrf-guard.ts` validates outbound MCP URLs against SSRF** — keep that guard in the path when touching external-MCP connection logic.
   - `core/ai-chat/ai-chat-run.service.ts` + `ai_chat_runs` — **every agent turn is now a first-class server-side RUN** (`#184`, universalized in `#487`): its lifecycle is tracked in `ai_chat_runs` in **both** modes, and the single-active-run-per-chat concurrency gate is enforced universally (a legacy second tab now gets a clean `409 A_RUN_ALREADY_ACTIVE` instead of a second parallel stream that interleaved history). The per-workspace `settings.ai.autonomousRuns` flag (off by default) **no longer gates whether a turn is a run** — it now controls **only the browser-disconnect semantics**: when ON the run is *detached* (a disconnect leaves it executing server-side; only an explicit `POST /ai-chat/stop` ends it, and a client reconnects/live-follows via `POST /ai-chat/run`); when OFF (legacy) a disconnect ends the turn by stopping its run via the run's stop lever. `#487` also adds a server-side **supersede** CAS ("interrupt and send now") to `POST /ai-chat/stream` (`supersede: { runId }`): it atomically stops the chat's currently-active run and waits for it to settle before the new turn claims the slot, returning `SUPERSEDE_INVALID` / `SUPERSEDE_TARGET_MISMATCH` / `SUPERSEDE_TIMEOUT` on the non-proceed branches. **DEPLOY CONSTRAINT — single-instance only in phase 1:** Stop and the AbortController that backs it are process-local, so a Stop only aborts a run executing on the **same** replica that owns it (cross-instance pub/sub stop is phase 2). Do **not** enable `autonomousRuns` on a horizontally-scaled deployment (multiple replicas behind a load balancer, or Docmost cloud `CLOUD=true`) — run a single instance instead. The server logs a startup WARNING when it detects a multi-instance deployment (`CLOUD=true`) so the constraint is visible. The startup sweep settles any run left dangling by a restart.

### Client structure
Vite SPA. Code is organized by feature under `apps/client/src/features/*` (mirrors the server domains: `page`, `space`, `comment`, `ai-chat`, `editor`, …). Conventions:
- **TanStack Query** for server state (one `queries/` file per feature), **Jotai** atoms for local/shared UI state, **Mantine 8** + CSS modules (`*.module.css`) + `postcss-preset-mantine` for UI.
- The editor is Tiptap; shared node/mark extensions live in `packages/editor-ext` and are imported by **both the client and the server** (collaboration, schema, `canonicalizeFootnotes`) — editor schema changes often need to be made in `editor-ext`, not just the client. Server-side markdown import/export no longer lives in `editor-ext`: it goes through the canonical converter (#345, see below). The ProseMirror↔Markdown converter and its Docmost schema mirror now live in a SINGLE package, `@docmost/prosemirror-markdown` (#293), consumed by `mcp`, `git-sync`, `apps/server` (#345), and `apps/client` (#347) — do NOT reintroduce a per-package copy. The client uses the package's `browser` entry (`@docmost/prosemirror-markdown/browser`): markdown paste (`markdown-clipboard.ts`), copy-as-markdown, and AI-chat rendering now all go through the canonical converter, so the hand-written `marked`/`turndown` markdown layer that used to live in `editor-ext` was deleted (#347). The browser entry runs the HTML→DOM stage on the native `DOMParser`, so jsdom stays out of the client bundle. `editor-ext` is the upstream source of the Tiptap schema; the package's `docmost-schema.ts` mirrors it and a serializer-contract test (`packages/prosemirror-markdown/test/serializer-contract.test.ts`) guards the boundary (every schema node must have a converter case), so a drift surfaces as a failing test rather than silent divergence. For the converter's property-testing and counterexample→fixture process (P1–P4 invariants, the `PROPERTY_SEED`/`PROPERTY_NUM_RUNS` knobs, and the nightly fuzz workflow), see `packages/prosemirror-markdown/README.md`.
- API access goes through `apps/client/src/lib/api-client.ts` (axios). The `@` alias maps to `apps/client/src`.
- Runtime config is injected at build time by `vite.config.ts` via `define` (`APP_URL`, `COLLAB_URL`, `APP_VERSION`, …) — these come from the root `.env`, not from `import.meta.env`.
- The build also emits `client/dist/version.json` (`{"version": …}`) from a small `vite.config.ts` plugin using the **same** `appVersion` that feeds `define.APP_VERSION`, so the file and the baked-in bundle version are identical by construction. The server reads it at startup (`ws.gateway.ts` via `readClientBuildVersion`/`resolveClientDistPath`) and announces it to each socket on connect (`app-version` event) so a tab left open across a redeploy can guard-reload before hitting a stale chunk (version-coherence). No runtime env / Dockerfile change — the file already ships in `client/dist`; missing/empty file ⇒ feature inert.

## Conventions

- **Code comments must be in English.**
- **Errors must never be swallowed or shown as generic messages.** Every caught error MUST (1) be logged in full to the console/logger — error name, message, stack, `cause`, and (for HTTP/provider failures) the status code and response body — and (2) be surfaced to the user with a *specific, human-readable explanation of what actually went wrong*, never a bare generic string like "Something went wrong" / "Could not start recording" / "Transcription failed". Include the real reason (the underlying error/provider message) in the user-facing text. On the server, wrap third-party/provider failures with `describeProviderError` (or equivalent) and rethrow as a meaningful HTTP status + message — never let them collapse into an opaque 500. On the client, `console.error(<context>, err)` the raw error AND show the extracted reason (e.g. `err.response?.data?.message`, or the error `name: message`) in the notification.
- The version string shown in the UI comes from `APP_VERSION` (CI/Docker) or `git describe --tags --always` (local), resolved in `vite.config.ts` — not from `package.json`.
- Server TS config is permissive (`noImplicitAny: false`, `strictNullChecks: false`, `no-explicit-any` lint disabled). Follow the existing relaxed style rather than tightening types broadly.
- Dependency versions are heavily pinned via `pnpm.overrides` and `pnpm.patchedDependencies` (`scimmy`, `yjs`, `ai`) in the root `package.json`. Don't bump pinned/patched deps casually; the patches and overrides exist for compatibility/security reasons. The `ai@6.0.134` patch carries TWO independent server fixes, each with its own tripwire test: (1) it disables the SDK's O(n²) cumulative `partialOutput` accumulation when no output strategy is requested (server heap OOM on long agent runs, #184; tripwire: `apps/server/src/integrations/ai/ai-sdk-partial-output.patch.spec.ts`); (2) it fixes `writeToServerResponse`'s drain-hang — the loop awaited only `"drain"` under backpressure, so a mid-write client disconnect parked the pipe forever and leaked the reader/buffers until restart; it now races `"drain"` against `"close"`/`"error"`, cancels the reader on disconnect, and swallows the fire-and-forget read rejection (#486; tripwire: `apps/server/src/integrations/ai/ai-sdk-drain-hang.patch.spec.ts`). Both tripwires assert BOTH installed dist builds carry their patch marker. The patch MUST be re-created via `pnpm patch` when bumping `ai`.
  - **Upstream tracking (report the analysis upstream, don't just carry it):** both `ai` fixes and the hocuspocus one are candidates for upstreaming so we can eventually drop the local patch — the analysis is already written up in each patch's `PATCH(...)` header comments. File (a) an upstream **issue** on `vercel/ai` for the O(n²) cumulative `partialOutput` accumulation (heap OOM), (b) an upstream **issue** on `vercel/ai` for the `writeToServerResponse` drain-hang, and (c) an upstream **PR** on `@hocuspocus/server` for the connect-vs-unload race (local marker `PATCH(gitmost #401)` in `patches/@hocuspocus__server@3.4.4.patch`). Do NOT edit the patch files to add links — the patch bytes feed `patch_hash` in `pnpm-lock.yaml` (`ai@6.0.134` → `e8c599b3…`), so any content change there desyncs the lockfile pin and breaks `pnpm install`; keep upstream references here instead.
  - **`ai` version is split across the monorepo and MUST be aligned deliberately, NOT casually:** the server pins `ai@6.0.134` (patched, exact — the `patchedDependencies` key forces that version), while the client declares `ai@6.0.207` (unpatched — the server-side `writeToServerResponse`/`partialOutput` fixes are dead code in the browser, so the mismatch is currently benign but is real drift). Alignment is a **planned, install-gated step**, never a bare `package.json` edit: (1) choose the target version; (2) re-create ALL THREE patch hunks (partialOutput publish-each, the `DefaultStreamTextResult` lazy-`output` wiring, and the drain-hang race) against the target dist via `pnpm patch` — the line offsets shift between versions, so the current patch WILL fail to apply as-is; (3) run a full `pnpm install` so the lockfile + new `patch_hash` regenerate together; (4) confirm both tripwire specs still find their markers. `pnpm install` FAILS HARD on an unapplied patch — that failure is the guardrail, so treat the port as a deliberate plan rather than discovering it as a deploy-time surprise.
- **The MCP tool inventory in `SERVER_INSTRUCTIONS` is GENERATED from the registry** (`packages/mcp/src/server-instructions.ts`: `buildToolInventory()` over `SHARED_TOOL_SPECS`) and spliced into the hand-written routing prose (`ROUTING_PROSE`). So adding/renaming/removing a **shared** spec in `packages/mcp/src/tool-specs.ts` auto-updates the `<tool_inventory>` — no manual `SERVER_INSTRUCTIONS` edit needed. Only an **inline** MCP-only tool (those registered via `server.registerTool(...)` in `index.ts`, not through the registry) needs a one-line entry in `INLINE_MCP_INVENTORY`. Enforced by `packages/mcp/test/unit/tool-inventory.test.mjs`, which fails when a registered tool is missing from the generated inventory (there is no `EXCEPTIONS` opt-out anymore — every tool must appear). Update `ROUTING_PROSE` when a tool's *intent guidance* (when-to-use) changes. `packages/mcp/build/` is gitignored and rebuilt in CI/Docker via `pnpm build` (same convention as `git-sync`/`prosemirror-markdown`) — never commit it; rebuild locally after editing to run the tests.

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
