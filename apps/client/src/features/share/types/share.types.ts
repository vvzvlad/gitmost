import { IPage } from "@/features/page/types/page.types.ts";

export interface IShare {
  id: string;
  key: string;
  pageId: string;
  includeSubPages: boolean;
  searchIndexing: boolean;
  creatorId: string;
  spaceId: string;
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  sharedPage?: ISharePage;
}

export interface ISharedItem extends IShare {
  page: {
    id: string;
    title: string;
    slugId: string;
    icon: string | null;
  };
  space: {
    id: string;
    name: string;
    slug: string;
    userRole: string;
  };
  creator: {
    id: string;
    name: string;
    avatarUrl: string | null;
  };
}

// The `/shares/page-info` (anonymous) response. Mirrors the server-side
// PublicSharePayload allowlist (#218): the server trims `page`/`share` to these
// fields exactly, so the client type must not over-declare internal metadata it
// will never receive. Keep this in sync with share-public-payload.ts.
export interface ISharedPage {
  page: Pick<IPage, "id" | "slugId" | "title" | "icon" | "content">;
  share: {
    id: string;
    key: string;
    includeSubPages: boolean;
    searchIndexing: boolean;
    level: number;
    sharedPage: { id: string; slugId: string; title: string; icon: string };
  };
  features?: string[];
  // Whether the anonymous public-share AI assistant is enabled for the
  // workspace (server-resolved). Gates the "Ask AI" widget.
  aiAssistant?: boolean;
  // Display name of the configured assistant identity (agent role name), used
  // to label the public-share chat. Null/absent when no identity is set →
  // the widget falls back to the generic "AI agent" label.
  aiAssistantName?: string | null;
}

export interface IShareForPage extends IShare {
  level: number;
  sharedPage: ISharePage;
}

interface ISharePage {
  id: string;
  slugId: string;
  title: string;
  icon: string;
}

export interface ICreateShare {
  pageId?: string;
  includeSubPages?: boolean;
  searchIndexing?: boolean;
}

export type IUpdateShare = ICreateShare & { shareId: string; pageId?: string };

export interface IShareInfoInput {
  pageId: string;
  // The share id/key from the `/share/:shareId/p/:slug` URL. When present the
  // server binds content access to this exact share (#218): a forged/mismatched
  // shareId 404s instead of rendering the page off its slug alone.
  shareId?: string;
}

// Vanity /l/:alias pointer.
export interface IShareAlias {
  id: string;
  workspaceId: string;
  alias: string;
  pageId: string | null;
  creatorId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ISetShareAlias {
  pageId: string;
  alias: string;
  confirmReassign?: boolean;
}

export interface IShareAliasAvailability {
  alias: string;
  valid: boolean;
  available: boolean;
  currentPageId: string | null;
}

export interface ISharedPageTree {
  share: IShare;
  pageTree: Partial<IPage[]>;
  features?: string[];
}
