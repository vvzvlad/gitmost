/**
 * Passive "new comments: N" signal (#417) — the SHARED, transport-agnostic core.
 *
 * MOTIVATION: the "human comments while the agent works" loop was pull-only — the
 * agent had to REMEMBER to call the expensive `checkNewComments` (a full
 * space-tree walk), so in a long turn it never checked and the human's comments
 * were never noticed mid-turn. This module builds a short, ephemeral one-liner
 * ("new comments: N on page …") that each surface appends to the result of ANY
 * (non-comment) tool call, so the signal finds the agent instead of the other way
 * round — mirroring the per-turn `<page_changed>` block precedent for the page
 * BODY (ai-chat.prompt.ts), but for COMMENTS and MID-TURN.
 *
 * This file owns ONLY the surface-neutral pieces: the injection-safe line
 * builder + the watermark / per-page debounce / working-set state machine
 * (`createCommentSignalTracker`). Each surface (standalone MCP `registerTool`
 * wrapper, in-app `execute` wrapper) supplies its own `probe` (the count source)
 * and does the surface-specific result shaping. Pure apart from the injected
 * `probe` + `now`, so it is fully unit-testable with a fake probe + fake clock.
 *
 * INJECTION SAFETY: the signal is COUNT + pageId + (defanged) page TITLE only.
 * Comment TEXT is untrusted data from another user, so it is NEVER read into the
 * line (a system signal carrying attacker-controlled text is a prompt-injection
 * vector — the same reason `</page_changed>` is defanged in the in-app prompt).
 * The only untrusted string that can appear is the page title, which is passed
 * through `defangCommentSignalTitle` (strips the `<>"[]()` / backtick delimiter
 * characters and collapses whitespace) so a title cannot forge a second
 * `[signal]` line or close a safety-sandwich block.
 */

/** The count source's result for one page: how many comments are new, + the
 *  page's (untrusted) title to LABEL the signal. Title is optional. */
export interface CommentSignalProbeResult {
  count: number;
  title?: string | null;
}

/**
 * Count source: given a pageId and the watermark (ms epoch), return how many
 * comments were created after the watermark on that page (+ the page title). The
 * tracker rate-limits this to at most one call per page per debounce window.
 */
export type CommentSignalProbe = (
  pageId: string,
  sinceMs: number,
) => Promise<CommentSignalProbeResult>;

/**
 * The minimal client surface the shared count-source probe needs: the full
 * comment feed for a page, and the LIGHT raw page info (title only). Both the
 * standalone MCP client and the in-app loopback client satisfy this.
 */
export interface CommentSignalProbeClient {
  listComments(
    pageId: string,
    includeResolved: boolean,
  ): Promise<{ items: Array<{ createdAt?: string | null }> }>;
  getPageRaw(pageId: string): Promise<{ title?: string | null } | null | undefined>;
}

/**
 * The canonical count-source probe BOTH hosts use (#494). Counts comments on
 * `pageId` created strictly after `sinceMs`, reading the FULL feed (incl.
 * resolved) so a human's comment on any thread is seen; then — ONLY on a hit —
 * fetches the page's title via the LIGHT `getPageRaw` (not the heavy `getPage`,
 * which also renders Markdown + subpages) to LABEL the signal, so the no-signal
 * path never pays for it. Extracted so the standalone MCP host (index.ts) and the
 * in-app host (ai-chat-tools.service.ts) share ONE probe body instead of two
 * hand-mirrored copies that could silently drift (e.g. one counting resolved
 * comments and the other not, or one using the heavy page read). Best-effort
 * title: a `getPageRaw` fault leaves the title undefined and never throws.
 */
export function createListCommentsProbe(
  client: CommentSignalProbeClient,
): CommentSignalProbe {
  return async (pageId, sinceMs) => {
    const { items } = await client.listComments(pageId, true);
    const count = (items as Array<{ createdAt?: string | null }>).filter((c) => {
      const created = c && c.createdAt ? new Date(c.createdAt).getTime() : NaN;
      return Number.isFinite(created) && created > sinceMs;
    }).length;
    let title: string | undefined;
    if (count > 0) {
      try {
        const page = (await client.getPageRaw(pageId)) as {
          title?: string | null;
        } | null;
        title = page?.title ?? undefined;
      } catch {
        // Title is optional — omit it when the page can't be fetched.
      }
    }
    return { count, title };
  };
}

