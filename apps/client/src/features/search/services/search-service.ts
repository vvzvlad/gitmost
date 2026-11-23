import api from "@/lib/api-client";
import {
  IAttachmentSearch,
  IPageSearch,
  IPageSearchParams,
  IPageSearchResponse,
  ISuggestionResult,
  SearchSuggestionParams,
} from "@/features/search/types/search.types";

// #701: `items` are the real matches; `related` are vector-only semantic
// neighbours (first page only, not counted as matches).
export async function searchPage(params: IPageSearchParams): Promise<{
  items: IPageSearch[];
  related: IPageSearch[];
  attachments: IAttachmentSearch[];
}> {
  const req = await api.post<IPageSearchResponse>("/search", params);
  return {
    items: req.data.items,
    related: req.data.related ?? [],
    attachments: req.data.attachments ?? [],
  };
}

export async function searchSuggestions(
  params: SearchSuggestionParams,
): Promise<ISuggestionResult> {
  const req = await api.post<ISuggestionResult>("/search/suggest", params);
  return req.data;
}

// Like `searchPage`: `items` are the matches, `related` the semantic
// neighbours. `disabledReason` says why a share has no search at all.
export async function searchShare(params: IPageSearchParams): Promise<{
  items: IPageSearch[];
  related: IPageSearch[];
  disabledReason?: string;
}> {
  const req = await api.post<IPageSearchResponse>(
    "/search/share-search",
    params,
  );
  return {
    items: req.data.items,
    related: req.data.related ?? [],
    disabledReason: req.data.disabledReason,
  };
}

export async function searchAttachments(
  params: IPageSearchParams,
): Promise<IAttachmentSearch[]> {
  return (await searchPage({ ...params, includeAttachments: true }))
    .attachments;
}
