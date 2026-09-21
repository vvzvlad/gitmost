FROM node:22-slim AS base
LABEL org.opencontainers.image.source="https://github.com/vvzvlad/gitmost"

RUN npm install -g pnpm@10.4.0

FROM base AS builder

# re2 (packages/mcp) always compiles from source under pnpm (the prebuilt-binary
# download cannot identify the GitHub repo), so node-gyp needs python3/make/g++.
# This stage is discarded, so the toolchain can stay installed.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . .

RUN pnpm install --frozen-lockfile
# Version string shown in the UI (computed outside Docker because .git is not in the build context).
ARG APP_VERSION=""
ENV APP_VERSION=$APP_VERSION
RUN pnpm build

FROM base AS installer

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl bash \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Agent-roles catalog base URL: per-branch default set at build time (CI);
# overridable at runtime via the AI_AGENT_ROLES_CATALOG_URL env var.
ARG AI_AGENT_ROLES_CATALOG_URL=""
ENV AI_AGENT_ROLES_CATALOG_URL=$AI_AGENT_ROLES_CATALOG_URL

# Copy apps
COPY --from=builder /app/apps/server/dist /app/apps/server/dist
COPY --from=builder /app/apps/client/dist /app/apps/client/dist
COPY --from=builder /app/apps/server/package.json /app/apps/server/package.json

# Copy packages
COPY --from=builder /app/packages/editor-ext/dist /app/packages/editor-ext/dist
COPY --from=builder /app/packages/editor-ext/package.json /app/packages/editor-ext/package.json
COPY --from=builder /app/packages/mcp/build /app/packages/mcp/build
COPY --from=builder /app/packages/mcp/package.json /app/packages/mcp/package.json
# The mcp package reads its data files (drawio-presets.json, drawio-shape-index.json.gz)
# at runtime via `new URL("../../data/…", import.meta.url)` relative to build/lib/*.js,
# i.e. from packages/mcp/data/. tsc emits only build/, so ship data/ explicitly or
# drawioFromGraph and the shape catalog die with ENOENT on packages/mcp/data/*.
COPY --from=builder /app/packages/mcp/data /app/packages/mcp/data
# mcp now depends on @docmost/prosemirror-markdown (workspace:*) and eager-imports
# it at runtime (the in-app ai-chat DocmostClient loads build/index.js -> lib/
# markdown-converter.js). Ship the built package + its manifest, or the prod
# install resolves a broken workspace symlink and every ai-chat tool dies with
# ERR_MODULE_NOT_FOUND (#293/#326 step 5). (git-sync has no runtime consumer yet;
# revisit at step 6 when #119 lands.)
COPY --from=builder /app/packages/prosemirror-markdown/build /app/packages/prosemirror-markdown/build
COPY --from=builder /app/packages/prosemirror-markdown/package.json /app/packages/prosemirror-markdown/package.json

# apps/server imports @docmost/token-estimate (workspace:*) at runtime
# (history-budget.ts, #490). tsc emits only dist/ and dist/ is gitignored, so the
# prod install would resolve a broken workspace symlink and the server would die
# with ERR_MODULE_NOT_FOUND on the first history-budget call. Ship the built
# package + its manifest, mirroring prosemirror-markdown above.
COPY --from=builder /app/packages/token-estimate/dist /app/packages/token-estimate/dist
COPY --from=builder /app/packages/token-estimate/package.json /app/packages/token-estimate/package.json

# Copy root package files
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/pnpm*.yaml /app/
COPY --from=builder /app/.npmrc /app/.npmrc

# Copy patches
COPY --from=builder /app/patches /app/patches

RUN chown -R node:node /app

# Toolchain is needed transiently to compile re2 during the prod install; install
# and purge it in one layer to keep the final image slim. The install itself runs
# as the node user via su to keep node_modules ownership without a costly chown layer.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && su node -c "pnpm install --frozen-lockfile --prod" \
  && apt-get purge -y --auto-remove python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

USER node

RUN mkdir -p /app/data/storage

VOLUME ["/app/data/storage"]

EXPOSE 3000

# DEPLOY REQUIREMENT — SINGLE INSTANCE or STICKY SESSIONS (#449).
# MCP content writes are serialized per page by an IN-PROCESS mutex, and the
# stash_page blob store + cached collab sessions are RAM-only and process-local.
# Running MULTIPLE replicas of this image behind a load balancer WITHOUT sticky
# sessions silently breaks per-page write serialization (two replicas can lock
# the same page at once) and makes stash_page blobs unreachable across replicas.
# Run a SINGLE instance, or pin each page's traffic to one replica (sticky
# sessions / consistent hashing on page id). There is deliberately no
# cross-process lock yet — a conscious constraint. See .env.example (the "MCP
# collaboration write path" block) and packages/mcp/README.md for details.
CMD ["pnpm", "start"]
