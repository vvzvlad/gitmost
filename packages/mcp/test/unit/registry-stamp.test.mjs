import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readdirSync,
  statSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { createHash } from "node:crypto";

import { computeRegistryStamp } from "../../scripts/gen-registry-stamp.mjs";
import { REGISTRY_STAMP } from "../../build/index.js";

// Guard tests for the build/src-skew stamp (issues #447/#486). The codegen script
// exports `computeRegistryStamp(srcDir)` — a sha256 over the WHOLE src/ tree
// (every src/**/*.ts EXCEPT *.generated.ts), each file folded in as its
// POSIX-relative path + its normalized content (CRLF->LF, single trailing newline
// stripped). Hashing the whole tree (not just tool-specs.ts) is #486: an edit to
// client.ts / a client/* module without a rebuild must ALSO redden. The in-app
// loader (apps/server/.../docmost-client.loader.ts) DUPLICATES this enumerate+
// normalize+sha256 to refuse a stale build. These tests pin the algorithm and
// assert the built stamp matches the current src.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, "..", "..", "src");

// Build a throwaway src/ tree from a { relPath: content } map and return its dir.
function makeSrcTree(files) {
  const root = mkdtempSync(join(tmpdir(), "mcp-stamp-tree-"));
  const src = join(root, "src");
  for (const [rel, content] of Object.entries(files)) {
    const full = join(src, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return { src, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("computeRegistryStamp is deterministic: same tree -> same hash", () => {
  const a = makeSrcTree({ "tool-specs.ts": "export const X = 1;\n" });
  const b = makeSrcTree({ "tool-specs.ts": "export const X = 1;\n" });
  try {
    assert.equal(computeRegistryStamp(a.src), computeRegistryStamp(b.src));
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("computeRegistryStamp returns a 64-char lowercase hex sha256", () => {
  const t = makeSrcTree({ "tool-specs.ts": "anything\n" });
  try {
    assert.match(computeRegistryStamp(t.src), /^[0-9a-f]{64}$/);
  } finally {
    t.cleanup();
  }
});

// #486 CORE: an edit to a NON-tool-specs source file (client.ts) must change the
// stamp. Under the old single-file (tool-specs.ts only) hash this edit was
// invisible and a stale build/ served the old client.ts silently.
test("editing client.ts (not tool-specs.ts) changes the stamp (#486)", () => {
  const before = makeSrcTree({
    "tool-specs.ts": "export const SPECS = 1;\n",
    "client.ts": "export const impl = 'v1';\n",
  });
  const after = makeSrcTree({
    "tool-specs.ts": "export const SPECS = 1;\n",
    "client.ts": "export const impl = 'v2';\n",
  });
  try {
    assert.notEqual(
      computeRegistryStamp(before.src),
      computeRegistryStamp(after.src),
      "a client.ts edit with an unchanged tool-specs.ts must move the stamp",
    );
  } finally {
    before.cleanup();
    after.cleanup();
  }
});

test("editing a nested client/* module changes the stamp", () => {
  const before = makeSrcTree({
    "tool-specs.ts": "x\n",
    "client/read.ts": "export const READ = 1;\n",
  });
  const after = makeSrcTree({
    "tool-specs.ts": "x\n",
    "client/read.ts": "export const READ = 2;\n",
  });
  try {
    assert.notEqual(
      computeRegistryStamp(before.src),
      computeRegistryStamp(after.src),
    );
  } finally {
    before.cleanup();
    after.cleanup();
  }
});

// *.generated.ts is EXCLUDED (else the codegen's own output is a fixed-point
// cycle): adding/removing/changing it must not move the stamp.
test("*.generated.ts is excluded from the stamp", () => {
  const without = makeSrcTree({ "tool-specs.ts": "x\n" });
  const withGen = makeSrcTree({
    "tool-specs.ts": "x\n",
    "registry-stamp.generated.ts": 'export const REGISTRY_STAMP = "abc";\n',
  });
  try {
    assert.equal(
      computeRegistryStamp(without.src),
      computeRegistryStamp(withGen.src),
      "a *.generated.ts file must not affect the stamp",
    );
  } finally {
    without.cleanup();
    withGen.cleanup();
  }
});

test("a CRLF checkout WITH trailing CRLF hashes equal to bare LF", () => {
  const bare = makeSrcTree({ "tool-specs.ts": "alpha\nbeta" });
  const crlfTrailing = makeSrcTree({ "tool-specs.ts": "alpha\r\nbeta\r\n" });
  try {
    assert.equal(
      computeRegistryStamp(crlfTrailing.src),
      computeRegistryStamp(bare.src),
    );
  } finally {
    bare.cleanup();
    crlfTrailing.cleanup();
  }
});

// Only a SINGLE trailing newline is stripped — a second blank line is content.
test("only ONE trailing newline is stripped (two differ from one)", () => {
  const one = makeSrcTree({ "tool-specs.ts": "x\n" });
  const two = makeSrcTree({ "tool-specs.ts": "x\n\n" });
  try {
    assert.notEqual(
      computeRegistryStamp(one.src),
      computeRegistryStamp(two.src),
    );
  } finally {
    one.cleanup();
    two.cleanup();
  }
});

// Cross-impl equality against a fixed, documented tree. The SAME literal tree and
// expected hash are asserted in the server-side jest test
// (docmost-client.loader.spec.ts). If either side's enumerate+normalize+sha256
// ever diverges, one of the two tests reddens. The tree exercises: a nested file,
// BOTH normalize steps (tool-specs.ts uses CRLF + trailing \n) and the
// *.generated.ts exclusion.
const CROSS_IMPL_TREE = {
  "tool-specs.ts": "line1\r\nline2\n",
  "client/read.ts": "export const R = 1;\n",
  "registry-stamp.generated.ts": 'export const REGISTRY_STAMP="ignored";\n',
};
const CROSS_IMPL_EXPECTED =
  "131c1b9e4e2f5a7d6cef91ca8df619822b442f52bc45ebd09474a4c1d6728616";

test("fixed-tree hash matches the documented cross-impl value", () => {
  const t = makeSrcTree(CROSS_IMPL_TREE);
  try {
    assert.equal(computeRegistryStamp(t.src), CROSS_IMPL_EXPECTED);
  } finally {
    t.cleanup();
  }
});

// Sanity: the EXPECTED constant is not a magic value but the documented
// enumerate+normalize+sha256 of CROSS_IMPL_TREE (a local re-implementation).
test("the documented EXPECTED is the enumerate+normalize+sha256 of the tree", () => {
  const t = makeSrcTree(CROSS_IMPL_TREE);
  try {
    const collect = (dir) => {
      const out = [];
      for (const e of readdirSync(dir)) {
        const f = join(dir, e);
        if (statSync(f).isDirectory()) out.push(...collect(f));
        else if (e.endsWith(".ts") && !e.endsWith(".generated.ts")) out.push(f);
      }
      return out;
    };
    const files = collect(t.src)
      .map((abs) => ({ rel: relative(t.src, abs).split(sep).join("/"), abs }))
      .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    const h = createHash("sha256");
    for (const { rel, abs } of files) {
      const n = readFileSync(abs, "utf8")
        .replace(/\r\n/g, "\n")
        .replace(/\n$/, "");
      h.update(rel, "utf8");
      h.update("\0", "utf8");
      h.update(n, "utf8");
      h.update("\0", "utf8");
    }
    assert.equal(h.digest("hex"), CROSS_IMPL_EXPECTED);
  } finally {
    t.cleanup();
  }
});

// DESYNC GUARD. Recompute the stamp from the REAL src/ tree and assert it equals
// the REGISTRY_STAMP baked into the freshly-built build/index.js. This reddens if
// the generated file is stale OR if the codegen ever diverges from what produced
// the built stamp.
test("built REGISTRY_STAMP equals the stamp recomputed from src/", () => {
  assert.equal(computeRegistryStamp(SRC_DIR), REGISTRY_STAMP);
});
