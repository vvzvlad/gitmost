// Module singleton that owns the lazily-imported Lucide catalog chunk.
//
// The dropdown content of both pickers renders only while `opened`, so two grids
// are never mounted at once — but a session opens the picker many times (every
// sidebar tree row has its own PageIconPicker). Without this singleton EVERY
// open would re-enter `loading` and rebuild the ~2000-row model from scratch;
// with it the first open pays the import, later opens read the resolved value
// synchronously and render `ready` immediately.
//
// The catalog lives in its OWN chunk (the only `import()` of the generated file),
// so ~700 KB never enters the entry bundle.
import type { LucideCatalog } from "./lucide-catalog.generated";

let catalogPromise: Promise<LucideCatalog> | null = null;
let resolved: LucideCatalog | null = null;

/**
 * Start (or reuse) the catalog import. The promise is cached even on rejection:
 * a failed dynamic import is cached by the browser's module map, so re-importing
 * the same URL rejects identically — recovery is a full page reload (see the
 * picker's "Retry"), not a bare re-import.
 */
export function loadCatalog(): Promise<LucideCatalog> {
  if (!catalogPromise) {
    catalogPromise = import("./lucide-catalog.generated").then((m) => {
      resolved = m.default;
      return m.default;
    });
  }
  return catalogPromise;
}

/** The already-resolved catalog, or null if it has not finished loading. Lets a
 * re-opened picker skip the `loading` state entirely. */
export function syncCatalog(): LucideCatalog | null {
  return resolved;
}