export interface CommentSignalTrackerOptions {
  probe: CommentSignalProbe;
  /** Clock injection for tests. Defaults to Date.now. */
  now?: () => number;
  /** Minimum ms between probes of the SAME page. Defaults to 20s. */
  debounceMs?: number;
}

/** Default debounce: never probe a given page more than once per 20 seconds. */
export const DEFAULT_COMMENT_SIGNAL_DEBOUNCE_MS = 20_000;

/**
 * Tools whose OWN result must NOT carry the signal — it would be tautological
 * (the agent is already looking at comments) and noisy. Since issue #412 both
 * the standalone MCP surface and the in-app agent use the same camelCase tool
 * names, so a single set of camelCase names covers both surfaces. `getComment`
 * (single fetch) is intentionally NOT excluded.
 */
export const COMMENT_SIGNAL_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
  "listComments",
  "checkNewComments",
  "createComment",
]);

/**
 * Defang an untrusted page title before it is interpolated into the signal line.
 * Mirrors the in-app `escapeAttr` + `neutralizePageChangedDelimiter` handling of
 * cross-user page titles: strip the characters a title could use to forge a
 * second `[signal]`/`</page_changed>` token or break out of the quoted label
 * (`<`, `>`, `"`, `[`, `]`, `(`, `)`, backtick), collapse any newline/CR/tab to a
 * single space, and cap the length so a huge title cannot bloat the result.
 */
