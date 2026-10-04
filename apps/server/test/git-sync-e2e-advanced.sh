#!/usr/bin/env bash
#
# git-sync ADVANCED end-to-end suite — authz, protocol hardening, concurrency,
# and structural sync (rename / reparent / delete-cap), driven against a LIVE
# stand. Companion to git-sync-e2e.sh (the basic two-way flows). These cases
# need deeper hooks than a plain clone:
#   - the vault working repo on the host ($VAULT_DIR/<spaceId>) for ref/SHA asserts,
#   - the Redis container ($REDIS_CONTAINER) to inject a held lock (503 path),
#   - DB-created fixture users / a second space (auto-created + torn down).
#
# Came out of a generate->critique subagent pass on "what is NOT covered". The
# critic verified the contracts against the code (e.g. a non-member of an
# ENABLED space gets 403, not 404 — only a missing / sync-disabled space 404s).
#
# Usage:  apps/server/test/git-sync-e2e-advanced.sh
set -uo pipefail

SERVER="${SERVER:-http://localhost:3000}"
# By default the suite PROVISIONS its own throwaway space (never touches real
# data). Set SPACE_ID explicitly to run against an existing space instead.
SPACE_ID="${SPACE_ID:-}"
EMAIL="${EMAIL:-admin@test.local}"
PASSWORD="${PASSWORD:-Test12345!}"
DB_CONTAINER="${DB_CONTAINER:-gitmost-db}"
DB_USER="${DB_USER:-docmost}"
DB_NAME="${DB_NAME:-docmost}"
REDIS_CONTAINER="${REDIS_CONTAINER:-gitmost-redis}"
VAULT_DIR="${VAULT_DIR:-/tmp/gitmost-vaults}"
LOCK_PREFIX="git-sync:lock:"

BASIC=$(printf '%s:%s' "$EMAIL" "$PASSWORD" | base64 -w0)
GIT_URL=""        # set once the space is known (after login/provisioning)
VAULT=""          # ditto
PROVISIONED=""    # the space id we created (and must delete on exit), if any
WORK=$(mktemp -d /tmp/git-sync-adv.XXXXXX)
COOKIES="$WORK/cookies.txt"
PASS=0; FAIL=0
READER_ID=""; OUTSIDER_ID=""; SPACE2_ID=""

