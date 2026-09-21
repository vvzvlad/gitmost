import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import catalog from "./lucide-catalog.generated";
import { loadIconModel } from "../../../../scripts/lucide-imports.mjs";
import { CATEGORY_TITLES } from "./lucide-categories";
import { CURATED_ICON_NAMES } from "./curated-icons";
import degradedAllowlist from "./lucide-catalog.degraded-allowlist.json";

// Guard test for the committed catalog artifact (issue #696). It FAILS the build
// on any drift between the artifact and the INSTALLED lucide-react — a bump
// without regeneration, a hand-edited version, a removed icon — and on a
// non-empty `degraded` that is not a deliberate, allow-listed offline release.
// Replaces the former curated-icons.test.ts (its check lives on as #5 below).
describe("lucide-catalog.generated", () => {
  const require = createRequire(import.meta.url);
  const installedVersion: string = require("lucide-react/package.json").version;
  const model = loadIconModel(import.meta.url);
  const canonical = [...model.canonical].sort();
  const aliasKeys = Object.keys(model.aliases).sort();

  const sorted = (a: string[]) => [...a].sort();

  it("1. catalog.v is the INSTALLED lucide-react version", () => {
    expect(catalog.v).toBe(installedVersion);
  });

  it("2. icons/tags/primary key sets equal the canonical set", () => {
    expect(sorted(Object.keys(catalog.icons))).toEqual(canonical);
    expect(sorted(Object.keys(catalog.tags))).toEqual(canonical);
    expect(sorted(Object.keys(catalog.primary))).toEqual(canonical);
  });

  it("3. aliases equal the derived alias set; every target is a canonical icon", () => {
    expect(sorted(Object.keys(catalog.aliases))).toEqual(aliasKeys);
    const iconKeys = new Set(Object.keys(catalog.icons));
    for (const [alias, target] of Object.entries(catalog.aliases)) {
      expect(iconKeys.has(target), `${alias} → ${target}`).toBe(true);
    }
  });

  it("4. every primary category slug has a title", () => {
    for (const slug of new Set(Object.values(catalog.primary))) {
      expect(CATEGORY_TITLES[slug], `missing title for "${slug}"`).toBeTruthy();
    }
  });

  it("5. every curated name is a canonical icon (NOT an alias)", () => {
    const iconKeys = new Set(Object.keys(catalog.icons));
    const missing = CURATED_ICON_NAMES.filter((n) => !iconKeys.has(n));
    expect(missing).toEqual([]);
    expect(new Set(CURATED_ICON_NAMES).size).toBe(CURATED_ICON_NAMES.length);
  });

  it("6. every icon has tags and a primary slug present (empty tags / 'other' ok)", () => {
    for (const name of Object.keys(catalog.icons)) {
      expect(Array.isArray(catalog.tags[name]), `tags[${name}]`).toBe(true);
      expect(typeof catalog.primary[name], `primary[${name}]`).toBe("string");
    }
  });

  it("6b. every icon node is a non-empty array of [tag, attrs] tuples (guards VALUE corruption, not just keys)", () => {
    // Inv #2 only checks the icon KEYS. A hand/merge-edit of the 800 KB single-line
    // blob can leave the keys intact but replace a node with []/null/garbage tuples;
    // that would pass every other invariant yet render broken/empty icons. Since this
    // committed artifact is the only develop-side guard against such an edit, pin the
    // geometry shape itself (lucide's Icon does iconNode.map(([tag, attrs]) => ...)).
    for (const name of Object.keys(catalog.icons)) {
      const node = catalog.icons[name] as unknown;
      expect(Array.isArray(node) && node.length > 0, `icons[${name}] must be a non-empty array`).toBe(true);
      for (const el of node as unknown[]) {
        expect(Array.isArray(el) && el.length === 2, `icons[${name}] element must be a [tag, attrs] tuple`).toBe(true);
        const tuple = el as unknown[];
        expect(typeof tuple[0], `icons[${name}] tuple tag`).toBe("string");
        expect(typeof tuple[1] === "object" && tuple[1] !== null, `icons[${name}] tuple attrs`).toBe(true);
      }
    }
  });

  it("7. degraded is empty, or exactly the deliberate offline allowlist", () => {
    expect(sorted(catalog.degraded)).toEqual(sorted(degradedAllowlist as string[]));
  });

  it("8. the image-smoke S5 sentinel tag exists in the catalog (keeps S5 non-vacuous)", () => {
    // scripts/ci/image-smoke.sh S5 greps eager bundles for this tag to prove the
    // catalog stays a lazy-only chunk. If a lucide bump renames the tag it would
    // vanish from EVERY chunk and S5 would pass on absence (vacuous-green). Pin the
    // sentinel's existence here so a rename reddens this test -> update both together.
    const SENTINEL = "firefighter";
    const present = Object.values(catalog.tags).some((ts) => (ts as string[]).includes(SENTINEL));
    expect(present, `S5 sentinel '${SENTINEL}' must exist in the catalog tags`).toBe(true);
  });
});
