// #402 — INTEGRATION test that locks the registerTool monkeypatch installed by
// createDocmostMcpServer (src/index.ts). The sibling unit test
// (test/unit/tool-timing.test.mjs) only exercises the timeToolHandler helper in
// ISOLATION; it never constructs the server, so nothing there proves the factory
// actually (a) wraps every registered tool through that helper and (b) labels
// each sample with the tool's REGISTRATION name.
//
// Here we stand up a real McpServer via the factory, connect a real MCP Client
// over the SDK's in-memory transport, invoke one registered tool, and assert the
// host's onMetric sink received `("mcp_tool_duration_seconds", <number>, { tool
// })` with tool === the exact registration name. This locks both the "monkeypatch
// wraps tools" and "label = registration name" halves of the contract, so a
// mutation to args.slice(0, -1) / the handler-arg detection / the capture order
// is caught.
import { test } from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createDocmostMcpServer } from "../../build/index.js";

// The tool we drive. getWorkspace has NO input schema, so protocol-level input
// validation cannot short-circuit before the handler runs — the wrapped handler
// is guaranteed to execute (and then fail on the unreachable backend, which is
// exactly what we want: the wrapper times in a finally on throw too).
const TOOL_NAME = "getWorkspace";

test("the factory's registerTool monkeypatch times a live tool call and labels it with the registration name", async () => {
  const calls = [];
  const onMetric = (name, value, labels) => calls.push({ name, value, labels });

  // Minimal valid credentials config. apiUrl points at a port that refuses
  // connections immediately so the tool's backend call fails FAST (ECONNREFUSED)
  // rather than hanging — the wrapper still emits the metric from its finally.
  const server = createDocmostMcpServer({
    apiUrl: "http://127.0.0.1:1",
    email: "x@example.com",
    password: "pw",
    onMetric,
  });

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const client = new Client(
    { name: "test-client", version: "0.0.0" },
    { capabilities: {} },
  );

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    // Invoke the tool. The backend is unreachable, so this either resolves with
    // an error result (isError) or rejects — both are fine. What matters is that
    // the handler ran through the timing wrapper, which fires onMetric either way.
    try {
      await client.callTool({ name: TOOL_NAME, arguments: {} });
    } catch {
      // Tolerate the expected backend failure surfacing as a thrown protocol error.
    }

    // The wrapper must have fed exactly the timing sample for THIS tool.
    const timing = calls.filter(
      (c) => c.name === "mcp_tool_duration_seconds",
    );
    assert.ok(
      timing.length >= 1,
      "onMetric must receive a mcp_tool_duration_seconds sample from the wrapped handler",
    );

    const sample = timing.find((c) => c.labels && c.labels.tool === TOOL_NAME);
    assert.ok(
      sample,
      `a timing sample must be labelled with the registration name "${TOOL_NAME}"; ` +
        `got labels: ${JSON.stringify(timing.map((c) => c.labels))}`,
    );
    assert.equal(typeof sample.value, "number");
    assert.ok(sample.value >= 0, "duration must be non-negative seconds");
  } finally {
    await client.close();
    await server.close();
  }
});
