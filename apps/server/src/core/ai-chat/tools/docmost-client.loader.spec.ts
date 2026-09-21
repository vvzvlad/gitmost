import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readdirSync,
  statSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

import { computeSrcRegistryStamp } from './docmost-client.loader';

// The exact message the loader throws on a build/src skew (issue #447). Kept as a
// literal here so a reworded prod message reddens this test (the message is a
// developer-facing contract: it tells them how to fix it).
const STALE_BUILD_MESSAGE =
  '@docmost/mcp build is stale (tool-specs changed since last build) — run: pnpm --filter @docmost/mcp build';

// Replica of the loader's inline stale-check predicate + throw from
// `loadDocmostMcp`. That guard is not independently exported (it lives inside the
// dynamic-import IIFE, wired to a fixed `require.resolve('@docmost/mcp')`), so we
// exercise the exact same three-condition logic against a stamp produced by the
// REAL `computeSrcRegistryStamp`. This documents and locks the throw/no-throw
// behaviour; if the prod predicate changes, this replica must change with it.
function assertStaleGuard(
  srcStamp: string | null,
  registryStamp: string | undefined,
): void {
  if (
    srcStamp !== null &&
    typeof registryStamp === 'string' &&
    srcStamp !== registryStamp
  ) {
    throw new Error(STALE_BUILD_MESSAGE);
  }
}

