#!/usr/bin/env bash
#
# git-sync end-to-end test suite.
#
# Exercises the FULL two-way sync against a LIVE gitmost server over the real
# smart-HTTP /git remote: clone (fetch), push (git -> Docmost), Docmost -> git,
# delete -> trash, the 3-way body merge, and the auth/authz gate. This is the
# integration counterpart to the unit suites — it boots nothing itself; it drives
# a running stand.
#
# Prerequisites (a running git-sync stand):
#   - server up at $SERVER with GIT_SYNC_ENABLED=true + GIT_SYNC_HTTP_ENABLED=true
#     and a configured GIT_SYNC_SERVICE_USER_ID;
#   - a space whose settings.gitSync.enabled = true ($SPACE_ID);
#   - an admin user ($EMAIL/$PASSWORD) who is a member of that space;
#   - the Postgres container reachable for DB assertions ($DB_CONTAINER).
#
# Usage:  apps/server/test/git-sync-e2e.sh
# Override any of the env vars below to point at a different stand.
set -uo pipefail

SERVER="${SERVER:-http://localhost:3000}"
# By default the suite PROVISIONS its own throwaway space (so it never touches
# real data). Set SPACE_ID explicitly to run against an existing space instead.
SPACE_ID="${SPACE_ID:-}"
EMAIL="${EMAIL:-admin@test.local}"
PASSWORD="${PASSWORD:-Test12345!}"
DB_CONTAINER="${DB_CONTAINER:-gitmost-db}"
DB_USER="${DB_USER:-docmost}"
DB_NAME="${DB_NAME:-docmost}"

BASIC=$(printf '%s:%s' "$EMAIL" "$PASSWORD" | base64 -w0)
GIT_URL=""        # set once the space is known (after login/provisioning)
PROVISIONED=""    # the space id we created (and must delete on exit), if any
WORK=$(mktemp -d /tmp/git-sync-e2e.XXXXXX)
COOKIES="$WORK/cookies.txt"
PASS=0
FAIL=0

cleanup() {
  # Delete the throwaway space we created (cascades its pages); never touch a
  # caller-supplied space beyond our own E2E-* fixtures.
  if [ -n "$PROVISIONED" ]; then
    docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
      "delete from pages where space_id='$PROVISIONED'; delete from spaces where id='$PROVISIONED';" >/dev/null 2>&1
    rm -rf "/tmp/gitmost-vaults/$PROVISIONED" 2>/dev/null
  elif [ -n "$SPACE_ID" ]; then
    docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
      "delete from pages where space_id='$SPACE_ID' and title like 'E2E-%';" >/dev/null 2>&1
    curl -s -b "$COOKIES" -X POST "$SERVER/api/git-sync/trigger" \
      -H 'Content-Type: application/json' -d "{\"spaceId\":\"$SPACE_ID\"}" >/dev/null 2>&1
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }

gitc() { git -c http.extraHeader="Authorization: Basic $BASIC" "$@"; }
# Push retrying on 503 — the host returns 503+Retry-After when a sync cycle holds
# the per-space lock (a real client retries; so do we, to dodge poll races).
gpush() { local out; for _ in 1 2 3 4 5 6; do out=$(gitc push -q origin main 2>&1); echo "$out" | grep -q '503\|busy' && { sleep 2; continue; }; return 0; done; return 1; }
psqlq() { docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc "$1" 2>/dev/null; }
api()  { curl -s -b "$COOKIES" "$@"; }

# Force one synchronous sync cycle and return when it has applied.
sync_now() {
  api -X POST "$SERVER/api/git-sync/trigger" -H 'Content-Type: application/json' \
    -d "{\"spaceId\":\"$SPACE_ID\"}" >/dev/null
}

