import { TiptapTransformer } from "@hocuspocus/transformer";
import * as Y from "yjs";
import WebSocket from "ws";
import { Node as PMNode } from "@tiptap/pm/model";
import { updateYFragment } from "y-prosemirror";
import { JSDOM } from "jsdom";
// #293 STEP 5: the pure markdown -> ProseMirror import path is now owned by the
// shared package (canonical `^[…]` footnotes, `$…$` math, `==` highlight, the
// media-family md forms, comment-directive attrs, callouts and task lists all
// handled there). MCP consumes it directly instead of maintaining its own
// drifted marked pipeline; only the collab/yjs write glue and the footnote
// canonicalization wrapper stay mcp-side.
import {
  markdownToProseMirror,
  normalizeAgentMarkdown,
} from "@docmost/prosemirror-markdown";
import type { MarkdownImportOptions } from "@docmost/prosemirror-markdown";
import { docmostExtensions, docmostSchema } from "./docmost-schema.js";
import { withPageLock } from "./page-lock.js";
import type { PageId } from "./page-id.js";
import {
  sanitizeForYjs,
  findUnstorableAttr,
  findInvalidNode,
} from "@docmost/prosemirror-markdown";
import { canonicalizeFootnotes } from "./footnote-canonicalize.js";
import { normalizeAndMergeFootnotes } from "./footnote-normalize-merge.js";
import { regraftResolvedComments } from "./comment-anchor.js";
import { VerifyReport } from "./diff.js";
import { acquireCollabSession } from "./collab-session.js";

export { markdownToProseMirror };

/**
 * Build the descriptive error for an opaque Yjs encode failure ("Unexpected
 * content type"), shared by both encode paths (`buildYDoc` -> `toYdoc` and
 * `applyDocToFragment` -> `updateYFragment`) so the message wording stays in one
 * place. `label` names the stage that failed (diagnostic). `sanitizeForYjs`
 * already stripped `undefined` attrs, so a remaining failure is pinpointed via
 * `findUnstorableAttr`.
 *
 * Diagnostics precedence (#409): the dominant crash here is
 * `Unknown node type: undefined` — a nested node with an absent/unknown `type`
 * (a SHAPE problem, e.g. `{"text":"foo"}` missing `"type":"text"`). That points
 * at the node, not an attribute, so `findInvalidNode` is consulted FIRST and,
 * on a hit, yields a path-anchored node-shape message. Only when the document
 * shape is sound do we fall back to `findUnstorableAttr` (undefined/function/
 * symbol/bigint attr values); the generic "attribute likely holds a value Yjs
 * cannot store" sentence is the last resort.
 */
function unstorableYjsError(safe: any, label: string, e: unknown): Error {
  const base = `Failed to encode document to Yjs (${label}): ${e instanceof Error ? e.message : String(e)}.`;
  const badNode = findInvalidNode(safe);
  if (badNode) {
    return new Error(`${base} Invalid node: ${badNode.summary}`);
  }
  const bad = findUnstorableAttr(safe);
  return new Error(
    `${base}${bad ? ` Offending attribute: ${bad}.` : " A node/mark attribute likely holds a value Yjs cannot store (e.g. undefined)."}`,
  );
}

/**
 * The resolved value of every content-mutating collab write: the document that
 * was written (or the live doc when the transform aborted) plus a verifiable
 * change report describing what actually changed in the document.
 */
export interface MutationResult {
  doc: any;
  verify: VerifyReport;
}

// Setup DOM environment for Tiptap HTML parsing in Node.js
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
global.window = dom.window as any;
global.document = dom.window.document;
// @ts-ignore
global.Element = dom.window.Element;
// @ts-ignore
global.WebSocket = WebSocket;
// Navigator is read-only in newer Node versions and already exists
// global.navigator = dom.window.navigator;

