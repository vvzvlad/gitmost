// Pure, framework-free logic for the Lucide icon picker: canonicalization, the
// browse (empty-query) row model, ranked search, and Russian-word expansion.
// Kept out of the component so it is unit-testable without a virtualizer (jsdom
// stubs ResizeObserver to a no-op, so the grid never measures — rendering it in
// a test proves nothing; these functions carry the behavioural guarantees).
import type { LucideCatalog } from "./lucide-catalog.generated";
import { CATEGORY_TITLES, OTHER_SLUG } from "./lucide-categories";
import { RU_ICON_SYNONYMS } from "./ru-icon-synonyms";

// 8 icon buttons per grid row (grid is 8 columns).
export const ICONS_PER_ROW = 8;
// Fixed row heights (px), forced inline on each row wrapper so a wrapped header
// title cannot drift from the virtualizer's estimateSize.
export const HEADER_ROW_HEIGHT = 26;
export const ICON_ROW_HEIGHT = 34;

/** Flat virtualizer row model. `id` encodes the row KIND so keys never collide
 * across the two row models (browse vs. results / limited). */
export type IconRow =
  | { kind: "header"; id: string; title: string }
  | { kind: "icons"; id: string; names: string[] };

const CYRILLIC = /[а-яё]/;

/**
 * The canonical icon name for any picker name. A name that is already canonical
 * (a key of `icons`) returns itself; an alias resolves to its canonical; an
 * unknown name is returned untouched (the caller guards rendering).
 */
export function canonicalOf(catalog: LucideCatalog, name: string): string {
  if (name in catalog.icons) return name;
  const aliased = catalog.aliases[name];
  return aliased ?? name;
}

