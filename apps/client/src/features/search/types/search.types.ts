import { IUser } from "@/features/user/types/user.types.ts";
import { IGroup } from "@/features/group/types/group.types.ts";
import { ISpace } from "@/features/space/types/space.types.ts";
import { IPage } from "@/features/page/types/page.types.ts";

export interface IPageSearch {
  id: string;
  // #529 A7 superset: `pageId` aliases `id`; `rank`/`highlight` are null for
  // substring-only hits (the UI already falls back to the title/snippet).
  pageId?: string;
  title: string;
  icon: string;
  parentPageId: string;
  slugId: string;
  creatorId: string;
  createdAt: Date;
  updatedAt: Date;
  rank: string | number | null;
  highlight: string | null;
  space: Partial<ISpace>;
  // New #529 fields (present from the native Postgres search driver).
  snippet?: string;
  score?: number;
  path?: string[];
  matchedFields?: string[];
  matchedTerms?: string[];
}

// #529 A5 pagination envelope returned by POST /search (native driver). The web
// list helpers read `items`; these travel alongside for pagination + diagnostics.
export interface IPageSearchResponse {
  items: IPageSearch[];
  total: number;
  hasMore: boolean;
  truncatedAtCap: boolean;
  offset: number;
  query?: {
    raw: string;
    parsed: {
      positive: string[];
      required: string[];
      excluded: string[];
      reason?: string;
    };
    mode: "or" | "and";
    match: string;
  };
}

export interface SearchSuggestionParams {
  query: string;
  includeUsers?: boolean;
  includeGroups?: boolean;
  includePages?: boolean;
  onlyTemplates?: boolean;
  spaceId?: string;
  limit?: number;
}

export interface ISuggestionResult {
  users?: Partial<IUser[]>;
  groups?: Partial<IGroup[]>;
  pages?: Partial<IPage[]>;
}

export interface IPageSearchParams {
  query: string;
  spaceId?: string;
  shareId?: string;
  // #529 A9: match mode (auto default) + pagination.
  match?: "auto" | "word" | "prefix" | "substring";
  limit?: number;
  offset?: number;
}

export interface IAttachmentSearch {
  id: string;
  fileName: string;
  pageId: string;
  creatorId: string;
  createdAt: Date;
  updatedAt: Date;
  rank: string;
  highlight: string;
  space: {
    id: string;
    name: string;
    slug: string;
    icon: string;
  };
  page: {
    id: string;
    title: string;
    slugId: string;
  };
}
