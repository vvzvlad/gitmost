import type { IPage } from "@/features/page/types/page.types";
import type { SearchSuggestionParams } from "@/features/search/types/search.types";

/**
 * Self-embed guard at insertion time: drop the host page (and any null/blank
 * entries) from the picker results so the current page can't embed itself.
 */
export function excludeHost(
  pages: IPage[],
  hostPageId: string | undefined,
): IPage[] {
  return pages.filter((p) => p && p.id !== hostPageId);
}

/**
 * Build the search-suggestions query for the template picker. Always restricts
 * to template-flagged pages (`onlyTemplates`) and includes pages, mirroring the
 * inline query args in PageEmbedPicker.
 */
export function buildPickerQuery(query: string): SearchSuggestionParams {
  return {
    query,
    includePages: true,
    onlyTemplates: true,
    limit: 20,
  };
}
