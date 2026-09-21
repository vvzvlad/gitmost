/**
 * Presentation helpers for AI SDK tool UI parts. The agent writes WITHOUT
 * confirmation (D2), so a tool part is a LOG of what already happened — never a
 * prompt for approval.
 *
 * A tool part's `type` is `tool-${toolName}` (AI SDK v6 static tool parts) and
 * its `state` is one of input-streaming / input-available / output-available /
 * output-error (we only surface running / done / error). The full toolset the
 * server exposes lives in `ai-chat-tools.service.ts` (the agent now exposes the
 * complete Docmost toolset); friendly action-log labels exist ONLY for the
 * tools listed in `toolLabelKey` below — every other tool falls through to the
 * generic "Ran tool {{name}}" label.
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
  /**
   * Internal route. The server tools return the page UUID (no slugId), so we
   * link to `/p/{uuid}` directly — `extractPageSlugId` treats a bare UUID as
   * valid and returns it whole, which `PageRedirect` then resolves. The title
   * is the visible label only and must NOT be folded into the slug (that would
   * mangle the UUID via the trailing-segment split and 404 the link).
   */
  href: string;
}

/** True for AI SDK tool parts (static `tool-*` or `dynamic-tool`). */
export function isToolPart(type: string): boolean {
  return type.startsWith("tool-") || type === "dynamic-tool";
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

/** Collapse runs of whitespace/newlines to a single space and trim. */
function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Truncate to ~140 chars, appending an ellipsis when it overflows. */
function clamp(s: string): string {
  const MAX = 140;
  return s.length > MAX ? s.slice(0, MAX).trimEnd() + "…" : s;
}

/**
 * Priority "primary" argument fields, in order. The first present one supplies
 * the summary. `urls` is included (external MCP `read_pages`-style tools take a
 * list of URLs) and is handled as an array; `url` covers the single-URL form.
 */
const PRIMARY_INPUT_FIELDS = [
  "query",
  "q",
  "searchQuery",
  "url",
  "urls",
  "title",
  "name",
  "text",
  "prompt",
] as const;

/**
 * A short, PLAIN-TEXT one-line summary of a tool call's arguments (e.g. the
 * search query), or undefined when no recognizable primary field is present.
 * Rendered under the tool label so tools without a friendly name (external MCP
 * tools like `Search_web_search`) still show WHAT was requested, not just a
 * generic "Ran tool {{name}}". The returned string is plain text and MUST be
 * rendered React-escaped (Mantine `<Text>`), never as markdown/HTML.
 *
 * Streaming gate: while `state === "input-streaming"` the `input` object grows
 * chunk by chunk but `messageSignature` deliberately does NOT track `input`, so
 * a live summary computed here would freeze at its first captured value and go
 * stale. We therefore return undefined until the state flips to
 * `input-available` (input finalized) — that state change IS tracked by the
 * signature, so the row re-renders and shows the complete summary. Do NOT add
 * `input` to `message-signature.ts` to work around this.
 */
export function toolInputSummary(part: ToolUiPart): string | undefined {
  if (part.state === "input-streaming") return undefined;
  if (!part.input || typeof part.input !== "object") return undefined;
  const input = part.input as Record<string, unknown>;

  for (const field of PRIMARY_INPUT_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.length > 0) {
      return clamp(collapse(value));
    }
    if (Array.isArray(value) && value.length > 0) {
      const first = collapse(String(value[0]));
      if (first.length === 0) continue;
      return clamp(first + (value.length > 1 ? ` (+${value.length - 1})` : ""));
    }
  }
  return undefined;
}

/**
 * Resolve the page citation(s) a tool part references, from its input/output.
 * Only output-available parts (the tool returned) yield citations. Search
 * returns an array of pages; the page-ops return a single page id. We link to
 * `/p/{id}` with the raw page UUID — `PageRedirect` resolves it via
 * `extractPageSlugId` (which returns a bare UUID unchanged), so the space slug
 * and a title slug are not needed here.
 */
export function toolCitations(part: ToolUiPart): ToolCitation[] {
  if (part.state !== "output-available") return [];
  const out = part.output;
  const input = (part.input ?? {}) as Record<string, unknown>;
  const citations: ToolCitation[] = [];

  const push = (id: string | undefined, title?: string): void => {
    if (!id) return;
    citations.push({ pageId: id, title, href: `/p/${id}` });
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