say(){ printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok(){ printf '  \033[32mPASS\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad(){ printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
psqlq(){ docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc "$1" 2>/dev/null | tr -d '[:space:]'; }
api(){ curl -s -b "$COOKIES" "$@"; }
gitc(){ git -c http.extraHeader="Authorization: Basic $BASIC" "$@"; }
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }      # print HTTP status
basicfor(){ printf '%s:%s' "$1" "$PASSWORD" | base64 -w0; }
sync_now(){ api -X POST "$SERVER/api/git-sync/trigger" -H 'Content-Type: application/json' -d "{\"spaceId\":\"$SPACE_ID\"}" >/dev/null; }
vault_sha(){ git -C "$VAULT" rev-parse "$1" 2>/dev/null; }
# Push retrying on 503 — the smart-HTTP host returns 503+Retry-After when a sync
# cycle holds the lock (a real git client retries; so do we, to dodge poll races).
gpush(){ local out; for _ in $(seq 1 6); do out=$(gitc push origin main 2>&1); echo "$out" | grep -q '503\|busy' && { sleep 2; continue; }; return 0; done; return 1; }

teardown(){
  # Hard-delete fixtures by EMAIL/NAME pattern (robust against a mid-run abort
  # that never captured an id), so the stand + the basic suite stay clean.
  psqlq "delete from space_members where user_id in (select id from users where email like 'e2e-adv-%@test.local');
         delete from users where email like 'e2e-adv-%@test.local';
         delete from spaces where name like 'E2E-ADV-%';
         delete from pages where space_id='$SPACE_ID' and title like 'E2E-ADV-%';" >/dev/null
  docker exec "$REDIS_CONTAINER" redis-cli del "${LOCK_PREFIX}${SPACE_ID}" >/dev/null 2>&1
  # Delete the throwaway space we created (cascades pages); the delete-cap case
  # leaves the vault non-convergent, so dropping the whole space + its vault is
  # the clean teardown. (When run against a caller-supplied space, only reset the
  # vault — the fixtures above were already removed by pattern.)
  if [ -n "$PROVISIONED" ]; then
    psqlq "delete from pages where space_id='$PROVISIONED'; delete from spaces where id='$PROVISIONED';" >/dev/null
  fi
  [ -n "$VAULT" ] && rm -rf "$VAULT"
  [ -z "$PROVISIONED" ] && [ -n "$SPACE_ID" ] && sync_now
  rm -rf "$WORK"
}
trap teardown EXIT

# Create a workspace user that shares the admin's password hash (so it logs in
# with $PASSWORD). $2 = "reader" adds a reader space membership; "none" = no
# membership (non-member). Echoes the new user id.
make_user(){
  local email="$1" role="$2" uid
  # grep the bare uuid out of the RETURNING output (psql may append a status tag).
  uid=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
        "insert into users (id,email,name,password,workspace_id,created_at,updated_at,has_generated_password,is_agent)
        select gen_random_uuid(),'$email','$email',password,workspace_id,now(),now(),false,false
        from users where email='$EMAIL' returning id;" 2>/dev/null \
        | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
  if [ "$role" = "reader" ]; then
    psqlq "insert into space_members (id,user_id,space_id,role,added_by_id,created_at,updated_at)
           values (gen_random_uuid(),'$uid','$SPACE_ID','reader','$uid',now(),now());" >/dev/null
  fi
  printf '%s' "$uid"
}

# ---------------------------------------------------------------------------
say "setup: login + fixtures"
[ "$(code -c "$COOKIES" -X POST "$SERVER/api/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")" = "200" ] \
  && ok "admin login" || { bad "admin login failed"; exit 1; }
if [ -z "$SPACE_ID" ]; then
  slug="adv$(date +%s)$RANDOM"
  SPACE_ID=$(api -X POST "$SERVER/api/spaces/create" -H 'Content-Type: application/json' \
    -d "{\"name\":\"E2E-ADV Throwaway $slug\",\"slug\":\"$slug\"}" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
  [ -n "$SPACE_ID" ] || { bad "could not provision a test space"; exit 1; }
  PROVISIONED="$SPACE_ID"
  psqlq "update spaces set settings = coalesce(settings,'{}'::jsonb) || '{\"gitSync\":{\"enabled\":true}}'::jsonb where id='$SPACE_ID';" >/dev/null
  ok "provisioned throwaway space $SPACE_ID"
fi
GIT_URL="$SERVER/git/$SPACE_ID.git"
VAULT="$VAULT_DIR/$SPACE_ID"
sync_now  # initialize the vault for the new space
gitc clone -q "$GIT_URL" "$WORK/c" 2>/dev/null && ok "baseline clone" || { bad "baseline clone failed"; exit 1; }
( cd "$WORK/c" && git config user.email e2e@test && git config user.name e2e )

# ===========================================================================
say "protocol: unparseable / wrong-method requests are rejected (never reach git)"
# A recognized git content-type to an UNKNOWN service subpath reaches the handler
# and is rejected as a bad request (resolveServiceKind -> null -> 400).
[ "$(code -X POST -H "Authorization: Basic $BASIC" -H 'Content-Type: application/x-git-upload-pack-request' "$GIT_URL/git-bogus-pack")" = "400" ] \
  && ok "unknown service subpath -> 400" || bad "unknown service subpath not 400"
# An UNKNOWN content-type is rejected by the global content-type allowlist (415)
# before the git handler even runs — also a valid rejection.
[ "$(code -X POST -H "Authorization: Basic $BASIC" -H 'Content-Type: application/x-git-bogus' "$GIT_URL/git-receive-pack")" = "415" ] \
  && ok "unknown content-type -> 415 (global allowlist)" || bad "unknown content-type not 415"
[ "$(code -X PUT -H "Authorization: Basic $BASIC" "$GIT_URL/git-receive-pack")" = "400" ] \
  && ok "PUT on a pack endpoint -> 400" || bad "PUT not 400"
[ "$(code -X DELETE -H "Authorization: Basic $BASIC" "$GIT_URL/info/refs?service=git-upload-pack")" = "400" ] \
  && ok "DELETE on info/refs -> 400" || bad "DELETE not 400"

# ===========================================================================
say "protocol: path-traversal in space-id / subpath is rejected (no escape)"
for u in \
  "$SERVER/git/..%2f..%2f..%2fetc.git/info/refs?service=git-upload-pack" \
  "$GIT_URL/%2e%2e%2finfo/refs?service=git-upload-pack" \
  "$SERVER/git/.git/info/refs?service=git-upload-pack" ; do
  c=$(curl -s --path-as-is -o /dev/null -w '%{http_code}' -H "Authorization: Basic $BASIC" "$u")
  case "$c" in 400|404) ok "traversal '${u##*/git/}' -> $c";; *) bad "traversal '${u##*/git/}' got $c (expected 400/404)";; esac
