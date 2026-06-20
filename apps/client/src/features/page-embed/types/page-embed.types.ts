export type PageTemplateLookup =
  | {
      sourcePageId: string;
      slugId: string;
      title: string | null;
      icon: string | null;
      content: unknown;
      sourceUpdatedAt: string;
    }
  | { sourcePageId: string; status: "not_found" }
  | { sourcePageId: string; status: "no_access" };

export type ToggleTemplateResponse = {
  pageId: string;
  isTemplate: boolean;
};