# ----------------------------------------------------------------------------
say "auth: login as the admin"
code=$(curl -s -o /dev/null -w '%{http_code}' -c "$COOKIES" -X POST \
  "$SERVER/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
[ "$code" = "200" ] && ok "login 200" || { bad "login returned $code"; exit 1; }

# ----------------------------------------------------------------------------
if [ -z "$SPACE_ID" ]; then
  say "setup: provision a throwaway git-sync space (never touches real data)"
  slug="e2e$(date +%s)$RANDOM"
  SPACE_ID=$(api -X POST "$SERVER/api/spaces/create" -H 'Content-Type: application/json' \
    -d "{\"name\":\"E2E Throwaway $slug\",\"slug\":\"$slug\"}" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [ -n "$SPACE_ID" ]; then
    PROVISIONED="$SPACE_ID"
    psqlq "update spaces set settings = coalesce(settings,'{}'::jsonb) || '{\"gitSync\":{\"enabled\":true}}'::jsonb where id='$SPACE_ID';" >/dev/null
    ok "provisioned space $SPACE_ID"
  else
    bad "could not provision a test space"; exit 1
  fi
fi
GIT_URL="$SERVER/git/$SPACE_ID.git"

# ----------------------------------------------------------------------------
say "gate: smart-HTTP auth/authz"
code=$(curl -s -o /dev/null -w '%{http_code}' "$GIT_URL/info/refs?service=git-upload-pack")
[ "$code" = "401" ] && ok "no credentials -> 401" || bad "no creds expected 401, got $code"

code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Basic $(printf '%s:wrong' "$EMAIL" | base64 -w0)" \
  "$GIT_URL/info/refs?service=git-upload-pack")
[ "$code" = "401" ] && ok "wrong password -> 401" || bad "wrong creds expected 401, got $code"

code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Basic $BASIC" \
  "$SERVER/git/00000000-0000-0000-0000-000000000000.git/info/refs?service=git-upload-pack")
[ "$code" = "404" ] && ok "unknown space -> 404 (existence not revealed)" || bad "unknown space expected 404, got $code"

code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Basic $BASIC" \
  "$GIT_URL/info/refs?service=git-upload-pack")
[ "$code" = "200" ] && ok "valid creds + sync space -> 200" || bad "valid clone gate expected 200, got $code"

# ----------------------------------------------------------------------------
# A DEDICATED test page so the push/merge edits never touch a real page, and so
# a freshly-provisioned (empty) space has content for the fetch test below.
say "setup: create a dedicated test page (edits target only this one)"
TEST_TITLE="E2E-SyncTarget-$RANDOM$RANDOM"
TEST_ID=$(api -X POST "$SERVER/api/pages/create" -H 'Content-Type: application/json' \
  -d "{\"spaceId\":\"$SPACE_ID\",\"title\":\"$TEST_TITLE\"}" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$TEST_ID" ] && ok "created test page $TEST_TITLE" || { bad "could not create the test page"; }
sync_now

# ----------------------------------------------------------------------------
say "fetch: clone the space vault over HTTP"
sync_now
if gitc clone -q "$GIT_URL" "$WORK/clone" 2>/dev/null; then
  count=$(find "$WORK/clone" -maxdepth 1 -name '*.md' | wc -l)
  [ "$count" -ge 1 ] && ok "clone succeeded with $count markdown file(s)" || bad "clone has no .md files"
else
  bad "clone failed"
fi

# ----------------------------------------------------------------------------
say "push: a git edit propagates into the (dedicated) Docmost page"
rm -rf "$WORK/cpush"; gitc clone -q "$GIT_URL" "$WORK/cpush" 2>/dev/null
cd "$WORK/cpush" || exit 1
git config user.email e2e@test >/dev/null; git config user.name e2e >/dev/null
target=$(grep -rl "$TEST_ID" --include='*.md' . | head -1)
if [ -n "$target" ]; then
  MARK="E2E-PUSH-$RANDOM$RANDOM"
  printf '\n## %s\n' "$MARK" >> "$target"
  git commit -aqm "e2e push: $MARK"
  if gpush; then
    sleep 2
    has=$(psqlq "select count(*) from pages where id='$TEST_ID' and content::text like '%$MARK%';")
    [ "${has:-0}" -ge 1 ] && ok "pushed edit reached the test page" || bad "marker $MARK not in the test page content"
  else
    bad "git push failed"
  fi
else
  bad "test page .md not found in the clone"
fi
cd "$WORK" || exit 1

# ----------------------------------------------------------------------------
say "Docmost -> git: a page created in Docmost appears in the vault"
NEW_TITLE="E2E-Created-$RANDOM"
new_id=$(api -X POST "$SERVER/api/pages/create" -H 'Content-Type: application/json' \
  -d "{\"spaceId\":\"$SPACE_ID\",\"title\":\"$NEW_TITLE\"}" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -n "$new_id" ]; then
  sync_now
  rm -rf "$WORK/clone2"
  gitc clone -q "$GIT_URL" "$WORK/clone2" 2>/dev/null
  if find "$WORK/clone2" -name "*$NEW_TITLE*.md" | grep -q .; then
    ok "new Docmost page '$NEW_TITLE' materialized as a vault file"
  else
    bad "created page '$NEW_TITLE' did not appear in the vault"
  fi
else
  bad "could not create a page via the API"
fi

# ----------------------------------------------------------------------------
say "delete: removing a file via git soft-deletes the Docmost page"
cd "$WORK/clone2" 2>/dev/null || cd "$WORK/clone" || exit 1
git config user.email e2e@test >/dev/null; git config user.name e2e >/dev/null
delfile=$(find . -maxdepth 1 -name "*$NEW_TITLE*.md" | head -1)
if [ -n "$delfile" ]; then
  git rm -q "$delfile"
  git commit -qm "e2e delete: $NEW_TITLE"
  if gpush; then
    sleep 2
    deleted=$(psqlq "select count(*) from pages where space_id='$SPACE_ID' and title='$NEW_TITLE' and deleted_at is not null;")
    [ "${deleted:-0}" -ge 1 ] && ok "page '$NEW_TITLE' was soft-deleted (in Trash)" || bad "page '$NEW_TITLE' not soft-deleted after git rm"
  else
    bad "push (delete) failed"
  fi
else
  bad "delete target file not found in clone"
fi
cd "$WORK" || exit 1

# ----------------------------------------------------------------------------
say "3-way merge: a git edit to one part keeps the rest of the (test) page"
# Re-clone fresh, append a second unique line to the SAME dedicated page, push,
# then confirm BOTH markers coexist — the body merge did not clobber the first.
rm -rf "$WORK/cmerge"
gitc clone -q "$GIT_URL" "$WORK/cmerge" 2>/dev/null
cd "$WORK/cmerge" || exit 1
git config user.email e2e@test >/dev/null; git config user.name e2e >/dev/null
mfile=$(grep -rl "$TEST_ID" --include='*.md' . | head -1)
if [ -n "$mfile" ]; then
  MARK2="E2E-MERGE-$RANDOM$RANDOM"
  printf '\n## %s\n' "$MARK2" >> "$mfile"
  git commit -aqm "e2e merge: $MARK2"
  if gpush; then
    sleep 2
    both=$(psqlq "select count(*) from pages where id='$TEST_ID' and content::text like '%$MARK2%' and content::text like '%E2E-PUSH-%';")
    [ "${both:-0}" -ge 1 ] && ok "new edit added without losing prior content (3-way merge)" || bad "3-way merge lost content (both markers not present)"
  else
    bad "push (merge) failed"
  fi
else
  bad "test page .md not found in the clone"
fi
cd "$WORK" || exit 1

# ----------------------------------------------------------------------------
say "RESULTS: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
