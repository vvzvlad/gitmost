import api from "@/lib/api-client";
import type {
  PageTemplateLookup,
  ToggleTemplateResponse,
  ToggleTemporaryResponse,
} from "../types/page-embed.types";

export async function lookupTemplate(params: {
  sourcePageIds: string[];
}): Promise<{ items: PageTemplateLookup[] }> {
  const r = await api.post("/pages/template/lookup", params);
  return r.data;
}

export async function toggleTemplate(params: {
  pageId: string;
  isTemplate?: boolean;
}): Promise<ToggleTemplateResponse> {
  const r = await api.post("/pages/toggle-template", params);
  return r.data;
}

export async function toggleTemporary(params: {
  pageId: string;
  temporary?: boolean;
}): Promise<ToggleTemporaryResponse> {
  const r = await api.post("/pages/toggle-temporary", params);
  return r.data;
}