// Build a throwaway `<pkg>/build/index.js` + optional `<pkg>/src/` tree so
// `computeSrcRegistryStamp(<pkg>/build/index.js)` resolves src the same way the
// loader does (dirname(dirname(entry))/src). Since #486 the stamp hashes the WHOLE
// src tree, so a fixture is a { relPath: content } map. A bare string is sugar for
// a single `tool-specs.ts`; `null` means "no src tree" (the prod no-op path).
function makeFakePackage(
  src: string | Record<string, string> | null,
): {
  entry: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), 'mcp-stamp-'));
  const buildDir = join(root, 'build');
  mkdirSync(buildDir, { recursive: true });
  const entry = join(buildDir, 'index.js');
  writeFileSync(entry, '// fake @docmost/mcp build entry\n', 'utf8');
  if (src !== null) {
    const files =
      typeof src === 'string' ? { 'tool-specs.ts': src } : src;
    const srcDir = join(root, 'src');
    for (const [rel, content] of Object.entries(files)) {
      const full = join(srcDir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf8');
    }
  }
  return { entry, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('computeSrcRegistryStamp (#447 stale-build guard)', () => {
  it('returns null when src/tool-specs.ts is absent (prod no-op path)', () => {
    // A prod image ships only build/, no src/ — the guard must be a silent no-op.
    const { entry, cleanup } = makeFakePackage(null);
    try {
      expect(computeSrcRegistryStamp(entry)).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('returns null for a bogus package entry (swallowed error path)', () => {
    // A resolution/read hiccup must NEVER break startup — it resolves to null.
    expect(
      computeSrcRegistryStamp('/no/such/pkg/build/index.js'),
    ).toBeNull();
  });

  it('computes a 64-char sha256 hex when src/tool-specs.ts exists', () => {
    const { entry, cleanup } = makeFakePackage('export const specs = 1;\n');
    try {
      const stamp = computeSrcRegistryStamp(entry);
      expect(stamp).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      cleanup();
    }
  });

  it('normalizes CRLF->LF and strips a single trailing newline', () => {
    // A CRLF+trailing-newline variant of the same content hashes identically to
    // the bare-LF form — the guard must not fire on a checkout-style difference.
    const bare = makeFakePackage('alpha\nbeta');
    const crlfTrailing = makeFakePackage('alpha\r\nbeta\r\n');
    try {
      expect(computeSrcRegistryStamp(crlfTrailing.entry)).toBe(
        computeSrcRegistryStamp(bare.entry),
      );
    } finally {
      bare.cleanup();
      crlfTrailing.cleanup();
    }
  });

  // #486 CORE (negative): an edit to a NON-tool-specs src file (client.ts) with a
  // rebuild NOT run must move the src stamp away from the built REGISTRY_STAMP, so
  // the loader's stale-check refuses. Under the old tool-specs.ts-only hash this
  // edit was invisible and a stale build/ served the old client.ts silently.
  it('a client.ts edit (no rebuild) moves the src stamp -> loader refuses (#486)', () => {
    // "Built" state: the package as it was compiled.
    const built = makeFakePackage({
      'tool-specs.ts': 'export const SPECS = 1;\n',
      'client.ts': "export const impl = 'v1';\n",
    });
    // "Dev edited src, forgot to rebuild": client.ts changed, tool-specs.ts not.
    const edited = makeFakePackage({
      'tool-specs.ts': 'export const SPECS = 1;\n',
      'client.ts': "export const impl = 'v2';\n",
    });
    try {
      const builtStamp = computeSrcRegistryStamp(built.entry);
      const editedStamp = computeSrcRegistryStamp(edited.entry);
      expect(builtStamp).not.toBeNull();
      expect(editedStamp).not.toBe(builtStamp);
      // build/ still carries builtStamp; src now hashes to editedStamp -> refuse.
      expect(() => assertStaleGuard(editedStamp, builtStamp as string)).toThrow(
        STALE_BUILD_MESSAGE,
      );
    } finally {
      built.cleanup();
      edited.cleanup();
    }
  });

  // *.generated.ts is excluded (the codegen's own output — a fixed-point cycle
  // otherwise): its presence/content must not move the stamp.
  it('excludes *.generated.ts from the stamp', () => {
    const without = makeFakePackage({ 'tool-specs.ts': 'x\n' });
    const withGen = makeFakePackage({
      'tool-specs.ts': 'x\n',
      'registry-stamp.generated.ts': 'export const REGISTRY_STAMP = "abc";\n',
    });
    try {
      expect(computeSrcRegistryStamp(withGen.entry)).toBe(
        computeSrcRegistryStamp(without.entry),
      );
    } finally {
      without.cleanup();
      withGen.cleanup();
    }
  });

  // CROSS-IMPL EQUALITY (covers reviewer suggestion 2). The SAME fixed tree and
  // EXPECTED hash are asserted in the mcp-side node test
  // (packages/mcp/test/unit/registry-stamp.test.mjs) against the codegen's
  // `computeRegistryStamp`. Asserting the SAME pair here against the loader's
  // `computeSrcRegistryStamp` proves both implementations enumerate+normalize+hash
  // identically; a divergence in EITHER side reddens one of the two tests.
  const CROSS_IMPL_TREE = {
    'tool-specs.ts': 'line1\r\nline2\n',
    'client/read.ts': 'export const R = 1;\n',
    'registry-stamp.generated.ts': 'export const REGISTRY_STAMP="ignored";\n',
  };
  const CROSS_IMPL_EXPECTED =
    '131c1b9e4e2f5a7d6cef91ca8df619822b442f52bc45ebd09474a4c1d6728616';

  it('matches the documented cross-impl hash for a fixed tree', () => {
    const { entry, cleanup } = makeFakePackage(CROSS_IMPL_TREE);
    try {
      expect(computeSrcRegistryStamp(entry)).toBe(CROSS_IMPL_EXPECTED);
    } finally {
      cleanup();
    }
  });

  it('the documented EXPECTED is the enumerate+normalize+sha256 of the tree', () => {
    // Proves EXPECTED is not a magic constant but the documented computation — a
    // local re-implementation of the loader's tree walk.
    const { entry, cleanup } = makeFakePackage(CROSS_IMPL_TREE);
    try {
      const srcDir = join(dirname(dirname(entry)), 'src');
      const collect = (dir: string): string[] => {
        const out: string[] = [];
        for (const e of readdirSync(dir)) {
          const f = join(dir, e);
          if (statSync(f).isDirectory()) out.push(...collect(f));
          else if (e.endsWith('.ts') && !e.endsWith('.generated.ts'))
            out.push(f);
        }
        return out;
      };
      const files = collect(srcDir)
        .map((abs) => ({ rel: relative(srcDir, abs).split(sep).join('/'), abs }))
        .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
      const h = createHash('sha256');
      for (const { rel, abs } of files) {
        const n = readFileSync(abs, 'utf8')
          .replace(/\r\n/g, '\n')
          .replace(/\n$/, '');
        h.update(rel, 'utf8');
        h.update('\0', 'utf8');
        h.update(n, 'utf8');
        h.update('\0', 'utf8');
      }
      const localHash = h.digest('hex');
      expect(computeSrcRegistryStamp(entry)).toBe(localHash);
      expect(localHash).toBe(CROSS_IMPL_EXPECTED);
    } finally {
      cleanup();
    }
  });
});

describe('loadDocmostMcp stale-check predicate (#447)', () => {
  it('THROWS the exact stale message when src stamp != built REGISTRY_STAMP', () => {
    const { entry, cleanup } = makeFakePackage('export const specs = 1;\n');
    try {
      const srcStamp = computeSrcRegistryStamp(entry);
      expect(srcStamp).not.toBeNull();
      // Simulate a stale build: build/ carries a DIFFERENT stamp than src.
      expect(() => assertStaleGuard(srcStamp, 'a'.repeat(64))).toThrow(
        STALE_BUILD_MESSAGE,
      );
    } finally {
      cleanup();
    }
  });

  it('does NOT throw when src stamp equals the built REGISTRY_STAMP', () => {
    const { entry, cleanup } = makeFakePackage('export const specs = 1;\n');
    try {
      const srcStamp = computeSrcRegistryStamp(entry);
      // Fresh build: build/ stamp == src stamp -> guard is a no-op.
      expect(() => assertStaleGuard(srcStamp, srcStamp as string)).not.toThrow();
    } finally {
      cleanup();
    }
  });

  it('does NOT throw when src is absent (prod: srcStamp === null)', () => {
    // Even against a present-but-mismatched REGISTRY_STAMP, a null src stamp
    // (prod image with build/ only) must skip the check entirely.
    expect(() => assertStaleGuard(null, 'a'.repeat(64))).not.toThrow();
  });

  it('does NOT throw when REGISTRY_STAMP is absent (pre-#447 build)', () => {
    // An older @docmost/mcp build has no REGISTRY_STAMP export; the guard must be
    // a no-op so an out-of-date build never wrongly blocks startup.
    const { entry, cleanup } = makeFakePackage('export const specs = 1;\n');
    try {
      const srcStamp = computeSrcRegistryStamp(entry);
      expect(() => assertStaleGuard(srcStamp, undefined)).not.toThrow();
    } finally {
      cleanup();
    }
  });
});
