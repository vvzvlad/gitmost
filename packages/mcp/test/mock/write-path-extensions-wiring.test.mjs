// #502 caller-WIRING: end-to-end through a live Hocuspocus collab stack (same
// harness style as markdown-patch-insert), driving the REAL client methods and
// reading the persisted document back, so the test proves each write tool passes
// the RIGHT importer options — not just that the shared wrapper can:
//   - updatePageMarkdown (client.updatePage)      -> extensions OFF  (`$…$` literal, www not linked)
//   - import_page_markdown (client.importPageMarkdown) -> DEFAULTS   (`$x^2$` -> math node, #328)
// Mutating either caller's option flips the matching assertion (see the coder's
// mutation note), so this file guards the wiring, not only the wrapper.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer } from "ws";
import { Hocuspocus } from "@hocuspocus/server";
import { DocmostClient } from "../../build/client.js";
import { buildYDoc } from "../../build/lib/collaboration.js";
import { serializeDocmostMarkdown } from "@docmost/prosemirror-markdown";

const PAGE = "11111111-1111-4111-8111-111111111111";

function findAll(node, type, acc = []) {
  if (!node || typeof node !== "object") return acc;
  if (node.type === type) acc.push(node);
  if (Array.isArray(node.content)) for (const c of node.content) findAll(c, type, acc);
  return acc;
}
function allText(node, acc = []) {
  if (!node || typeof node !== "object") return acc.join("");
  if (node.type === "text" && typeof node.text === "string") acc.push(node.text);
  if (Array.isArray(node.content)) for (const c of node.content) allText(c, acc);
  return acc.join("");
}
function hasLink(node) {
  return findAll(node, "text").some((t) => t.marks?.some((m) => m.type === "link"));
}

function fragmentToJson(frag) {
  const decodeNode = (el) => {
    if (el.constructor.name === "YXmlText") {
      const delta = el.toDelta();
      return delta.map((d) => {
        const node = { type: "text", text: d.insert };
        if (d.attributes && Object.keys(d.attributes).length) {
          node.marks = Object.entries(d.attributes).map(([type, attrs]) =>
            attrs && typeof attrs === "object" && Object.keys(attrs).length
              ? { type, attrs }
              : { type },
          );
        }
        return node;
      });
    }
    const node = { type: el.nodeName };
    const attrs = el.getAttributes();
    if (attrs && Object.keys(attrs).length) node.attrs = attrs;
    const children = [];
    for (const child of el.toArray()) {
      const decoded = decodeNode(child);
      if (Array.isArray(decoded)) children.push(...decoded);
      else children.push(decoded);
    }
    if (children.length) node.content = children;
    return node;
  };
  const content = [];
  for (const child of frag.toArray()) content.push(decodeNode(child));
  return { type: "doc", content };
}

const openStacks = [];
after(async () => {
  await Promise.all(
    openStacks.map(
      ({ server, hocuspocus }) =>
        new Promise((resolve) => {
          server.close(() => {
            Promise.resolve(hocuspocus.destroy?.()).finally(resolve);
          });
        }),
    ),
  );
});

async function spawnCollabStack(seedDoc) {
  const state = { lastDoc: null };
  const hocuspocus = new Hocuspocus({
    quiet: true,
    async onLoadDocument() {
      return buildYDoc(seedDoc);
    },
    async onChange(data) {
      try {
        state.lastDoc = fragmentToJson(data.document.getXmlFragment("default"));
      } catch {
        /* ignore teardown-race decode errors */
      }
    },
  });
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.url === "/api/auth/login") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie": "authToken=t; Path=/; HttpOnly",
        });
        res.end(JSON.stringify({ success: true }));
        return;
      }
      if (req.url === "/api/auth/collab-token") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: { token: "collab-jwt" } }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "not found" }));
    });
  });
  server.on("upgrade", (request, socket, head) => {
    if (!request.url || !request.url.startsWith("/collab")) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      hocuspocus.handleConnection(ws, request);
    });
  });
  const baseURL = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${server.address().port}/api`);
    });
  });
  openStacks.push({ server, hocuspocus });
  return { state, baseURL };
}

function seed() {
  return {
    type: "doc",
    content: [
      { type: "paragraph", attrs: { id: "p-id" }, content: [{ type: "text", text: "seed" }] },
    ],
  };
}

test("updatePageMarkdown wiring: extensions OFF — `$…$` literal, www not linked, https links", async () => {
  // #647 §H — updatePageMarkdown now imports the markdown client-side and writes
  // through the server-side guarded replace (REST), so we capture the final doc at
  // that seam instead of reading it back from a live collab stack. The importer
  // options under test (parseMath:false, fuzzyLinkify:false) are unchanged by the
  // migration; flipping either still flips these assertions.
  const state = { lastDoc: null };
  class TestClient extends DocmostClient {
    async ensureAuthenticated() {}
    async getPageRaw() {
      return { id: PAGE, content: { type: "doc", content: [] } };
    }
    async guardedReplacePage(pageId, content) {
      state.lastDoc = content;
      return { applied: true, newHash: "h" };
    }
  }
  const client = new TestClient("http://127.0.0.1:1/api", "e@x.com", "pw");

  await client.updatePage(
    PAGE,
    "cfg $x=1$ and www.host.com and https://ex.com",
    undefined,
    "base-hash",
  );

  assert.ok(state.lastDoc, "a document was persisted");
  assert.equal(findAll(state.lastDoc, "mathInline").length, 0, "no phantom math from an agent write");
  assert.ok(allText(state.lastDoc).includes("$x=1$"), "literal dollars preserved");
  assert.ok(allText(state.lastDoc).includes("www.host.com"), "bare domain preserved as text");
  // The explicit https URL still links (only the schemeless autolink is off).
  const links = findAll(state.lastDoc, "text").filter((t) =>
    t.marks?.some((m) => m.type === "link"),
  );
  assert.ok(links.some((t) => t.text?.includes("ex.com")), "explicit https still links");
});

test("import_page_markdown wiring: DEFAULTS — exported `$x^2$` re-imports AS a math node (#328)", async () => {
  const { state, baseURL } = await spawnCollabStack(seed());
  const client = new DocmostClient(baseURL, "e@x.com", "pw");

  // A self-contained docmost markdown file whose body carries a math span (as the
  // exporter emits it). import_page_markdown must import it with math ON.
  const meta = { version: 1, pageId: PAGE, slugId: "s", title: "T", spaceId: "sp", parentPageId: null };
  const fullMd = serializeDocmostMarkdown(meta, "energy is $x^2$ here", []);

  await client.importPageMarkdown(PAGE, fullMd);

  assert.ok(state.lastDoc, "a document was persisted");
  assert.equal(
    findAll(state.lastDoc, "mathInline").length,
    1,
    "the lossless round-trip is intact: math survives import_page_markdown",
  );
});