/**
 * Page-write variant of the package's `markdownToProseMirror`: imports markdown
 * then re-runs mcp's footnote canonicalizer over the result.
 *
 * Footnote layering after #293 STEP 5:
 *   - The package's `markdownToProseMirror` already ASSEMBLES footnotes on import
 *     (canon #2): inline `^[body]` markers become the schema's
 *     `footnoteReference` + a single doc-level `footnotesList`, with ids assigned
 *     sequentially (`fn-1`, `fn-2`, …) in first-reference order and identical
 *     bodies merged. So the import output is ALREADY in canonical footnote
 *     topology.
 *   - `canonicalizeFootnotes` runs AFTER as the mcp write-path invariant shared
 *     with every other full-document persist path (`updatePageJson`,
 *     `docmostTransform`, `insertFootnote`, …). Because the package output is
 *     already canonical, this layer is a no-op here (idempotent) — it exists so
 *     the page-write contract is enforced uniformly regardless of how the PM doc
 *     was produced, not because the import needs fixing.
 *
 * Use this ONLY for full-document PAGE writes. Comment bodies call the package's
 * plain `markdownToProseMirror` (no canonicalization) — safe now because inline
 * `^[body]` footnotes carry their body at the reference point, so a comment can
 * no longer produce a reference-less footnote definition to be dropped.
 *
 * #493: `normalizeAgentMarkdown` runs FIRST, so an agent's `updatePageMarkdown`
 * body gets the SAME GFM `[^id]` reference-footnote -> inline `^[body]` rewrite as
 * the server import path (instead of the reference leaking as literal text / a
 * bogus link). It DELIBERATELY does NOT strip a leading YAML front-matter block:
 * a full-body agent rewrite that opens with a `---…---` is (almost) always a
 * horizontalRule the serializer emitted, and stripping it would silently drop the
 * page's leading content (#493 review). The front-matter strip stays on the
 * server FILE-import boundary only (`normalizeForeignMarkdown`).
 *
 * #502 IMPORTANT — the two layered markdown extensions (`$…$` math, schemeless
 * fuzzy autolink) are NOT decided here; they are the CALLER's choice via
 * `options`, because the two callers of this wrapper need OPPOSITE behavior:
 *   - AGENT-authored plain markdown (`updatePageMarkdown`) → both OFF, so a
 *     `$…$` config span stays literal and a bare `www.host` is not autolinked
 *     (real math is authored via `update_page_json`).
 *   - FULL-FILE round-trip import (`import_page_markdown`, #328 lossless) →
 *     DEFAULTS (both ON), because the exporter serializes a math node as readable
 *     `$x^2$`; re-importing with math OFF would degrade it to literal text and
 *     BREAK the lossless export→import pair.
 * So `options` DEFAULTS to `undefined` → the package importer's defaults (ON),
 * which is the safe round-trip behavior; the agent-write caller opts OUT
 * explicitly. (The fragment path `importMarkdownFragment` opts out on its own.)
 */
export async function markdownToProseMirrorCanonical(
  markdownContent: string,
  options?: MarkdownImportOptions,
): Promise<any> {
  // #419: normalize + merge glyph-forked footnote definitions BEFORE
  // canonicalizing, so the canonicalizer re-hangs references and drops the
  // now-orphaned duplicate definitions.
  return canonicalizeFootnotes(
    normalizeAndMergeFootnotes(
      await markdownToProseMirror(normalizeAgentMarkdown(markdownContent), options),
    ),
  );
}

/**
 * Build the collaboration WebSocket URL from an API base URL:
 * switch http(s)->ws(s), strip a trailing /api, mount on /collab.
 * Shared by the live read and the mutate path so both target the same socket.
 */
export function buildCollabWsUrl(baseUrl: string): string {
  let wsUrl = baseUrl.replace(/^http/, "ws");
  try {
    const urlObj = new URL(wsUrl);
    if (urlObj.pathname.endsWith("/api") || urlObj.pathname.endsWith("/api/")) {
      urlObj.pathname = urlObj.pathname.replace(/\/api\/?$/, "");
    }
    urlObj.pathname = urlObj.pathname.replace(/\/$/, "") + "/collab";
    // Drop any query/hash from the base URL so it is not carried into the
    // collaboration ws URL.
    urlObj.search = "";
    urlObj.hash = "";
    wsUrl = urlObj.toString();
  } catch (e) {
    // Fallback if URL parsing fails
    if (!wsUrl.endsWith("/collab")) {
      wsUrl = wsUrl.replace(/\/$/, "") + "/collab";
    }
  }
  return wsUrl;
}

