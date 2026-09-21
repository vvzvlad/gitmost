import { test } from "node:test";
import assert from "node:assert/strict";

import { timeToolHandler } from "../../build/index.js";

// #402 — the registerTool wrapper times every tool through a single choke point
// and feeds the host's dependency-neutral onMetric sink. These assert the
// timing contract without a live transport (the factory monkeypatches
// server.registerTool with exactly this helper).

test("times a tool and preserves the handler's return value", async () => {
  const calls = [];
  const onMetric = (name, value, labels) => calls.push({ name, value, labels });

  const handler = async (arg) => ({ ok: true, echo: arg });
  const wrapped = timeToolHandler("getPage", handler, onMetric);

  const result = await wrapped("hello");
  // Return value passes through untouched.
  assert.deepEqual(result, { ok: true, echo: "hello" });

  // Exactly one sample, correct name/labels, numeric non-negative duration.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "mcp_tool_duration_seconds");
  assert.deepEqual(calls[0].labels, { tool: "getPage" });
  assert.equal(typeof calls[0].value, "number");
  assert.ok(calls[0].value >= 0, "duration must be non-negative seconds");
});

test("standalone (no onMetric) is a transparent pass-through", async () => {
  const handler = async (a, b) => a + b;
  const wrapped = timeToolHandler("noop_tool", handler, undefined);

  // No throw, result unchanged, and nothing to observe.
  const result = await wrapped(2, 3);
  assert.equal(result, 5);
});

test("still observes on throw, then rethrows the original error", async () => {
  const calls = [];
  const onMetric = (name, value, labels) => calls.push({ name, value, labels });

  const boom = new Error("handler failed");
  const handler = async () => {
    throw boom;
  };
  const wrapped = timeToolHandler("boom_tool", handler, onMetric);

  await assert.rejects(() => wrapped(), (err) => err === boom);

  // Observed exactly once despite the throw.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "mcp_tool_duration_seconds");
  assert.deepEqual(calls[0].labels, { tool: "boom_tool" });
});

test("standalone still rethrows the original error (no swallow, no observe)", async () => {
  const boom = new Error("standalone failure");
  const wrapped = timeToolHandler(
    "boom_standalone",
    async () => {
      throw boom;
    },
    undefined,
  );
  await assert.rejects(() => wrapped(), (err) => err === boom);
});