export function defangCommentSignalTitle(
  title: string,
  maxLen = 80,
): string {
  if (typeof title !== "string") return "";
  let out = title
    .replace(/[<>"\[\]()`]/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (out.length > maxLen) out = out.slice(0, maxLen).trimEnd() + "…";
  return out;
}

/** Keep a pageId inert in the line: page ids are slug/uuid tokens, so anything
 *  outside `[A-Za-z0-9_-]` is dropped (defense-in-depth; ids never legitimately
 *  contain delimiter characters). */
function sanitizePageId(pageId: string): string {
  return typeof pageId === "string" ? pageId.replace(/[^A-Za-z0-9_-]/g, "") : "";
}

/**
 * Build the ephemeral signal line. COUNT + pageId + (defanged) title ONLY — no
 * comment text ever. The camelCase `listComments(pageId)` hint points the agent
 * at the precise follow-up read (roadmap #412 tool naming).
 */
export function buildCommentSignalLine(
  count: number,
  pageId: string,
  title?: string | null,
): string {
  const safeTitle = title ? defangCommentSignalTitle(title) : "";
  const titlePart = safeTitle ? ` ("${safeTitle}")` : "";
  return (
    `[signal] new comments: ${count} on page ${sanitizePageId(pageId)}` +
    `${titlePart} — call listComments(pageId) for details`
  );
}

export interface CommentSignalTracker {
  /** Record a page the session has accessed (the working set). No-op for a
   *  missing/blank id. */
  noteWorkingPage(pageId: string | undefined | null): void;
  /** Raise the session-wide watermark FLOOR to `nowMs` (default: the clock).
   *  Called when an explicit comment tool consumes the new comments, so they
   *  don't re-signal. Applies to every page (see the per-page model below). */
  advanceWatermark(nowMs?: number): void;
  /** True when `toolName` is a comment tool whose result must not carry the
   *  signal. */
  isExcludedTool(toolName: string): boolean;
  /**
   * Probe the working set (debounced per page) and, if new comments exist,
   * return the signal line for the first page with activity — advancing THAT
   * page's watermark so those comments are not re-signalled (emit-on-change),
   * while leaving every other page's watermark untouched. Returns
   * null when the tool is excluded, the working set is empty, every page is
   * within its debounce window, or nothing is new. Never throws: a probe fault
   * is swallowed (best-effort — the signal must never break a tool call).
   */
  maybeSignal(toolName: string): Promise<string | null>;
}

/**
 * Create a per-scope tracker (per MCP session for standalone; per turn for the
 * in-app agent). The watermark starts at construction time, so only comments
 * created AFTER the scope began are ever signalled — mid-turn human comments are
 * exactly the target loop; between-turn comments remain the job of the existing
 * `<page_changed>` snapshot + the explicit `checkNewComments`.
 */
export function createCommentSignalTracker(
  options: CommentSignalTrackerOptions,
): CommentSignalTracker {
  const now = options.now ?? Date.now;
  const debounceMs = options.debounceMs ?? DEFAULT_COMMENT_SIGNAL_DEBOUNCE_MS;
  const probe = options.probe;

  // PER-PAGE watermark model (ms). A comment counts as "new" only when created
  // after the watermark that applies to ITS page, computed as the later of two
  // layers:
  //  - `floorWatermarkMs`: a session/turn-wide FLOOR, raised only when an
  //    explicit comment tool CONSUMES the feed (advanceWatermark). It is the
  //    "the agent just read/created comments, don't re-signal them" barrier and
  //    applies to every page.
  //  - `pageWatermarkMs[pageId]`: a per-page override, raised ONLY for the page
  //    a signal was just emitted for (emit-on-change). Keeping this PER PAGE is
  //    the fix for the earlier single-global-watermark bug: advancing page A's
  //    watermark on emission must NOT suppress a still-unseen comment on page B
  //    whose createdAt may pre-date A's advanced watermark. Each page is measured
  //    against max(floor, its own override), defaulting to the construction
  //    baseline, so activity on a second working-set page is never lost.
  const initialWatermarkMs = now();
  let floorWatermarkMs = initialWatermarkMs;
  const pageWatermarkMs = new Map<string, number>();
  const workingSet = new Set<string>();
  // Per-page last-probe timestamp: enforces <=1 probe per page per debounce
  // window (the cost cap on the count source).
  const lastCheckedMs = new Map<string, number>();

  // Effective watermark for a page: the later of the session-wide floor and the
  // page's own emit-on-change override (default: the construction baseline).
  const watermarkFor = (pageId: string): number =>
    Math.max(floorWatermarkMs, pageWatermarkMs.get(pageId) ?? initialWatermarkMs);

  const noteWorkingPage = (pageId: string | undefined | null): void => {
    if (typeof pageId === "string" && pageId.trim()) workingSet.add(pageId);
  };

  // Raise the session-wide FLOOR. Called when an explicit comment tool
  // (list/check/create) consumes the feed so those comments do not re-signal.
  //
  // INTENTIONAL TRADEOFF: for createComment the floor jumps to now(), which also
  // suppresses any human comment created in the brief window just before the
  // agent's own create landed. That is deliberate — it is the price of
  // guaranteeing the agent's OWN comment never self-signals; a lost edge-case
  // human comment is still caught between turns by the <page_changed> snapshot +
  // the explicit checkNewComments.
  const advanceWatermark = (nowMs: number = now()): void => {
    if (nowMs > floorWatermarkMs) floorWatermarkMs = nowMs;
  };

  const isExcludedTool = (toolName: string): boolean =>
    COMMENT_SIGNAL_EXCLUDED_TOOLS.has(toolName);

  const maybeSignal = async (toolName: string): Promise<string | null> => {
    if (isExcludedTool(toolName)) return null;
    if (workingSet.size === 0) return null;
    const nowMs = now();
    // KNOWN LIMITATION: the per-page debounce guards against double-PROBING the
    // same page, not double-EMITTING across concurrent tool calls in one session
    // — two calls racing on DIFFERENT pages can each emit a signal. This is
    // accepted (no locking): a duplicate passive hint is cheap and self-corrects
    // once the watermark advances, whereas a lock would serialize every tool call
    // for a rare, harmless overlap.
    for (const pageId of workingSet) {
      const last = lastCheckedMs.get(pageId) ?? 0;
      // Debounce: at most one probe per page per window.
      if (nowMs - last < debounceMs) continue;
      lastCheckedMs.set(pageId, nowMs);
      let result: CommentSignalProbeResult;
      try {
        result = await probe(pageId, watermarkFor(pageId));
      } catch {
        // Best-effort: a probe failure never breaks the tool call.
        continue;
      }
      if (result && result.count > 0) {
        // Emit-on-change: advance ONLY this page's watermark so the same comments
        // don't re-emit — WITHOUT touching other working-set pages, so a comment
        // on a second page is still signalled on a later call.
        pageWatermarkMs.set(pageId, nowMs);
        return buildCommentSignalLine(result.count, pageId, result.title);
      }
    }
    return null;
  };

  return { noteWorkingPage, advanceWatermark, isExcludedTool, maybeSignal };
}