/**
 * Reject a doc that places marks where the schema forbids them (e.g. any mark
 * inside codeBlock, whose spec is `marks: ""`). PMNode.fromJSON does NOT
 * validate marks against parent specs, and updateYFragment would happily write
 * the poison into the live Y.Doc — where the NEXT schema-full materialization
 * (browser ySyncPlugin) throws and y-prosemirror permanently DELETES the whole
 * offending node (the July code-block data-loss incident). Failing loudly here
 * turns silent delayed data loss into an immediate, actionable tool error.
 *
 * The whole-document scope is INTENTIONAL — a forbidden mark that pre-dates
 * this write (legacy poison) is rejected too: failing loudly beats silent
 * delayed data loss, and pre-existing poison is ephemeral anyway (a browser
 * open destroys the node within seconds), so there is no long-lived legacy
 * state worth grandfathering.
 */
function assertMarksAllowedByParent(pmNode: PMNode): void {
  pmNode.descendants((child, _pos, parent) => {
    // `descendants` never visits the root itself and always passes the
    // enclosing node as `parent` (the root for its direct children); the
    // fallback is purely defensive against the nullable type signature.
    const p = parent ?? pmNode;
    if (child.marks.length > 0 && !p.type.allowsMarks(child.marks)) {
      const markNames = child.marks.map((m) => m.type.name).join(", ");
      const preview = (child.isText ? child.text ?? "" : child.type.name).slice(
        0,
        40,
      );
      throw new Error(
        `Document rejected: a "${p.type.name}" node carries the forbidden ` +
          `mark(s) [${markNames}] on its child ("${preview}"). The editor ` +
          `schema forbids these marks here, and the next schema-full ` +
          `materialization would permanently delete the whole ${p.type.name}. ` +
          `The mark may come from this write or may already exist in the live ` +
          `document — remove it (or move the marked text out of the ` +
          `${p.type.name}) and retry.`,
      );
    }
    return true;
  });
}

/**
 * Encode a ProseMirror doc to a Yjs document, sanitizing it first and turning
 * the opaque yjs "Unexpected content type" failure into a descriptive error.
 *
 * `sanitizeForYjs` strips `undefined` node/mark attributes (the common cause of
 * the failure); if `toYdoc` still throws, `findUnstorableAttr` is used to point
 * at the offending attribute path.
 */
export function buildYDoc(doc: any): Y.Doc {
  const safe = sanitizeForYjs(doc);
  try {
    return TiptapTransformer.toYdoc(safe, "default", docmostExtensions);
  } catch (e) {
    throw unstorableYjsError(safe, "toYdoc", e);
  }
}

/**
 * Write a new ProseMirror doc into the live Yjs fragment by STRUCTURAL DIFF,
 * preserving the Yjs identity of unchanged nodes (issue #152).
 *
 * The previous approach deleted the whole fragment and re-applied a fresh Y.Doc,
 * which discarded every Yjs node id. y-prosemirror anchors the editor selection
 * to those ids, so an open editor's cursor lost its anchor and snapped to the
 * end of the document on every agent write (most visibly on comment anchoring,
 * which changes no text at all). `updateYFragment` is exactly the routine the
 * editor itself uses to sync ProseMirror edits into Yjs: it diffs the new node
 * against the current fragment and touches only the changed children, so
 * unchanged nodes keep their ids and the live cursor stays put.
 *
 * Must run inside a single `transact` so the diff applies atomically (no remote
 * update interleaves). Keeps `buildYDoc`'s `findUnstorableAttr` diagnostic for
 * the opaque "Unexpected content type" encode failure.
 */
