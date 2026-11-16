// search (items + related) and listPages (recent) carry a `url` built from the
// configured public appUrl, not from the internal apiUrl the client talks to.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { DocmostClient } from "../../build/client.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

const servers = [];
after(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});

function send(res, obj, extra = {}) {
  res.writeHead(200, { "Content-Type": "application/json", ...extra });
  res.end(JSON.stringify(obj));
}

async function makeClient() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url === "/api/search") {
        return send(res, {
          success: true,
          data: {
            items: [{ id: A, slugId: "sa", title: "A" }],
            related: [{ id: B, slugId: "sb", title: "B" }],
          },
        });
      }
      if (req.url === "/api/pages/recent") {
        return send(res, { success: true, data: { items: [{ id: A, slugId: "sa", title: "A" }] } });
      }
      res.writeHead(404);
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return new DocmostClient({
    apiUrl: `http://127.0.0.1:${server.address().port}/api`,
    appUrl: "https://wiki.example",
    getToken: async () => "access",
  });
}

test("search items and related carry url", async () => {
  const client = await makeClient();
  const r = await client.search("x");
  assert.equal(r.items[0].url, `https://wiki.example/p/${A}`);
  assert.equal(r.related[0].url, `https://wiki.example/p/${B}`);
});

test("listPages recent items carry url", async () => {
  const client = await makeClient();
  const r = await client.listPages();
  assert.equal(r[0].url, `https://wiki.example/p/${A}`);
});
