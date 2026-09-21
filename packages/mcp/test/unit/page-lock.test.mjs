import { test } from "node:test";
import assert from "node:assert/strict";

import { withPageLock, isUuid } from "../../build/lib/page-lock.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// withPageLock now asserts its key is a canonical UUID (#449, "resolve-then-
// lock"), so the mechanics tests below must lock under real UUIDs, not arbitrary
// labels. Distinct valid UUIDv7-shaped ids for the distinct-page cases.
const U = {
  same: "11111111-1111-7111-8111-111111111111",
  ordered: "22222222-2222-7222-8222-222222222222",
  poison: "33333333-3333-7333-8333-333333333333",
  poison2: "44444444-4444-7444-8444-444444444444",
  A: "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
  B: "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb",
  leak: "55555555-5555-7555-8555-555555555555",
};

test("two ops on the same pageId run strictly sequentially (no overlap)", async () => {
  const events = [];
  const pageId = U.same;

  const p1 = withPageLock(pageId, async () => {
    events.push("start-1");
    await delay(40);
    events.push("end-1");
    return "r1";
  });

  // Queue the second op while the first is still running.
  const p2 = withPageLock(pageId, async () => {
    events.push("start-2");
    await delay(10);
    events.push("end-2");
    return "r2";
  });

  const [r1, r2] = await Promise.all([p1, p2]);

  assert.equal(r1, "r1");
  assert.equal(r2, "r2");
  // First op must fully finish before the second one begins.
  assert.deepEqual(events, ["start-1", "end-1", "start-2", "end-2"]);
});

test("same pageId ordering holds for many queued ops", async () => {
  const pageId = U.ordered;
  const order = [];
  const active = { count: 0, maxConcurrent: 0 };

  const ops = [];
  for (let i = 0; i < 6; i++) {
    ops.push(
      withPageLock(pageId, async () => {
        active.count += 1;
        active.maxConcurrent = Math.max(active.maxConcurrent, active.count);
        order.push(i);
        await delay(5);
        active.count -= 1;
        return i;
      }),
    );
  }

  const results = await Promise.all(ops);

  assert.deepEqual(results, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5]);
  // Strictly sequential: never more than one op running at a time.
  assert.equal(active.maxConcurrent, 1);
});

test("a rejecting op does not poison the chain for the same page", async () => {
  const pageId = U.poison;
  const events = [];

  const failing = withPageLock(pageId, async () => {
    events.push("fail-start");
    await delay(20);
    events.push("fail-throw");
    throw new Error("boom");
  });

  // The caller of the failing op must still see the rejection.
  await assert.rejects(failing, /boom/);

  const following = withPageLock(pageId, async () => {
    events.push("next-run");
    await delay(5);
    return "ok";
  });

  const result = await following;

  assert.equal(result, "ok");
  // The next op ran after the failing one settled and was not blocked by it.
  assert.deepEqual(events, ["fail-start", "fail-throw", "next-run"]);
});

test("failing op queued before a success both resolve/reject correctly", async () => {
  const pageId = U.poison2;
  const order = [];

  const failing = withPageLock(pageId, async () => {
    order.push("fail");
    await delay(20);
    throw new Error("nope");
  });

  const ok = withPageLock(pageId, async () => {
    order.push("ok");
    await delay(5);
    return 123;
  });

  await assert.rejects(failing, /nope/);
  assert.equal(await ok, 123);
  // The failing op still ran first (it was queued first), then the success.
  assert.deepEqual(order, ["fail", "ok"]);
});

test("ops on different pageIds run concurrently (overlap)", async () => {
  const events = [];

  const pA = withPageLock(U.A, async () => {
    events.push("A-start");
    await delay(40);
    events.push("A-end");
    return "A";
  });

  const pB = withPageLock(U.B, async () => {
    events.push("B-start");
    await delay(10);
    events.push("B-end");
    return "B";
  });

  const [rA, rB] = await Promise.all([pA, pB]);

  assert.equal(rA, "A");
  assert.equal(rB, "B");
  // B starts before A finishes (concurrent), and B finishes before A.
  assert.deepEqual(events, ["A-start", "B-start", "B-end", "A-end"]);
});

test("no functional leak: many sequential ops on same page keep working", async () => {
  const pageId = U.leak;

  // Run a long series of fully sequential ops (each awaited before the next is
  // queued) so the internal map entry is created and dropped repeatedly.
  for (let i = 0; i < 50; i++) {
    const value = await withPageLock(pageId, async () => {
      await delay(1);
      return i;
    });
    assert.equal(value, i);
  }

  // After the chain has drained, a brand new op on the same page still works,
  // confirming the entry was not left in a broken state.
  const final = await withPageLock(pageId, async () => "still-works");
  assert.equal(final, "still-works");
});

// --- Issue #449: fail-fast on a non-canonical lock key ---------------------
// A write method that reaches the lock path with an unresolved slugId (or any
// non-UUID key) must fail IMMEDIATELY and LOUDLY, not lock under a split key and
// silently lose per-page serialization. These assert withPageLock rejects such
// a key before ever running fn.

test("withPageLock throws on a raw 10-char slugId (unresolved key)", () => {
  let ran = false;
  assert.throws(
    () =>
      withPageLock("p7Xk29Lm4Q", async () => {
        ran = true;
        return "should-not-run";
      }),
    /canonical page UUID|resolve-then-lock/i,
    "a slugId key must fail-fast at the lock",
  );
  // The work must NOT have started: fail-fast means no serialization was
  // silently skipped under a bad key.
  assert.equal(ran, false, "fn must not run when the key is rejected");
});

test("withPageLock throws on other non-UUID keys (label, empty, non-string)", () => {
  for (const bad of ["same-page", "", "not-a-uuid", "1234"]) {
    assert.throws(
      () => withPageLock(bad, async () => "x"),
      /canonical page UUID/i,
      `expected withPageLock to reject key ${JSON.stringify(bad)}`,
    );
  }
  // A non-string key is also rejected (guards a mistyped call site).
  assert.throws(
    () => withPageLock(/** @type {any} */ (undefined), async () => "x"),
    /canonical page UUID/i,
  );
});

test("withPageLock accepts a canonical UUID key (no false positive)", async () => {
  const uuid = "0192f3a4-b5c6-7d8e-9f01-23456789abcd";
  assert.equal(isUuid(uuid), true);
  const r = await withPageLock(uuid, async () => "ok");
  assert.equal(r, "ok");
});

test("isUuid discriminates UUIDs from slugIds (shared predicate)", () => {
  // The predicate withPageLock asserts on is the SAME one resolvePageId uses to
  // decide whether a pageId is already a UUID (imported from page-lock).
  assert.equal(isUuid("0192f3a4-b5c6-7d8e-9f01-23456789abcd"), true);
  assert.equal(isUuid("p7Xk29Lm4Q"), false); // 10-char nanoid slugId
  assert.equal(isUuid("not-a-uuid"), false);
  assert.equal(isUuid(""), false);
});