export function applyDocToFragment(ydoc: Y.Doc, newDoc: any): void {
  const safe = sanitizeForYjs(newDoc);
  const fragment = ydoc.getXmlFragment("default");
  // Hydrate the ProseMirror node in its OWN try so a failure here (e.g. an
  // unknown node type) is labelled "fromJSON" — the stage that actually threw —
  // instead of being misattributed to the Yjs write stage (#154 review).
  let pmNode: PMNode;
  try {
    pmNode = PMNode.fromJSON(docmostSchema, safe);
  } catch (e) {
    throw unstorableYjsError(safe, "fromJSON", e);
  }
  // fromJSON does not check marks against parent node specs, so validate them
  // BEFORE anything touches the live fragment (see assertMarksAllowedByParent).
  assertMarksAllowedByParent(pmNode);
  try {
    ydoc.transact(() => {
      updateYFragment(ydoc, fragment, pmNode, {
        mapping: new Map(),
        isOMark: new Map(),
      });
    });
  } catch (e) {
    throw unstorableYjsError(safe, "updateYFragment", e);
  }
}

/**
 * Run an independent Yjs-encodability check (the same `sanitizeForYjs` + schema
 * the apply path uses) and throw the same descriptive error when the doc cannot
 * be stored. Used by the dry-run preview.
 *
 * Note: it does NOT run `updateYFragment` against the live fragment, so it is an
 * encodability GATE, not a byte-for-byte rehearsal of apply — `buildYDoc`
 * (`toYdoc`) and `applyDocToFragment` (`updateYFragment`) are two different
 * encoders that nonetheless reject the same unstorable attributes. To narrow the
 * preview/apply gap it ALSO rehearses the apply path's `PMNode.fromJSON`
 * hydration, so a doc that would only fail there (e.g. an unknown node type) is
 * rejected at preview time too (#154 review). Still cheap: no live fragment, no
 * `updateYFragment`.
 */
export function assertYjsEncodable(doc: any): void {
  buildYDoc(doc);
  const safe = sanitizeForYjs(doc);
  let pmNode: PMNode;
  try {
    pmNode = PMNode.fromJSON(docmostSchema, safe);
  } catch (e) {
    throw unstorableYjsError(safe, "fromJSON", e);
  }
  // Preview/apply parity: reject schema-forbidden marks (e.g. a comment mark
  // inside a codeBlock) here too, exactly like applyDocToFragment does.
  assertMarksAllowedByParent(pmNode);
}

/**
 * Safely mutate the live content of a page over the collaboration websocket.
 *
 * This is the single safe write path for every MCP content mutation. It:
 *   1. serializes per-page writes through withPageLock (no two MCP writes on
 *      the same page overlap);
 *   2. acquires a LIVE, synced CollabSession for the page (issue #400) — a
 *      cached provider whose local ydoc mirrors the authoritative server doc
 *      (INCLUDING edits/comments/images not yet in the debounced REST snapshot),
 *      reused across a series of edits instead of a fresh connect/auth/sync per
 *      call;
 *   3. SYNCHRONOUSLY reads the live doc, runs `transform`, and writes the result
 *      back — with no `await` between read and write so no remote update can
 *      interleave and clobber concurrent human edits (CollabSession.mutate);
 *   4. waits for the server to acknowledge the write (unsyncedChanges -> 0)
 *      before resolving, so the next operation observes our change.
 *
 * On any mutate failure the session is destroyed so the next call reconnects
 * fresh; the page lock is held for the whole acquire+mutate so the session's
 * synchronous read->write window never overlaps another MCP write on the page.
 *
 * `transform` receives the live ProseMirror doc and returns the NEW full
 * ProseMirror doc to write, or `null` to abort with no write (a no-op). If
 * `transform` throws, the error is propagated to the caller (not swallowed).
 *
 * Resolves a `MutationResult { doc, verify }`: `doc` is the doc that was
 * written (or the live doc when the transform aborted), and `verify` is a
 * verifiable change report (text/block/mark deltas) of what actually changed.
 * The report is computed AFTER the atomic read->write, so it never widens the
 * read->write window, and it never throws (it can NEVER break a write).
 */
