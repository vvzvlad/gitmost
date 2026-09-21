// #654 — read-your-own-writes for the 4 structural read tools
// (getOutline/getNode/searchInPage/getTable). A write arms the page's RYOW window
// (rememberWrite); a subsequent structural read within the window sends the
// `preferLive` hint, so getPageRaw is asked for the LIVE doc and the tool returns
// the live view + a `freshness` token. These tools only read + hold the tiny
// recentlyWritten map, so a lightweight subclass that stubs auth + getPageRaw and
// exposes the protected RYOW seams is enough — no collab socket needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DocmostClient } from "../../build/client.js";

const P = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"; // canonical (v4) UUID page id

function doc(text, id = "b1") {
  return {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1, id }, content: [{ type: "text", text }] },
    ],
  };
}

// live/db: the two content bodies the fake server serves. serverSource controls
// what the server returns for a preferLive request: "live" (doc loaded) or "db"
// (fell back). fallbackReason accompanies the db fallback.
function makeClient({
  live,
  db,
  serverSource = "live",
  fallbackReason,
  onMetric,
} = {}) {
  const calls = [];
  const metrics = [];
  class TestClient extends DocmostClient {
    async ensureAuthenticated() {}
    async getPageRaw(pageId, format, opts) {
      calls.push({ pageId, preferLive: !!opts?.preferLive });
      const base = { id: P, slugId: "s10", title: "P", spaceId: "sp" };
      if (opts?.preferLive) {
        if (serverSource === "live") {
          return { ...base, content: live, contentSource: "live" };
        }
        return { ...base, content: db, contentSource: "db", fallbackReason };
      }
      return { ...base, content: db };
    }
    // Expose the protected RYOW seams for the test.
    arm(uuid, changed = true) {
      this.rememberWrite(uuid, { changed });
    }
    mapSlug(slug, uuid) {
      this.pageIdCache.set(slug, uuid);
    }
  }
  const client = new TestClient({
    apiUrl: "http://127.0.0.1:1/api",
    email: "e@x.com",
    password: "pw",
    onMetric: onMetric ?? ((name, value, labels) => metrics.push({ name, value, labels })),
  });
  return { client, calls, metrics };
}

test("getOutline after a write returns the LIVE view (read-your-own-writes)", async () => {
  const { client, calls } = makeClient({ live: doc("FRESH"), db: doc("STALE") });
  client.arm(P);
  const res = await client.getOutline(P);
  assert.equal(calls[0].preferLive, true, "the read sent the preferLive hint");
  assert.equal(res.outline[0].firstText, "FRESH", "outline reflects the LIVE doc");
  assert.equal(res.freshness, "live");
});

test("NON-VACUITY: without a write, getOutline returns the STALE db view, no hint", async () => {
  const { client, calls } = makeClient({ live: doc("FRESH"), db: doc("STALE") });
  const res = await client.getOutline(P); // not armed
  assert.equal(calls[0].preferLive, false, "no hint sent");
  assert.equal(res.outline[0].firstText, "STALE", "db view served");
  assert.equal(res.freshness, undefined, "no freshness field when the hint was not sent");
});

test("getNode after a write reflects the LIVE doc + freshness:'live'", async () => {
  const { client } = makeClient({
    live: doc("edited", "n9"),
    db: doc("old", "n9"),
  });
  client.arm(P);
  const res = await client.getNode(P, "n9");
  assert.match(res.markdown, /edited/);
  assert.equal(res.freshness, "live");
});

test("searchInPage after a write finds text present ONLY in the live doc", async () => {
  const { client } = makeClient({ live: doc("needle"), db: doc("haystack") });
  client.arm(P);
  const res = await client.searchInPage(P, "needle");
  assert.equal(res.total, 1, "the new text is found in the live doc");
  assert.equal(res.freshness, "live");
});

test("getTable after a write reads the live doc; freshness surfaced", async () => {
  const table = {
    type: "doc",
    content: [
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { colspan: 1, rowspan: 1 },
                content: [{ type: "paragraph", content: [{ type: "text", text: "LIVE" }] }],
              },
            ],
          },
        ],
      },
    ],
  };
  const { client } = makeClient({ live: table, db: doc("STALE") });
  client.arm(P);
  const res = await client.getTable(P, "#0");
  assert.equal(res.cells[0][0], "LIVE");
  assert.equal(res.freshness, "live");
});

test("db-fallback (not_loaded) -> stale-fallback freshness + dbrow metric", async () => {
  const { client, metrics } = makeClient({
    live: doc("FRESH"),
    db: doc("STALE"),
    serverSource: "db",
    fallbackReason: "not_loaded",
  });
  client.arm(P);
  const res = await client.getOutline(P);
  assert.equal(res.outline[0].firstText, "STALE", "the db row is served on fallback");
  assert.equal(res.freshness, "stale-fallback");
  const m = metrics.find((x) => x.name === "mcp_ryow_dbrow_total");
  assert.ok(m, "a dbrow metric was emitted");
  assert.equal(m.labels.reason, "not_loaded");
});

test("db-fallback (owner_unreachable) -> stale-fallback + reason label", async () => {
  const { client, metrics } = makeClient({
    live: doc("FRESH"),
    db: doc("STALE"),
    serverSource: "db",
    fallbackReason: "owner_unreachable",
  });
  client.arm(P);
  const res = await client.getOutline(P);
  assert.equal(res.freshness, "stale-fallback");
  const m = metrics.find((x) => x.name === "mcp_ryow_dbrow_total");
  assert.equal(m.labels.reason, "owner_unreachable");
});