/** Number of UNIQUE canonical icons in the catalog (the browse-mode counter). */
export function catalogIconCount(catalog: LucideCatalog): number {
  return Object.keys(catalog.icons).length;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function pushIconRows(rows: IconRow[], section: string, names: string[]): void {
  chunk(names, ICONS_PER_ROW).forEach((names, i) =>
    rows.push({ kind: "icons", id: `r:${section}:${i}`, names }),
  );
}

/**
 * Browse (empty-query) rows: a "Popular" section (the curated set, canonicalized
 * and deduped, order preserved), then one section per category sorted BY SLUG
 * (stable across locales), names alphabetical within a section. The synthetic
 * `other` section (icons with no category) is rendered LAST and only if non-empty.
 * Curated icons also appear in their own category — categories stay complete.
 */
export function buildBrowseRows(
  catalog: LucideCatalog,
  curated: string[],
): IconRow[] {
  const rows: IconRow[] = [];

  // Popular: canonicalize + dedupe, preserving curated order.
  const seen = new Set<string>();
  const popular: string[] = [];
  for (const name of curated) {
    const canon = canonicalOf(catalog, name);
    if (!seen.has(canon)) {
      seen.add(canon);
      popular.push(canon);
    }
  }
  rows.push({ kind: "header", id: "h:popular", title: "Popular" });
  pushIconRows(rows, "popular", popular);

  // Categories by primary slug.
  const byCat = new Map<string, string[]>();
  for (const name of Object.keys(catalog.icons)) {
    const slug = catalog.primary[name] ?? OTHER_SLUG;
    const arr = byCat.get(slug);
    if (arr) arr.push(name);
    else byCat.set(slug, [name]);
  }

  const slugs = [...byCat.keys()].filter((s) => s !== OTHER_SLUG).sort();
  for (const slug of slugs) {
    const names = byCat.get(slug)!.slice().sort();
    rows.push({ kind: "header", id: `h:${slug}`, title: CATEGORY_TITLES[slug] ?? slug });
    pushIconRows(rows, slug, names);
  }

  const other = byCat.get(OTHER_SLUG);
  if (other && other.length) {
    rows.push({
      kind: "header",
      id: `h:${OTHER_SLUG}`,
      title: CATEGORY_TITLES[OTHER_SLUG],
    });
    pushIconRows(rows, OTHER_SLUG, other.slice().sort());
  }

  return rows;
}

/** Flat result rows (no section headers) from a ranked name list. */
export function buildResultRows(names: string[]): IconRow[] {
  const rows: IconRow[] = [];
  pushIconRows(rows, "results", names);
  return rows;
}

/**
 * Expand ONE query word into English search terms. A Russian word maps through
 * {@link RU_ICON_SYNONYMS} with rough stemming (`key.startsWith(word) ||
 * word.startsWith(key)`); an unknown Russian word contributes nothing. A Latin
 * word inside a Russian query is its own term (so "дом wifi" keeps "wifi").
 */
export function expandRu(word: string): string[] {
  const terms = new Set<string>();
  for (const [key, vals] of Object.entries(RU_ICON_SYNONYMS)) {
    if (key.startsWith(word) || word.startsWith(key)) {
      for (const t of vals) terms.add(t);
    }
  }
  if (!CYRILLIC.test(word)) terms.add(word);
  return [...terms];
}

// Rank of one canonical icon against one term (lower = better; Infinity = no
// match). Ranks: 0 exact name, 1 name-prefix, 2 name-substring, 3 alias,
// 4 exact tag, 5 tag-prefix.
function iconTermRank(
  name: string,
  term: string,
  tags: string[],
  aliases: string[],
): number {
  let best = Infinity;
  if (name === term) return 0;
  if (name.startsWith(term)) best = Math.min(best, 1);
  else if (name.includes(term)) best = Math.min(best, 2);
  for (const alias of aliases) {
    if (alias === term || alias.startsWith(term) || alias.includes(term)) {
      best = Math.min(best, 3);
      break;
    }
  }
  for (const tag of tags) {
    if (tag === term) {
      best = Math.min(best, 4);
      break;
    }
  }
  if (best > 5) {
    for (const tag of tags) {
      if (tag.startsWith(term)) {
        best = Math.min(best, 5);
        break;
      }
    }
  }
  return best;
}

/**
 * Ranked canonical-name search. Semantics: terms of ONE word are OR'd (word rank
 * = min over its terms); words are AND'd (icon rank = max over words; an icon is
 * dropped if any word has no matching term). Russian queries expand each word
 * via {@link expandRu}; if no word yields a term the result is empty (no
 * substring search over Cyrillic). Latin queries use each word as a literal term.
 * Sorted by rank then name; each canonical icon appears at most once.
 */
export function searchIcons(catalog: LucideCatalog, rawQuery: string): string[] {
  const query = rawQuery.trim().toLowerCase();
  if (query === "") return [];
  const words = query.split(/\s+/).filter(Boolean);
  const cyrillic = CYRILLIC.test(query);

  const perWordTerms = words.map((w) => (cyrillic ? expandRu(w) : [w]));
  const effective = perWordTerms.filter((terms) => terms.length > 0);
  if (effective.length === 0) return [];

  // Reverse alias map: canonical → its alias keys (for the rank-3 alias match).
  const aliasesByCanon = new Map<string, string[]>();
  for (const [alias, canon] of Object.entries(catalog.aliases)) {
    const arr = aliasesByCanon.get(canon);
    if (arr) arr.push(alias);
    else aliasesByCanon.set(canon, [alias]);
  }

  const scored: { name: string; rank: number }[] = [];
  for (const name of Object.keys(catalog.icons)) {
    const tags = catalog.tags[name] ?? [];
    const aliases = aliasesByCanon.get(name) ?? [];
    let overall = 0;
    let matched = true;
    for (const terms of effective) {
      let wordRank = Infinity;
      for (const term of terms) {
        const r = iconTermRank(name, term, tags, aliases);
        if (r < wordRank) wordRank = r;
        if (wordRank === 0) break;
      }
      if (wordRank === Infinity) {
        matched = false;
        break;
      }
      if (wordRank > overall) overall = wordRank;
    }
    if (matched) scored.push({ name, rank: overall });
  }

  scored.sort((a, b) =>
    a.rank !== b.rank ? a.rank - b.rank : a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  return scored.map((s) => s.name);
}