export async function mutatePageContent(
  // Canonical UUID only (#260/#435): the brand forces every caller to
  // resolvePageId() BEFORE this seam so the lock + CollabSession key can never
  // be a raw slugId.
  pageId: PageId,
  collabToken: string,
  baseUrl: string,
  transform: (liveDoc: any) => any | null,
  // #487: optional abort signal carrying the turn's Stop + the in-app tool
  // per-call cap. Checked as the PRE-COMMIT safe-point below (after the session
  // is acquired, immediately before the atomic read->write), so a Stop that
  // arrives during the connect/lock window stops THIS write from landing. See the
  // limitation note at the check.
  signal?: AbortSignal,
): Promise<MutationResult> {
  return withPageLock(pageId, async () => {
    if (process.env.DEBUG) {
      console.error(`Starting realtime content mutate for page ${pageId}`);
      // Token prefix is sensitive; only log it under DEBUG.
      console.error(
        `Token prefix: ${collabToken ? collabToken.substring(0, 5) : "NONE"}...`,
      );
    }

    const session = await acquireCollabSession(pageId, collabToken, baseUrl);
    try {
      // #487 PRE-COMMIT safe-point: if the turn was Stopped (or the in-app tool
      // per-call cap fired) after we acquired the collab session but before the
      // atomic write, throw NOW so this commit never runs. KNOWN LIMITATION
      // (#487): this only stops THIS commit — a write tool that already committed
      // an EARLIER call this turn leaves that op applied. Cancel guarantees "no
      // NEW commit starts", NOT "the write didn't land".
      signal?.throwIfAborted();
      return await session.mutate(transform);
    } catch (e) {
      // Drop the session on any failure so the next call reconnects fresh (this
      // also closes the "reconnect drove the counter to 0" false-success class).
      session.destroy("mutate failed");
      throw e;
    }
  });
}

/**
 * Stateless-channel message types for the #370 explicit save-version handshake.
 * These MUST match the server constants in
 * apps/server/src/collaboration/extensions/persistence.extension.ts
 * (SAVE_VERSION_MESSAGE_TYPE and the VERSION_SAVED / VERSION_SKIPPED replies) —
 * the mcp package cannot import server code, so the literals are duplicated here.
 * KEEP THE TWO SIDES IN SYNC: the server broadcasts exactly ONE terminal reply per
 * handled save (`version.saved` for a real save/promote, `version.skipped` for a
 * reachable no-op — an empty page or a missing page row); the client must match
 * BOTH or it waits out the ack timeout on the skip case and misreports a healthy
 * server as unreachable (#370 F2).
 */
const SAVE_VERSION_MESSAGE_TYPE = "save-version";
const VERSION_SAVED_MESSAGE_TYPE = "version.saved";
const VERSION_SKIPPED_MESSAGE_TYPE = "version.skipped";

/**
 * Bounded wait for the server's terminal reply after we ask it to save a version.
 * The server flushes the live ydoc through its store path and writes a history row
 * inside a DB transaction before broadcasting, so allow the same headroom as a
 * persistence ack; reject (do NOT hang) past it. A timeout here means NO reply at
 * all arrived — the genuine "collab server unreachable/overloaded" case — as
 * distinct from a `version.skipped` reply, which resolves immediately.
 */
const SAVE_VERSION_ACK_TIMEOUT_MS = 20000;

/**
 * The resolved outcome of an explicit save-version, surfaced to the tool caller.
 * `saved:true` → a version was created or promoted (historyId/kind/alreadySaved
 * are present). `saved:false` → the server had nothing to pin (a reachable no-op,
 * e.g. an empty page); `skipped` + `reason` explain why. A page-not-found reply is
 * NOT represented here — it is surfaced as a thrown error (a bad/stale pageId).
 */
export interface SaveVersionResult {
  saved: boolean;
  historyId?: string;
  kind?: string;
  alreadySaved?: boolean;
  skipped?: boolean;
  reason?: string;
}

