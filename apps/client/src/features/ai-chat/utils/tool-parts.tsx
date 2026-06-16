import { buildPageUrl } from "@/features/page/page.utils.ts";

/**
 * Presentation helpers for AI SDK tool UI parts. The agent writes WITHOUT
 * confirmation (D2), so a tool part is a LOG of what already happened — never a
 * prompt for approval.
 *
 * A tool part's `type` is `tool-${toolName}` (AI SDK v6 static tool parts) and
 * its `state` is one of input-streaming / input-available / output-available /
 * output-error (we only surface running / done / error). The server tools are:
 * searchPages, getPage, createPage, updatePageContent, renamePage, movePage,
 * deletePage, createComment, resolveComment — see ai-chat-tools.service.ts.
 */

/** A tool UI part as it arrives from `useChat` / persisted history. */
export interface ToolUiPart {
  type: string; // `tool-${name}` (or `dynamic-tool`)
  toolName?: string; // present on dynamic-tool parts
  toolCallId?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

/** Normalized run state surfaced in the action-log card. */
export type ToolRunState = "running" | "done" | "error";

/** A page reference resolved from a tool's input/output, with a citation link. */
export interface ToolCitation {
  pageId: string;
  title?: string;
  /** Internal route; `/p/{slug}-{id}` resolves via PageRedirect by slugId. */
  href: string;
}

/** Extract the tool name from a part `type` of `tool-${name}` (or dynamic). */
export function getToolName(part: ToolUiPart): string {
  if (part.type === "dynamic-tool") return part.toolName ?? "";
  return part.type.startsWith("tool-") ? part.type.slice("tool-".length) : part.type;
}

/** Map an AI SDK tool-part state to the 3 states the action-log renders. */
export function toolRunState(state: string | undefined): ToolRunState {
  if (state === "output-error" || state === "output-denied") return "error";
  if (state === "output-available") return "done";
  // input-streaming / input-available / approval-* -> still running.
  return "running";
}

/**
 * i18n KEY for a tool's action-log label. Past-tense for completed actions
 * (the card is a log). The caller passes the key through `t()`. Unknown tools
 * fall back to a generic key with the raw name interpolated.
 */
export function toolLabelKey(toolName: string): {
  key: string;
  values?: Record<string, string>;
} {
  switch (toolName) {
    case "searchPages":
      return { key: "Searched pages" };
    case "getPage":
      return { key: "Read page" };
    case "createPage":
      return { key: "Created page" };
    case "updatePageContent":
      return { key: "Updated page" };
    case "renamePage":
      return { key: "Renamed page" };
    case "movePage":
      return { key: "Moved page" };
    case "deletePage":
      return { key: "Deleted page (to trash)" };
    case "createComment":
      return { key: "Commented" };
    case "resolveComment":
      return { key: "Resolved comment" };
    default:
      return { key: "Ran tool {{name}}", values: { name: toolName } };
  }
}

/** Coerce an unknown record field to a non-empty string, else undefined. */
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Resolve the page citation(s) a tool part references, from its input/output.
 * Only output-available parts (the tool returned) yield citations. Search
 * returns an array of pages; the page-ops return a single page id. We build the
 * link from the page id alone — the `/p/{slug}-{id}` route resolves the page by
 * its slugId (PageRedirect), so the space slug is not needed here.
 */
export function toolCitations(part: ToolUiPart): ToolCitation[] {
  if (part.state !== "output-available") return [];
  const out = part.output;
  const input = (part.input ?? {}) as Record<string, unknown>;
  const citations: ToolCitation[] = [];

  const push = (id: string | undefined, title?: string): void => {
    if (!id) return;
    citations.push({ pageId: id, title, href: buildPageUrl(undefined, id, title) });
  };

  const toolName = getToolName(part);

  if (toolName === "searchPages" && Array.isArray(out)) {
    for (const raw of out) {
      const item = (raw ?? {}) as Record<string, unknown>;
      push(asString(item.id), asString(item.title));
    }
    return citations;
  }

  const o = (out ?? {}) as Record<string, unknown>;
  // getPage/createPage echo { id?, title }; the page-mutating tools echo pageId.
  const pageId =
    asString(o.id) ?? asString(o.pageId) ?? asString(input.pageId);
  const title = asString(o.title) ?? asString(input.title);
  push(pageId, title);
  return citations;
}
