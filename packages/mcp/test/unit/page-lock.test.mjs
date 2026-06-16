import { test } from "node:test";
import assert from "node:assert/strict";

import { withPageLock } from "../../build/lib/page-lock.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("two ops on the same pageId run strictly sequentially (no overlap)", async () => {
  const events = [];
  const pageId = "same-page";

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
  const pageId = "ordered-page";
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
  const pageId = "poison-page";
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
  const pageId = "poison-page-2";
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

  const pA = withPageLock("page-A", async () => {
    events.push("A-start");
    await delay(40);
    events.push("A-end");
    return "A";
  });

  const pB = withPageLock("page-B", async () => {
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
  const pageId = "leak-page";

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