/**
 * Parsed terminal reply the predicate hands back to savePageVersionRealtime. Kept
 * internal: it carries the page-not-found case (mapped to a thrown error, never a
 * returned result) that SaveVersionResult deliberately does not model.
 */
type SaveVersionReply =
  | { outcome: "saved"; historyId: string; kind: string; alreadySaved: boolean }
  | { outcome: "skipped"; reason: string };

/** Match the server's terminal reply (version.saved / version.skipped), ignoring
 *  any unrelated / cross-page stateless message so the wait is not resolved by
 *  noise. Returns `undefined` to keep waiting (#370 F1 predicate coverage). */
function matchSaveVersionReply(message: any): SaveVersionReply | undefined {
  if (!message || typeof message !== "object") return undefined;
  if (message.type === VERSION_SAVED_MESSAGE_TYPE) {
    return {
      outcome: "saved",
      historyId: String(message.historyId),
      kind: String(message.kind),
      alreadySaved: !!message.alreadySaved,
    };
  }
  if (message.type === VERSION_SKIPPED_MESSAGE_TYPE) {
    return { outcome: "skipped", reason: String(message.reason ?? "unknown") };
  }
  return undefined;
}

/**
 * Save an intentional version of a page's CURRENT live collaboration content
 * (#370). Runs under the per-page lock, acquires the SAME cached CollabSession the
 * content writes use (#400) — so it authenticates with the caller's agent collab
 * token, and the server derives kind='agent' from that signed actor — then sends a
 * `{type:'save-version'}` stateless message and awaits the server's terminal reply
 * (`version.saved` or `version.skipped`) on the same channel.
 *
 * Deliberately does NOT read `pages.content` over REST: the versioned content is
 * the live in-memory ydoc, which the debounced (up-to-10s-stale) page row would
 * not yet reflect. The stateless round-trip is what makes the save exact.
 *
 * Outcomes:
 *   - a real save/promote → `{ saved:true, historyId, kind, alreadySaved }`;
 *   - the server had nothing to pin (empty page) → `{ saved:false, skipped:true,
 *     reason:'empty' }` — a clean, immediate no-op, NOT a stall;
 *   - the page row is gone (a stale/bad pageId) → a thrown error, immediate and
 *     truthful (not the health-timeout path);
 *   - no reply within the timeout → a thrown timeout error (the genuine "server
 *     unreachable/overloaded" case).
 *
 * On a TRANSPORT failure (timeout / disconnect) the session is destroyed so the
 * next call reconnects fresh; a page-not-found is a healthy-connection terminal
 * reply, so the session is left cached. A save is safe to retry — the server
 * promotes-not-duplicates an identical latest version — so the caller (and its
 * agent) may re-issue it without risking a duplicate heavy history row.
 */
export async function savePageVersionRealtime(
  pageId: PageId,
  collabToken: string,
  baseUrl: string,
): Promise<SaveVersionResult> {
  return withPageLock(pageId, async () => {
    const session = await acquireCollabSession(pageId, collabToken, baseUrl);
    let reply: SaveVersionReply;
    try {
      reply = await session.sendStatelessAndAwait<SaveVersionReply>(
        JSON.stringify({ type: SAVE_VERSION_MESSAGE_TYPE }),
        matchSaveVersionReply,
        SAVE_VERSION_ACK_TIMEOUT_MS,
      );
    } catch (e) {
      // TRANSPORT failure (no reply within the timeout, or a disconnect): drop the
      // session so the next call reconnects fresh.
      session.destroy("save-version failed");
      throw e;
    }
    // A terminal reply arrived over a healthy connection — do NOT destroy the
    // session; interpret the outcome.
    if (reply.outcome === "skipped") {
      if (reply.reason === "page-not-found") {
        // A resolved pageId that the collab server no longer holds (deleted, or a
        // stale id). Surface it immediately and truthfully, not as a health error.
        throw new Error(
          `savePageVersion: page ${pageId} was not found on the collaboration ` +
            `server (it may have been deleted) — nothing was saved.`,
        );
      }
      // Reachable benign no-op (e.g. an empty page): a clean result, not a throw.
      return { saved: false, skipped: true, reason: reply.reason };
    }
    return {
      saved: true,
      historyId: reply.historyId,
      kind: reply.kind,
      alreadySaved: reply.alreadySaved,
    };
  });
}