done

# ===========================================================================
say "authz: a sync-DISABLED space is 404 (existence not revealed), not 403"
SPACE2_ID=$(api -X POST "$SERVER/api/spaces/create" -H 'Content-Type: application/json' -d '{"name":"E2E-ADV-Space2","slug":"e2eadvspace2"}' | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -n "$SPACE2_ID" ]; then
  [ "$(code -H "Authorization: Basic $BASIC" "$SERVER/git/$SPACE2_ID.git/info/refs?service=git-upload-pack")" = "404" ] \
    && ok "admin member of a gitSync-disabled space -> 404" || bad "disabled space did not 404"
  # enabling it flips to 200 (proves the per-space flag is the gate)
  psqlq "update spaces set settings = coalesce(settings,'{}'::jsonb) || '{\"gitSync\":{\"enabled\":true}}'::jsonb where id='$SPACE2_ID';" >/dev/null
  [ "$(code -H "Authorization: Basic $BASIC" "$SERVER/git/$SPACE2_ID.git/info/refs?service=git-upload-pack")" = "200" ] \
    && ok "flipping gitSync.enabled=true -> 200" || bad "enabled 2nd space did not 200"
else
  bad "could not create a 2nd space"
fi

# ===========================================================================
say "authz: reader can FETCH (200) but is FORBIDDEN to push (403)"
READER_ID=$(make_user "e2e-adv-reader@test.local" reader)
RBASIC=$(basicfor "e2e-adv-reader@test.local")
[ "$(code -H "Authorization: Basic $RBASIC" "$GIT_URL/info/refs?service=git-upload-pack")" = "200" ] \
  && ok "reader fetch -> 200" || bad "reader fetch not 200"
[ "$(code -H "Authorization: Basic $RBASIC" "$GIT_URL/info/refs?service=git-receive-pack")" = "403" ] \
  && ok "reader push (receive-pack) -> 403" || bad "reader push not 403"

# ===========================================================================
say "authz: a NON-member of an enabled space -> 404 (NOT 403; existence not leaked)"
OUTSIDER_ID=$(make_user "e2e-adv-outsider@test.local" none)
OBASIC=$(basicfor "e2e-adv-outsider@test.local")
c=$(code -H "Authorization: Basic $OBASIC" "$GIT_URL/info/refs?service=git-upload-pack")
# The gate deliberately returns 404 (not 403) for a non-member so the 403<->404
# split cannot be used to probe which private spaces exist (git-http.helpers.spec.ts).
[ "$c" = "404" ] && ok "non-member fetch -> 404 (space existence not leaked)" || bad "non-member got $c (contract is 404)"

# ===========================================================================
say "concurrency: a push while the per-space lock is held -> 503 + Retry-After"
docker exec "$REDIS_CONTAINER" redis-cli set "${LOCK_PREFIX}${SPACE_ID}" "held-by-test" PX 8000 NX >/dev/null 2>&1
hdr=$(curl -s -D - -o /dev/null -X POST -H "Authorization: Basic $BASIC" \
      -H 'Content-Type: application/x-git-receive-pack-request' --data-binary '0000' \
      "$GIT_URL/git-receive-pack")
