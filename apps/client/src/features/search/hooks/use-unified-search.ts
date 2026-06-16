import { useQuery, UseQueryResult } from "@tanstack/react-query";
import { searchPage } from "@/features/search/services/search-service";
import {
  IAttachmentSearch,
  IPageSearch,
  IPageSearchParams,
} from "@/features/search/types/search.types";

export type UnifiedSearchResult = IPageSearch | IAttachmentSearch;

export interface UseUnifiedSearchParams extends IPageSearchParams {
  contentType?: string;
}

export function useUnifiedSearch(
  params: UseUnifiedSearchParams,
  enabled: boolean = true,
): UseQueryResult<UnifiedSearchResult[], Error> {
  return useQuery({
    queryKey: ["unified-search", "page", params],
    queryFn: async () => {
      // Remove contentType from backend params since it's only used for frontend routing
      const { contentType, ...backendParams } = params;
      return await searchPage(backendParams);
    },
    enabled: !!params.query && enabled,
  });
}