/**
 * Replace the live content of a page over the collaboration websocket.
 * Accepts a ready ProseMirror JSON document; the caller controls whether
 * it was produced from markdown (ids regenerate) or edited in place
 * (existing block ids preserved).
 *
 * This is an intentional full replace (used by update_page / updatePageJson),
 * but now runs under the per-page lock and waits for server persistence via
 * mutatePageContent.
 */
export async function replacePageContent(
  pageId: PageId,
  prosemirrorDoc: any,
  collabToken: string,
  baseUrl: string,
  // #487: threaded straight to mutatePageContent's pre-commit safe-point.
  signal?: AbortSignal,
): Promise<MutationResult> {
  // Fail fast on a bad document instead of deferring the failure into the
  // collaboration write (where TiptapTransformer.toYdoc(undefined) used to
  // throw). The transform must return a valid ProseMirror doc.
  if (
    prosemirrorDoc == null ||
    typeof prosemirrorDoc !== "object" ||
    prosemirrorDoc.type !== "doc"
  ) {
    throw new Error("replacePageContent: invalid ProseMirror document");
  }
  return await mutatePageContent(
    pageId,
    collabToken,
    baseUrl,
    () => prosemirrorDoc,
    signal,
  );
}

/**
 * Markdown update path (kept for backwards compatibility).
 * NOTE: this re-imports the whole document — block ids are regenerated.
 * Tables and :::callout::: blocks survive thanks to the full schema.
 */
export async function updatePageContentRealtime(
  pageId: PageId,
  markdownContent: string,
  collabToken: string,
  baseUrl: string,
): Promise<MutationResult> {
  // PAGE write: canonicalize footnotes (markdown import builds the bottom list in
  // definition order; numbering is reference-ordered).
  //
  // #502: this is the AGENT-authored `updatePageMarkdown` body — plain prose /
  // config — so the two layered markdown extensions are turned OFF: a `$…$` span
  // stays literal text (real math via `update_page_json`) and a SCHEMELESS
  // `www.host`/email is not autolinked (an explicit `https://…` still links).
  // Contrast `import_page_markdown`, which keeps DEFAULTS for the #328 lossless
  // round-trip.
  const tiptapJson = await markdownToProseMirrorCanonical(markdownContent, {
    parseMath: false,
    fuzzyLinkify: false,
  });
  return await mutatePageContent(
    pageId,
    collabToken,
    baseUrl,
    // #493: an agent read HIDES resolved-comment anchors (#337), so the markdown
    // it sends here no longer carries them — a naive full rewrite would erase
    // every resolved comment mark. Re-graft the resolved marks from the LIVE doc
    // onto the matching text in the freshly-imported body. Active comments are
    // untouched (they ride through the markdown themselves); a resolved span whose
    // text the agent changed simply does not re-anchor and is dropped.
    //
    // #555: surface a dropped resolved anchor through the diagnostics channel
    // instead of losing it silently — either the text is gone (agent rewrote it)
    // or too many identical-text anchors collided on too few occurrences (a span
    // holds only one comment mark). Genuine, if rare, data loss in the resolved
    // (hidden) zone, so it is logged, not swallowed.
    (liveDoc) =>
      regraftResolvedComments(liveDoc, tiptapJson, (w) =>
        console.error(
          `[regraft] page ${pageId}: dropped resolved comment ${w.commentId} ` +
            `(${w.code}) — anchor text ${JSON.stringify(
              w.text.length > 80 ? `${w.text.slice(0, 80)}…` : w.text,
            )} could not be re-grafted onto the rewritten body.`,
        ),
      ),
  );
}
