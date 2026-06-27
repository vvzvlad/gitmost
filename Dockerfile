FROM node:22-slim AS base
LABEL org.opencontainers.image.source="https://github.com/vvzvlad/gitmost"

RUN npm install -g pnpm@10.4.0

FROM base AS builder

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

# Copy root package files
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/pnpm*.yaml /app/
COPY --from=builder /app/.npmrc /app/.npmrc

# Copy patches
COPY --from=builder /app/patches /app/patches

RUN chown -R node:node /app

USER node

RUN pnpm install --frozen-lockfile --prod

RUN mkdir -p /app/data/storage

VOLUME ["/app/data/storage"]

EXPOSE 3000

CMD ["pnpm", "start"]
