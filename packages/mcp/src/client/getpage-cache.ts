// Content-addressed LRU cache for the PM->Markdown conversion in getPage
// (issue #479). getPage is the dominant agent op (812 calls / 2h, p95 840ms);
// the bulk of its cost is convertProseMirrorToMarkdown — a full ProseMirror-tree
// walk over the page content (hundreds of KB of JSON on large pages) run on
// EVERY read. Since agents re-read far more than they write (812 reads vs 28
// writes in the sample), most conversions re-produce the SAME markdown from
// UNCHANGED content. This cache skips the recomputation on a hit.
//
// KEY = (pageId, updatedAt, optionsHash):
//   - pageId: the page's CANONICAL UUID (resultData.id), not the agent-supplied
//     slugId — so a slugId read and a UUID read of the same page share one entry.
//   - updatedAt: comes from the SAME /pages/info response as `content`, so the
//     two are mutually consistent; a changed page yields a new updatedAt -> a new
//     key -> automatic, precise invalidation (no stale markdown is ever served).
//   - optionsHash: a stable hash of the conversion options. getPage passes
//     `{dropResolvedCommentAnchors:true}` while exportPageMarkdown passes the
//     defaults (#328) — DIFFERENT output for the same content, so the options
//     MUST be part of the key or a hit would serve the wrong variant.
//
// BOUNDS: evict the LEAST-recently-used entry when EITHER the entry count OR the
// total stored bytes would exceed its cap. Large pages are hundreds of KB, so a
// byte cap (not just a count cap) is what actually bounds memory. A Map iterates
// in insertion order, so the first key is the LRU entry; a hit re-inserts its key
// to move it to the most-recently-used end.
//
// This module is dependency-neutral (no axios/client/prom-client): a plain class
// the shared client context owns one instance of, so the cache persists across
// getPage calls on a single DocmostClient instance (built per user / per chat).

/** A stable, order-insensitive hash of the conversion options object. */
export function hashConvertOptions(options: unknown): string {
  // JSON.stringify with SORTED keys makes the hash independent of key order, so
  // {a:1,b:2} and {b:2,a:1} collapse to one entry. undefined/null options -> a
  // fixed empty-object key, matching a caller that passes no options at all.
  if (options === undefined || options === null) return "{}";
  return stableStringify(options);
}

function stableStringify(value: any): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(",")}}`;
}

interface CacheEntry {
  markdown: string;
  bytes: number;
}

export interface GetPageCacheOptions {
  /** Max number of entries before LRU eviction. Default 50. */
  maxEntries?: number;
  /** Max total stored bytes before LRU eviction. Default 10 MB. */
  maxBytes?: number;
}

export class GetPageConversionCache {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  // Insertion-ordered: the FIRST key is the least-recently-used entry.
  private readonly map = new Map<string, CacheEntry>();
  private totalBytes = 0;

  constructor(opts: GetPageCacheOptions = {}) {
    // A non-positive/NaN cap is treated as "use the default", never as an
    // unbounded (or always-empty) cache — a silently unbounded cache would leak
    // memory, and an always-empty one would defeat the whole optimization.
    this.maxEntries =
      Number.isFinite(opts.maxEntries) && (opts.maxEntries as number) > 0
        ? Math.floor(opts.maxEntries as number)
        : 50;
    this.maxBytes =
      Number.isFinite(opts.maxBytes) && (opts.maxBytes as number) > 0
        ? Math.floor(opts.maxBytes as number)
        : 10 * 1024 * 1024;
  }

  /** Compose the content-addressed key from its three parts. */
  static key(pageId: string, updatedAt: string, optionsHash: string): string {
    // A space separates the parts so no combination of values can collide by
    // concatenation: a canonical UUID and an ISO updatedAt never contain a
    // space, so the boundaries between the three parts are unambiguous.
    return `${pageId} ${updatedAt} ${optionsHash}`;
  }

  /**
   * Return the cached markdown for `key`, or undefined on a miss. A hit moves
   * the entry to the most-recently-used end (delete + re-set) so the LRU order
   * reflects real access, not just insertion.
   */
  get(key: string): string | undefined {
    const entry = this.map.get(key);
    if (entry === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.markdown;
  }

  /**
   * Store `markdown` under `key`, then evict LRU entries until BOTH caps hold.
   * Re-storing an existing key refreshes its value and recency (its old bytes
   * are subtracted first, so totalBytes stays exact).
   */
  set(key: string, markdown: string): void {
    // Byte size of the stored string (UTF-8). A single entry larger than the
    // whole byte cap is still stored (so getPage always gets a hit next time),
    // then the eviction loop below simply cannot shrink below it — accepted:
    // one oversized page is bounded by the page itself, not a cache leak.
    const bytes = Buffer.byteLength(markdown, "utf8");
    const existing = this.map.get(key);
    if (existing !== undefined) {
      this.totalBytes -= existing.bytes;
      this.map.delete(key);
    }
    this.map.set(key, { markdown, bytes });
    this.totalBytes += bytes;
    this.evict();
  }

  /** Evict the LRU entry until both the count and byte caps are satisfied. */
  private evict(): void {
    while (
      this.map.size > this.maxEntries ||
      (this.totalBytes > this.maxBytes && this.map.size > 1)
    ) {
      // The first key in insertion order is the least-recently-used.
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const entry = this.map.get(oldest);
      this.map.delete(oldest);
      if (entry) this.totalBytes -= entry.bytes;
    }
  }

  /** Current entry count (test/introspection). */
  get size(): number {
    return this.map.size;
  }

  /** Current total stored bytes (test/introspection). */
  get bytes(): number {
    return this.totalBytes;
  }
}
