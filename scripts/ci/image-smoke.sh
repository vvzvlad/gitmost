#!/usr/bin/env bash
# Boot-smoke for the exact Docker image that is about to be pushed (issue #476).
#
# Retrospective class "local logic is right, the integration property was never
# checked" (#353/#452/#361): every other CI job builds and tests code from the
# working tree, but the IMAGE watchtower pulls was never actually started
# anywhere before this gate. This script boots the built image against the
# publish job's postgres/redis services and asserts four integration
# properties end-to-end:
#   S1  the app boots and /api/health answers (startup migrator + boot)
#   S2  the first-run workspace setup endpoint works (API + DB writes)
#   S3  the client dist is inside the image and served
#   S4  hashed assets are served immutable (#452) with the precompressed
#       brotli copy shipped in the image
set -euo pipefail

IMAGE="${1:?usage: image-smoke.sh <image>}"

fail() { echo "FAIL: $*"; exit 1; }

# Boot the exact image that will be pushed, wired to the job services via host
# network (postgres on localhost:5432, redis on localhost:6379). The container
# is deliberately NOT removed on failure so the workflow's dump-on-failure step
# can read `docker logs gitmost-smoke`.
docker run -d --name gitmost-smoke --network host \
  -e DATABASE_URL=postgresql://docmost:docmost@localhost:5432/docmost \
  -e REDIS_URL=redis://localhost:6379 \
  -e APP_SECRET=ci-smoke-secret-change-me-min-32-characters \
  -e APP_URL=http://localhost:3000 \
  "$IMAGE"

# S1: wait for /api/health — covers the startup migrator + boot inside the
# shipped image (#361-boot, #353 runtime class): a migration the Kysely startup
# migrator rejects, or a runtime module missing from the image, dies right here.
healthy=0
for _ in $(seq 1 60); do
  if curl -fsS http://localhost:3000/api/health > /dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 2
done
[ "$healthy" -eq 1 ] || fail "S1: /api/health did not answer within 120s (boot or startup migration failed)"
echo "OK S1: image booted and /api/health answers"

# S2: the first-run workspace setup works end-to-end (controller -> service ->
# DB write chain inside the shipped image, not just a static health probe).
curl -fsS -X POST http://localhost:3000/api/auth/setup \
  -H "Content-Type: application/json" \
  -d '{"name":"Smoke","email":"smoke@example.com","password":"SmokePassword123","workspaceName":"Smoke"}' \
  > /dev/null || fail "S2: POST /api/auth/setup failed"
echo "OK S2: workspace setup succeeded"

# S3: the client dist is actually inside the image and served — the SPA HTML
# must reference hashed /assets/ bundles (a broken client COPY in the
# Dockerfile would serve an empty shell that every other job stays green on).
HTML=$(curl -fsS http://localhost:3000/) || fail "S3: fetching / failed"
grep -q '/assets/' <<<"$HTML" || fail "S3: served HTML references no /assets/ bundle (client dist missing from the image?)"
echo "OK S3: client dist served (HTML references /assets/)"

# S4: hashed /assets/ files must be served with an immutable cache-control
# (#452 class: static.module.ts resolveStaticAssetHeaders owns the header) AND
# with the precompressed brotli neighbour. Both checks are mandatory — verified
# against the code: resolveStaticAssetHeaders marks every /assets/ path
# immutable, and the client build (vite-plugin-compression2, include covers
# .js) emits a .br copy next to every bundle that the Dockerfile ships and
# @fastify/static serves via preCompressed:true.
ASSET=$(grep -oE '/assets/[A-Za-z0-9._@/-]+\.js' <<<"$HTML" | head -1 || true)
[ -n "$ASSET" ] || fail "S4: no /assets/*.js path found in the served HTML"
HDRS=$(curl -fsSI -H 'Accept-Encoding: br' "http://localhost:3000$ASSET") || fail "S4: HEAD $ASSET failed"
grep -qi '^cache-control:.*immutable' <<<"$HDRS" || fail "S4: $ASSET served without an immutable cache-control (#452)"
echo "OK S4: hashed asset served with immutable cache-control"
grep -qi '^content-encoding:.*br' <<<"$HDRS" || fail "S4: $ASSET not served brotli-precompressed (content-encoding: br missing)"
echo "OK S4: hashed asset served with the precompressed brotli copy"

# S5: the ~700KB Lucide icon catalog (#696) must stay in its OWN lazy chunk and
# NEVER be pulled into an eager bundle referenced by index.html — a single static
# import anywhere in the eager graph would drag it into the entry bundle. We
# assert a sentinel string that exists ONLY in the catalog data ("firefighter",
# a lucide tag of the `flame` icon) is absent from every eager /assets/*.js the
# served HTML references. Fetched without `Accept-Encoding: br` so the body is
# plain text to grep.
SENTINEL="firefighter"
mapfile -t EAGER_JS < <(grep -oE '/assets/[A-Za-z0-9._@/-]+\.js' <<<"$HTML" | sort -u)
[ "${#EAGER_JS[@]}" -gt 0 ] || fail "S5: no eager /assets/*.js found in the served HTML"
for JS in "${EAGER_JS[@]}"; do
  BODY=$(curl -fsS "http://localhost:3000$JS") || fail "S5: GET $JS failed"
  if grep -q "$SENTINEL" <<<"$BODY"; then
    fail "S5: eager bundle $JS contains the catalog sentinel '$SENTINEL' — the Lucide catalog leaked into an eager chunk (must be a lazy import only)"
  fi
done
echo "OK S5: Lucide catalog is not present in any eager bundle (#696)"

# Remove the container ONLY on success, so the failure path keeps it around for
# the workflow's "Dump smoke container log on failure" step.
docker rm -f gitmost-smoke > /dev/null
echo "OK image smoke passed"
