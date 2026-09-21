# How to test the application (browser E2E + out-of-band)

How to actually verify a feature end-to-end against a running stand — driving the
**real app in a browser** and confirming results **out-of-band** in the DB/git, not
through the same API you're supposed to be testing. Written from real false-positives
that wasted hours (see **Traps** — read them before you write a test).

Prereq: a running stand — see **[dev-stand.md](dev-stand.md)**. Automation uses
Playwright (`pip install playwright && python -m playwright install chromium`).

## Principles

1. **Drive the behaviour under test through the browser.** The stand exists so you
   exercise the real UI + realtime-collab + server path. Using `POST /api/pages/*` to
   perform the action you're validating tests the API, not the app — an e2e suite can
   do that. API calls are fine ONLY for one-time setup/fixtures, never for the
   interaction you're asserting on.
2. **Evidence before claim.** Nothing "passes" without an artifact: a DB row, a git
   diff, a screenshot looked at as an image. If you can't show it, you didn't verify it.
3. **Verify out-of-band.** Judge results from a source independent of the UI: `psql`
   against the DB, a fresh `git clone` of a synced repo, a hard reload. Optimistic UI
   lies about persistence.
4. **Disconfirm by default.** For each feature, actively try to prove it's broken
   before concluding it works. Reload after every create/edit/save.
5. **Recon actuatability FIRST.** Before building editor tests, confirm the
   interaction even works in your harness (does a typed edit reach the DB?). Skipping
   this is how you ship a pile of tests that all silently exercised the wrong thing.

## The editor: two ProseMirror instances (READ THIS)

A page has **two** `.ProseMirror` editors:

| index | selector | role | collab? |
|---|---|---|---|
| 0 | `[aria-label='Page title']` | title field | **NO** (16 exts, no `collaboration`) |
| 1 | `[aria-label='Page content']` | body | **YES** (95 exts, has `collaboration`) |

`document.querySelector('.ProseMirror')` returns the **title** editor (first match).
Type there and you edit the title only — body page content never changes, so `mod+S`
"versions" unchanged content and every content test silently no-ops.

**Always target the body editor** and confirm it's collab-bound before typing:

```js
const el = document.querySelector("[aria-label='Page content']");
el.editor.extensionManager.extensions.some(e => e.name === 'collaboration'); // must be true
```

Body edits emit ~20 `/collab` websocket frames while typing and land in
`pages.content` after the **hocuspocus store debounce (~10s)** — so **wait ~12s**
before asserting persistence (checking at 6–8s is a false negative). `mod+S` (the
`save-version` stateless message) flushes immediately, so a version created right
after a settled body edit holds the typed text.

## A known-good browser flow

```
1. goto /s/<space-slug>            # the "Create page" button lives in the space sidebar, not /home
2. click button[aria-label='Create page']   # fully UI-driven page creation
3. type into [aria-label='Page title']       # optional title
4. click [aria-label='Page content'] → type body text
5. wait ~12s (store debounce)
6. assert pages.content changed (psql)       # out-of-band
7. mod+S / menu Save → assert page_history row (psql)
8. reload / fresh context → re-assert (persistence round-trip)
```

Auth: log in ONCE, save `storage_state.json`, reuse it across pages/agents (re-login
per run trips shared rate-limits). Cookie-based session authorizes both REST and the
collab websocket.

## Judging out-of-band

```bash
# page content / history
docker exec <db> psql -U docmost -d docmost -tAc \
  "select coalesce(kind,'null'), content::text from page_history where page_id='<id>' order by created_at;"
# git-sync round-trip: clone the space repo and diff against what you pushed
git clone http://<user>:<pass>@127.0.0.1:3000/git/<spaceId>.git /tmp/x
```

`page_history.content` is full JSON — parse it, don't truncate the snippet, or a
marker check misses. For sync/async features (autosave, git-sync, idle-flush) use an
active probe: write a unique marker, wait past the debounce/poll window, re-read
out-of-band, ≥2 iterations — never conclude "broken" from a single snapshot.

## Traps (each of these produced a false result in a real run)

- **Wrong editor.** Typed into `.ProseMirror` (= title). Edits never touched body
  content. → target `[aria-label='Page content']`.
- **Checked persistence too early.** Store debounce ~10s; a 6–8s check reads stale.
- **Truncated the DB snapshot** below where the test marker sits → false "content
  missing".
- **API-seeded the content under test**, then "verified" the feature — that validated
  the API, not the app.
- **Reused a fixed marker on a non-rebooted stand** → title/row collisions inflate
  counts (`count==2`). Use a unique per-run marker (timestamp).
- **Idle/async read once** and called it "permanently broken" — it was mid-debounce.
- **Concluded env-limitation without a cross-build control.** If unsure whether a
  failure is your harness or the product, run the SAME harness against a known-good
  build; a divergence localizes it.

## Scope note

Some paths genuinely need a human in a real browser (rich drag-drop, native file
pickers, clipboard, and anything the harness can't actuate). Label those UNTESTED in
the report — "handled gracefully" is not "works". Keep four states distinct:
verified-working, defect, untested, env-limitation.