st=$(printf '%s' "$hdr" | head -1 | grep -o '[0-9]\{3\}')
ra=$(printf '%s' "$hdr" | grep -i '^Retry-After:' | tr -d '\r')
main_before=$(vault_sha main)
[ "$st" = "503" ] && ok "push during held lock -> 503" || bad "lock-held push got $st (expected 503)"
[ -n "$ra" ] && ok "503 carries a $ra header" || bad "503 missing Retry-After header"
docker exec "$REDIS_CONTAINER" redis-cli del "${LOCK_PREFIX}${SPACE_ID}" >/dev/null 2>&1
[ "$(vault_sha main)" = "$main_before" ] && ok "receive-pack did not mutate the vault while locked" || bad "vault main changed under a held lock"

# ===========================================================================
say "idempotent re-sync: nothing changes when nothing changed (no churn)"
sync_now
m1=$(vault_sha main); lp1=$(vault_sha refs/docmost/last-pushed)
sync_now; sync_now
m2=$(vault_sha main); lp2=$(vault_sha refs/docmost/last-pushed)
[ "$m1" = "$m2" ] && [ "$lp1" = "$lp2" ] && ok "main + last-pushed SHAs stable across idle cycles" \
  || bad "idle cycles churned refs (main $m1->$m2, last-pushed $lp1->$lp2)"

# (Structural rename/move on the live stand is deliberately NOT scripted here: a
# freshly-API-created page has a meta-only body, so git's rename-similarity
# heuristic classifies a `git mv` of it as delete+add rather than `R`, which is a
# test-fixture artifact, not a feature bug. The rename/move classifier is covered
# deterministically by the engine unit suite — packages/git-sync/test/
# classify-rename-moves.test.ts and node-ops.test.ts.)

# NOTE (review #12): the former "delete cap" block was removed. There is NO
# delete cap in the orchestrator ("There is no delete cap") and /status does not
# expose maxDeletesPerCycle, so the block failed deterministically with a scary
# "(data loss!)". The real contract — every git-rm'd page soft-deletes to Trash
# (recoverable) — is exercised by the git-side-delete scenario elsewhere and by
# the engine unit suite.

# ===========================================================================
say "data-loss guard #2: untitled pages + retitle must NOT trash other pages"
# THE bug from the browser flow: Docmost creates pages UNTITLED (title=''), which
# all serialize to the `_` fallback name. Retitling one reshuffles the `_`
# collision and relocates another's file; git reports the move as delete+add and
# the push used to TRASH the relocated live page. Identity is the pageId now.
ut_before=$(psqlq "select count(*) from pages where space_id='$SPACE_ID' and deleted_at is not null;")
ut_ids=""
for i in 1 2 3 4; do
  id=$(api -X POST "$SERVER/api/pages/create" -H 'Content-Type: application/json' -d "{\"spaceId\":\"$SPACE_ID\",\"title\":\"\"}" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
  ut_ids="$ut_ids $id"; sync_now
done
# retitle the first one (like typing a title in the editor), then sync twice
first=$(echo $ut_ids | awk '{print $1}')
api -X POST "$SERVER/api/pages/update" -H 'Content-Type: application/json' -d "{\"pageId\":\"$first\",\"title\":\"E2E-ADV-Titled-$RANDOM\"}" >/dev/null
sync_now; sync_now
ut_after=$(psqlq "select count(*) from pages where space_id='$SPACE_ID' and deleted_at is not null;")
live_kept=$(psqlq "select count(*) from pages where space_id='$SPACE_ID' and deleted_at is null and ($(echo $ut_ids | sed "s/ \?\([0-9a-f-]\+\)/ or id='\1'/g; s/^ or //"));")
[ "${ut_after:-9}" = "${ut_before:-0}" ] && ok "no page trashed by the untitled+retitle reshuffle (was the data-loss bug)" || bad "trashed count grew ${ut_before}->${ut_after} (page lost to the reshuffle!)"
[ "${live_kept:-0}" = "4" ] && ok "all 4 untitled/retitled pages still LIVE" || bad "only $live_kept/4 of the untitled pages survived"
# cleanup these via the E2E-ADV teardown (the retitled one) + hard-delete the rest
psqlq "delete from pages where id in ($(echo $ut_ids | sed "s/ \?\([0-9a-f-]\+\)/,'\1'/g; s/^,//"));" >/dev/null

# ===========================================================================
say "RESULTS: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
