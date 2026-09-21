export interface SelectionContext {
  text: string;
  truncated?: boolean;
  blockIds?: string[];
  before?: string;
  after?: string;
}

// Server-side caps for the client-reported selection. Intentionally >= the
// client caps: the client pre-trims for a small wire, but this layer re-checks
// everything because the payload is attacker-controllable.
const TEXT_CAP = 4000;
const CONTEXT_CAP = 200;
const MAX_BLOCK_IDS = 20;
const BLOCK_ID_CAP = 64;

// Sanitize the client-reported selection: type-check every field, cap sizes
// (text 4000, before/after 200, blockIds 20 x 64 chars), drop garbage to null.
// The selection is a CLIENT-side snapshot — never verified against the page
// content (#159 lesson: treat as a hint, not ground truth). The agent is told
// (getCurrentPage's description) to localize it before editing.
export function sanitizeSelection(raw: unknown): SelectionContext | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  // text is the only required field; anything else is a non-selection.
  if (typeof r.text !== 'string' || r.text.trim().length === 0) return null;
  let text = r.text;
  let truncated = r.truncated === true;
  if (text.length > TEXT_CAP) {
    text = text.slice(0, TEXT_CAP);
    truncated = true;
  }

  const result: SelectionContext = { text };
  if (truncated) result.truncated = true;

  if (Array.isArray(r.blockIds)) {
    // Keep only well-formed, in-range ids (an oversize id is DROPPED, not
    // truncated — a mangled id is worse than a missing one), then cap the count.
    const ids = r.blockIds
      .filter(
        (x): x is string =>
          typeof x === 'string' && x.length > 0 && x.length <= BLOCK_ID_CAP,
      )
      .slice(0, MAX_BLOCK_IDS);
    if (ids.length > 0) result.blockIds = ids;
  }

  if (typeof r.before === 'string' && r.before.length > 0) {
    result.before = r.before.slice(0, CONTEXT_CAP);
  }
  if (typeof r.after === 'string' && r.after.length > 0) {
    result.after = r.after.slice(0, CONTEXT_CAP);
  }

  return result;
}

export interface CurrentPageInput {
  id?: string;
  title?: string;
  // The already-sanitized selection nested onto the resolved open-page context
  // by resolveOpenPageContext (never the raw client value). Passed through to
  // the tool result verbatim; null when nothing is selected.
  selection?: SelectionContext | null;
}

export interface CurrentPageResult {
  page: { id: string; title: string } | null;
  selection: SelectionContext | null; // null when nothing is selected or no page
}

// Resolve the "current page" tool result from the client-supplied open-page
// context. Returns { page: null, selection: null } when no page is open (no id),
// otherwise the page id + title (title defaults to '' when absent) plus the
// selection already sanitized+nested by resolveOpenPageContext. A null page
// always yields a null selection (the selection dies with the page). Mirrors the
// getCurrentPage tool's contract so it can be unit-tested without the ESM
// Docmost client.
export function resolveCurrentPageResult(
  openedPage?: CurrentPageInput | null,
): CurrentPageResult {
  if (!openedPage?.id) {
    return { page: null, selection: null };
  }
  return {
    page: { id: openedPage.id, title: openedPage.title ?? '' },
    selection: openedPage.selection ?? null,
  };
}
