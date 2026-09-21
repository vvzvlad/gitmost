import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EDITOR_AUTO_UPDATE_OPTIONS } from "./floating-auto-update";

describe("EDITOR_AUTO_UPDATE_OPTIONS", () => {
  it("disables layoutShift", () => {
    expect(EDITOR_AUTO_UPDATE_OPTIONS.layoutShift).toBe(false);
  });
});

/**
 * Drift guard (F1). The three table handles are covered by a behavioral test
 * (`components/table/handle/floating-auto-update.test.tsx`), but the remaining
 * anchors — slash menu, emoji menu, mentions, footnote popover — are imperative
 * `autoUpdate(...)` calls inside Tiptap suggestion renderers with no component
 * to mount. This scan makes sure NO call site (existing or newly added) starts
 * an `autoUpdate` without the shared options, which is exactly the regression
 * that produced the Safari CPU burn.
 */
const CLIENT_SRC = join(__dirname, "..", "..", "..");
// The shared editor extensions have no floating-ui anchor today; scanning them
// too means a future one cannot be added without this test noticing.
const EDITOR_EXT_SRC = join(
  __dirname,
  "..","..","..","..","..","..",
  "packages",
  "editor-ext",
  "src",
);

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      collectFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Comments must go before anything is counted: every guarded call site carries
 * a pointer comment that NAMES the constant, so any "does the text mention it"
 * check is satisfied by the comment alone and would pass a genuinely unguarded
 * call.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * The ARGUMENT TEXT of each `autoUpdate(...)` invocation, matched with a paren
 * depth counter rather than a regex — several call sites pass an inline
 * callback, so the argument list contains nested parentheses.
 */
function autoUpdateCallArgs(source: string): string[] {
  const code = stripComments(source);
  const calls: string[] = [];
  const re = /\bautoUpdate\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(code)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < code.length && depth > 0) {
      const ch = code[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      i++;
    }
    calls.push(code.slice(re.lastIndex, i - 1));
  }
  return calls;
}

function countGuardedCalls(source: string): number {
  return autoUpdateCallArgs(source).filter((args) =>
    args.includes("EDITOR_AUTO_UPDATE_OPTIONS"),
  ).length;
}

function countAutoUpdateCalls(source: string): number {
  return autoUpdateCallArgs(source).length;
}

describe("every autoUpdate call site opts out of layoutShift", () => {
  it("passes EDITOR_AUTO_UPDATE_OPTIONS at every call, not just once per file", () => {
    const offenders: string[] = [];
    let scannedFiles = 0;
    let totalCalls = 0;

    for (const root of [CLIENT_SRC, EDITOR_EXT_SRC]) {
      // A wrong root would make this test vacuously green.
      expect(existsSync(root)).toBe(true);
      for (const file of collectFiles(root)) {
        scannedFiles++;
        const source = readFileSync(file, "utf8");
        const calls = countAutoUpdateCalls(source);
        if (calls === 0) continue;
        totalCalls += calls;
        // The constant must appear INSIDE each invocation's argument list —
        // not merely somewhere in the file, and not in a comment. That is what
        // catches a second `autoUpdate(` added to an already-guarded file.
        const guarded = countGuardedCalls(source);
        if (guarded < calls) {
          offenders.push(
            `${file.slice(root.length + 1)} (${calls} calls, ${guarded} guarded)`,
          );
        }
      }
    }

    expect(offenders).toEqual([]);
    // The 7 known anchors: 3 table handles, slash/emoji/mention menus, the
    // footnote popover. A drop below that means the scan stopped seeing them.
    expect(scannedFiles).toBeGreaterThan(100);
    expect(totalCalls).toBeGreaterThanOrEqual(7);
  });

  it("catches a second, unguarded call in an already-guarded file", () => {
    const source = `import { EDITOR_AUTO_UPDATE_OPTIONS } from "x";
      // uses EDITOR_AUTO_UPDATE_OPTIONS — see the shared module
      autoUpdate(a, b, c, EDITOR_AUTO_UPDATE_OPTIONS);
      autoUpdate(d, e, f);`;

    expect(countAutoUpdateCalls(source)).toBe(2);
    expect(countGuardedCalls(source)).toBe(1);
  });

  it("is not fooled by a comment that merely mentions the constant", () => {
    const source = `import { autoUpdate } from "@floating-ui/dom";
      // EDITOR_AUTO_UPDATE_OPTIONS should be passed here one day
      /* EDITOR_AUTO_UPDATE_OPTIONS */
      autoUpdate(a, b, c);`;

    expect(countAutoUpdateCalls(source)).toBe(1);
    expect(countGuardedCalls(source)).toBe(0);
  });

  it("counts a guarded call whose arguments contain nested parentheses", () => {
    const source = `autoUpdate(
        virtualElement,
        popup,
        () => {
          computePosition(virtualElement, popup, { middleware: [offset(10)] });
        },
        EDITOR_AUTO_UPDATE_OPTIONS,
      );`;

    expect(countAutoUpdateCalls(source)).toBe(1);
    expect(countGuardedCalls(source)).toBe(1);
  });
});
