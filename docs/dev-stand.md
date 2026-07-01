# Running a local dev stand

How to bring up a working local instance (API + client + realtime collaboration)
and the non-obvious gotchas that will otherwise eat an hour. Written from real
setup pain — read the **Gotchas** section before you start.

## Prerequisites

- **Node 20+ / pnpm 10+.**
- **Postgres with pgvector.** Use the `pgvector/pgvector` image (e.g.
  `pgvector/pgvector:pg18`). The stock `postgres` image will FAIL the
  `CREATE EXTENSION vector` migration — the RAG feature stores embeddings in
  `page_embeddings`.
- **Redis** — backs caching, BullMQ queues, the Socket.IO adapter, and collab
  sync.

## 1. Environment (`.env`)

The client (`apps/client/vite.config.ts`) and both server processes read env via
`envPath` → the **workspace root `.env`**. Keep a single source of truth. Minimum:

```dotenv
APP_URL=http://localhost:3000
PORT=3000
APP_SECRET=<one long secret — SAME value everywhere, see gotcha #3>
DATABASE_URL="postgresql://<user>:<pass>@localhost:5432/<db>?schema=public"
REDIS_URL=redis://127.0.0.1:6379
COLLAB_URL=http://localhost:3001      # where the CLIENT connects for realtime
COLLAB_PORT=3001                      # where the COLLAB server listens
STORAGE_DRIVER=local
DISABLE_TELEMETRY=true
```

> If you also keep an `apps/server/.env`, its `APP_SECRET` **must match** the
> root one (see gotcha #3).

## 2. Migrations

Migrations do **not** auto-run in local dev. After a fresh checkout or switching
branches, apply them yourself or endpoints touching a new column/table will 500:

```bash
pnpm --filter server migration:latest
```

## 3. Bring it up — THREE processes, not two

`pnpm dev` starts only the **API server** (Nest, `:3000`) and the **client**
(Vite). Realtime collaboration is a **separate process** and `pnpm dev` does NOT
start it. You need all three:

```bash
# 1) API + client (from the repo root)
pnpm dev
#    → API   http://localhost:3000
#    → client http://localhost:5173  (Vite; localhost-only by default)

# 2) Collaboration server — SEPARATE process. Build first (see gotcha #2), then:
pnpm --filter server build          # produces dist/collaboration/server/collab-main.js
pnpm collab:dev                     # node dist/.../collab-main → listens on :3001 (0.0.0.0)
```

Without step 2 the editor shows **"Real-time editor connection lost. Retrying…"**,
stays in read-only *static* mode, and anything that only mounts in the *live*
editor won't appear.

## Seeding a login

Register through the UI, or reset an existing user's password directly in the DB
(the server hashes with `bcrypt`):

```js
// node -e '...'  with pg + bcrypt from the repo's node_modules
const bcrypt = require("bcrypt");
const { Client } = require("pg");
(async () => {
  const hash = await bcrypt.hash("demopass", 10);
  const c = new Client({ /* DATABASE_URL parts */ });
  await c.connect();
  await c.query("update users set password=$1 where email=$2", [hash, "admin@example.com"]);
  await c.end();
})();
```

> **Use a simple one-word password with no special characters** (e.g. `demopass`,
> not `Str0ng!Pass@2026`). Demo/test credentials get passed through shells, JSON
> payloads, and URLs by scripts and automation, where `!` `@` `$` `&` etc. get
> mangled or need escaping — a plain alphanumeric word avoids a whole class of
> "wrong password" confusion.

## Gotchas (the грабли)

1. **Collaboration is a third process.** `pnpm dev` runs API + client only.
   Start `pnpm collab:dev` (on `:3001`) separately or the live editor never
   connects. The client connects to `COLLAB_URL` directly (default
   `http://localhost:3001`), NOT through the Vite `/collab` proxy — the API
   server on `:3000` does **not** serve the collab websocket.

2. **The collab server must be built — you can't run it from source.**
   `collab:dev` runs `node dist/collaboration/server/collab-main.js`, so run
   `pnpm --filter server build` first. Running the entry via `tsx`/`ts-node`
   fails with a NestJS DI error ("dependency … appears to be undefined at
   runtime") because direct TS execution doesn't emit the decorator metadata the
   built output has.

3. **`APP_SECRET` must be identical for the API server and the collab server.**
   The API issues a collab-token (JWT signed with `APP_SECRET`); the collab
   server validates it with `APP_SECRET`. If they load different values (e.g. a
   root `.env` and an `apps/server/.env` with different secrets), every realtime
   connection is rejected with **`[onAuthenticate] Invalid collab token`** and
   the editor shows "connection lost". Keep one secret everywhere.

4. **Vite binds localhost only.** To reach the stand from another machine on the
   LAN, start the client with `--host` (`pnpm --filter client exec vite --host`)
   and use the box's LAN IP. The `/api`, `/socket.io`, and `/collab` Vite proxies
   forward to `APP_URL`, so the API just works over the LAN; realtime needs
   `COLLAB_URL` reachable from the browser (point it at the LAN IP:3001, and run
   collab on `0.0.0.0` — it does by default).

5. **A stale `@docmost/editor-ext` white-screens the client.** The client imports
   from `@docmost/editor-ext` (a workspace package). If that package's source is
   behind (missing a newer export, e.g. `Spoiler`), the client dies at load with
   *"The requested module … does not provide an export named 'Spoiler'"* → blank
   page. Make sure the workspace `packages/editor-ext` is current for the branch
   you're running (a stale sibling checkout resolved through a shared
   `node_modules` symlink is the usual cause).

6. **pgvector, not stock postgres** (see Prerequisites) — the `vector` extension
   migration fails otherwise.

7. **Migrations don't auto-run in dev** — run `migration:latest` after every pull
   or branch switch.

See also the **Commands** and **Architecture → Two server processes** sections in
[`AGENTS.md`](../AGENTS.md).
