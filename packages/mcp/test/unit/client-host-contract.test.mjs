import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { DocmostClient } from "../../build/index.js";

// Drift guard for the THIRD hand-written layer of the AI tool set (issue #193,
// layer 3): the in-app server hand-mirrors the DocmostClient method signatures
// it consumes as the `DocmostClientLike` interface in
// apps/server/src/core/ai-chat/tools/docmost-client.loader.ts ("Signatures here
// mirror that file exactly"). That mirror lives across the ESM(mcp)/CJS(server)
// boundary and the package ships NO .d.ts, so the server typecheck cannot verify
// the names against the real class — a rename/removal in client.ts would surface
// only as a runtime "x is not a function" inside an agent tool call.
//
// This test pins the contract from the mcp side (ESM, where the real class is
// directly importable): every method the embedding host depends on MUST exist as
// a function on a real DocmostClient instance. If you rename/remove a client
// method, this fails here AND you must update DocmostClientLike to match.
//
// Keep HOST_CONTRACT_METHODS in sync with the methods declared in the server's
// DocmostClientLike interface (the in-app per-user tool adapter only — it is the
// superset of what either transport calls). Full type-derivation of
// DocmostClientLike from this class is deferred (see the staged plan in
// docmost-client.loader.ts): the package emits no declarations and the real
// (inferred, concrete) return types conflict with the host's loose
// `Record<string,unknown>` + `as`-cast result handling.
const HOST_CONTRACT_METHODS = [
  // read
  "search",
  "getPage",
  "getWorkspace",
  "getSpaces",
  "listPages",
  "listSidebarPages",
  "getOutline",
  "getPageJson",
  "getNode",
  "getTable",
  "listComments",
  "getComment",
  "checkNewComments",
  "listShares",
  "listPageHistory",
  "getPageHistory",
  "diffPageVersions",
  "exportPageMarkdown",
  // write (page)
  "createPage",
  "updatePage",
  "renamePage",
  "movePage",
  "deletePage",
  "editPageText",
  "patchNode",
  "insertNode",
  "deleteNode",
  "updatePageJson",
  "tableInsertRow",
  "tableDeleteRow",
  "tableUpdateCell",
  "copyPageContent",
  "importPageMarkdown",
  "sharePage",
  "unsharePage",
  "restorePageVersion",
  "transformPage",
  // write (comment)
  "createComment",
  "resolveComment",
];

test("DocmostClient implements every method the in-app DocmostClientLike mirror declares", () => {
  // The constructor is side-effect-free (no network/login on construction): it
  // only stores config and creates an axios instance, so it is safe to build a
  // throwaway instance here with a dummy token provider.
  const client = new DocmostClient({
    apiUrl: "http://127.0.0.1:1/api",
    getToken: async () => "test-token",
  });

  const missing = HOST_CONTRACT_METHODS.filter(
    (name) => typeof client[name] !== "function",
  );

  assert.deepEqual(
    missing,
    [],
    `DocmostClient is missing host-contract method(s): ${missing.join(", ")}. ` +
      `Update packages/mcp/src/client.ts and/or the server's DocmostClientLike ` +
      `interface (apps/server/src/core/ai-chat/tools/docmost-client.loader.ts) ` +
      `so the hand-mirrored signatures stay in sync.`,
  );
});

test("HOST_CONTRACT_METHODS has no duplicates", () => {
  assert.equal(
    new Set(HOST_CONTRACT_METHODS).size,
    HOST_CONTRACT_METHODS.length,
  );
});

// Parse the method names declared in the server's `DocmostClientLike` interface
// body. We read the .ts source as plain text (no TS compiler dep, and the file
// lives in the CJS server tree across the ESM boundary): scan from the
// `export interface DocmostClientLike {` line to its closing brace at column 0,
// matching member-signature lines like `  methodName(`. Nested param-object
// braces (`opts: { ... }`) are indented, so only the interface's own closing
// `}` (column 0) ends the scan.
function parseDocmostClientLikeMethods() {
  const here = dirname(fileURLToPath(import.meta.url));
  // packages/mcp/test/unit -> repo root is four levels up.
  const loaderPath = resolve(
    here,
    "../../../../apps/server/src/core/ai-chat/tools/docmost-client.loader.ts",
  );
  const source = readFileSync(loaderPath, "utf8");
  const lines = source.split(/\r?\n/);

  const startIdx = lines.findIndex((l) =>
    /^export interface DocmostClientLike\s*\{/.test(l),
  );
  assert.notEqual(
    startIdx,
    -1,
    `Could not find "export interface DocmostClientLike {" in ${loaderPath}. ` +
      `If the interface was renamed/moved, update this drift-guard test.`,
  );

  const methods = [];
  let closed = false;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\}/.test(line)) {
      closed = true;
      break;
    }
    const m = /^\s*([a-zA-Z]+)\(/.exec(line);
    if (m) methods.push(m[1]);
  }
  assert.ok(
    closed,
    `Did not find the closing brace of DocmostClientLike in ${loaderPath}.`,
  );
  assert.ok(
    methods.length > 0,
    `Parsed zero methods from DocmostClientLike in ${loaderPath} — the parser ` +
      `is likely out of date with the interface formatting.`,
  );
  return methods;
}

// The point of the guard is to protect the DocmostClientLike mirror <-> client.ts
// link, but HOST_CONTRACT_METHODS is itself a HAND-COPY of that interface kept in
// sync manually. The list<->interface link must be tested too: a method consumed
// by the adapter and added to DocmostClientLike but forgotten here (or removed
// from the interface but left here) would otherwise escape both the server
// typecheck (pkg emits no .d.ts) and the first test above (name not in the list).
// Assert the two agree BOTH ways.
test("HOST_CONTRACT_METHODS exactly mirrors the server's DocmostClientLike interface", () => {
  const interfaceMethods = parseDocmostClientLikeMethods();
  assert.deepEqual(
    [...HOST_CONTRACT_METHODS].sort(),
    [...interfaceMethods].sort(),
    `HOST_CONTRACT_METHODS has drifted from the DocmostClientLike interface in ` +
      `apps/server/src/core/ai-chat/tools/docmost-client.loader.ts. Add/remove ` +
      `method names in HOST_CONTRACT_METHODS so it lists EXACTLY the methods ` +
      `declared in that interface (both directions are checked).`,
  );
});