test("live read emits mcp_ryow_live_total", async () => {
  const { client, metrics } = makeClient({ live: doc("FRESH"), db: doc("STALE") });
  client.arm(P);
  await client.getOutline(P);
  assert.ok(metrics.some((x) => x.name === "mcp_ryow_live_total"));
});

test("a no-op write (changed:false) does NOT arm RYOW", async () => {
  const { client, calls } = makeClient({ live: doc("FRESH"), db: doc("STALE") });
  client.arm(P, false); // aborted / no-op write
  await client.getOutline(P);
  assert.equal(calls[0].preferLive, false, "a no-op write never sets the hint");
});

test("slug input: write-by-uuid then read-by-slug resolves via pageIdCache", async () => {
  const { client, calls } = makeClient({ live: doc("FRESH"), db: doc("STALE") });
  client.mapSlug("slug10", P); // slug->uuid learned at write time
  client.arm(P);
  const res = await client.getOutline("slug10");
  assert.equal(calls[0].preferLive, true, "hint sent for the slug read (probe by resolved uuid)");
  assert.equal(res.outline[0].firstText, "FRESH");
});

test("an unknown slug (never written/resolved) does NOT set the hint", async () => {
  const { client, calls } = makeClient({ live: doc("FRESH"), db: doc("STALE") });
  client.arm(P); // armed by UUID, but we read by an unmapped slug
  await client.getOutline("unknownslug");
  assert.equal(calls[0].preferLive, false);
});

// --- F1 (#654): the two write arms that route through the post-#672 write path ---
// updatePage (now a server-side guarded replace via the guardedReplacePage seam)
// and importPageMarkdown (now via the replacePage seam) must ARM the RYOW window
// after a changed write. Deleting either arm previously left the suite green. These
// tests exercise the REAL write method (stubbing ONLY the seams beneath it) and
// assert the arm landed via shouldPreferLive, so removing the arm turns RED.
function makeWriteClient() {
  class TestClient extends DocmostClient {
    async ensureAuthenticated() {}
    async getCollabTokenWithReauth() {
      return "collab-token";
    }
    // updatePage fetches the LIVE doc (to re-graft resolved comments) before its
    // guarded write — return a usable ProseMirror body so the regraft passes.
    async getPageRaw() {
      return { id: P, slugId: "s10", title: "P", spaceId: "sp", content: doc("live") };
    }
    // updatePage's server-side CAS body-write seam (post-#672): report success so
    // the arm right after it (updatePage's own rememberWrite) fires.
    async guardedReplacePage() {
      return { applied: true, newHash: "h" };
    }
    // Stub BENEATH the replacePage seam (its collab write), so the REAL replacePage
    // runs and arms the RYOW window itself (context.ts) — importPageMarkdown relies on
    // that seam arm, so removing the seam's rememberWrite (not any arm in pages.ts)
    // turns this test RED. Report a real change so the arm fires.
    async writeWithCollabAuthRetry() {
      return { verify: { changed: true } };
    }
    // Expose the protected read-side gate the arm feeds.
    prefers(uuid) {
      return this.shouldPreferLive(uuid);
    }
  }
  return new TestClient({
    apiUrl: "http://127.0.0.1:1/api",
    email: "e@x.com",
    password: "pw",
  });
}

test("updatePage arms RYOW (arm @ the guardedReplacePage call site in updatePage)", async () => {
  const client = makeWriteClient();
  assert.equal(client.prefers(P), false, "not armed before the write");
  // baseHash is MANDATORY post-#647/#672; no title -> no REST title write.
  await client.updatePage(P, "# hello", undefined, "base-hash-1");
  assert.equal(client.prefers(P), true, "updatePage armed the RYOW window");
});

test("importPageMarkdown arms RYOW via the replacePage seam", async () => {
  const client = makeWriteClient();
  assert.equal(client.prefers(P), false, "not armed before the import");
  const res = await client.importPageMarkdown(P, "# hello world");
  assert.equal(res.success, true);
  assert.equal(client.prefers(P), true, "importPageMarkdown armed the RYOW window");
});

test("expired RYOW window -> no hint + expired metric (not a dbrow fallback)", async () => {
  const prev = process.env.GITMOST_RYOW_WINDOW_MS;
  process.env.GITMOST_RYOW_WINDOW_MS = "1"; // 1ms window
  try {
    const { client, calls, metrics } = makeClient({ live: doc("FRESH"), db: doc("STALE") });
    client.arm(P);
    await new Promise((r) => setTimeout(r, 5)); // let the window lapse
    const res = await client.getOutline(P);
    assert.equal(calls[0].preferLive, false, "no hint after the window lapsed");
    assert.equal(res.outline[0].firstText, "STALE");
    assert.equal(res.freshness, undefined);
    assert.ok(
      metrics.some((x) => x.name === "mcp_ryow_expired_total"),
      "an expired counter was emitted",
    );
    assert.ok(
      !metrics.some((x) => x.name === "mcp_ryow_dbrow_total"),
      "expiry is NOT counted as a db-row fallback",
    );
  } finally {
    if (prev === undefined) delete process.env.GITMOST_RYOW_WINDOW_MS;
    else process.env.GITMOST_RYOW_WINDOW_MS = prev;
  }
});
