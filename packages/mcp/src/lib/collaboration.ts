import { HocuspocusProvider } from "@hocuspocus/provider";
import { TiptapTransformer } from "@hocuspocus/transformer";
import * as Y from "yjs";
import WebSocket from "ws";
import { marked } from "marked";
import { generateJSON } from "@tiptap/html";
import { Node as PMNode } from "@tiptap/pm/model";
import { updateYFragment } from "y-prosemirror";
import { JSDOM } from "jsdom";
import { docmostExtensions, docmostSchema } from "./docmost-schema.js";
import { withPageLock } from "./page-lock.js";
import { sanitizeForYjs, findUnstorableAttr } from "./node-ops.js";
import { lexFootnoteLines } from "./footnote-lex.js";
import { canonicalizeFootnotes } from "./footnote-canonicalize.js";
import { summarizeChange, VerifyReport } from "./diff.js";

/**
 * Build the descriptive error for an opaque Yjs encode failure ("Unexpected
 * content type"), shared by both encode paths (`buildYDoc` -> `toYdoc` and
 * `applyDocToFragment` -> `updateYFragment`) so the message wording stays in one
 * place. `label` names the stage that failed (diagnostic). `sanitizeForYjs`
 * already stripped `undefined` attrs, so a remaining failure is pinpointed via
 * `findUnstorableAttr`.
 */
function unstorableYjsError(safe: any, label: string, e: unknown): Error {
  const bad = findUnstorableAttr(safe);
  return new Error(
    `Failed to encode document to Yjs (${label}): ${e instanceof Error ? e.message : String(e)}.${bad ? ` Offending attribute: ${bad}.` : " A node/mark attribute likely holds a value Yjs cannot store (e.g. undefined)."}`,
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
 * Hard ceiling above which we skip callout preprocessing entirely. The linear
 * scanner below has no quadratic blow-up, but we still cap input defensively so
 * a pathological multi-megabyte payload cannot tie up the event loop; in that
 * case the markdown is passed through verbatim (callouts are simply not
 * detected) rather than risking a slow scan.
 */
const MAX_CALLOUT_PREPROCESS_BYTES = 4 * 1024 * 1024; // 4 MB

/** Matches an opening callout fence: `:::type` (type captured, lower-cased). */
const CALLOUT_OPEN_RE = /^:::\s*(\w+)\s*$/;
/** Matches a bare closing callout fence: `:::`. */
const CALLOUT_CLOSE_RE = /^:::\s*$/;
/** Matches the start/end of a code fence (``` or ~~~), capturing the marker. */
const CODE_FENCE_RE = /^(\s*)(`{3,}|~{3,})/;

/**
 * Pre-process Docmost-flavoured markdown: convert `:::type ... :::`
 * callout blocks (the syntax our markdown export produces) into HTML
 * divs that the callout extension parses. The inner content is rendered
 * through marked as regular markdown.
 *
 * Implemented as a single linear pass over the lines (no quadratic regex
 * rescan). It:
 *   - tracks fenced code regions (```...``` and ~~~...~~~) and never treats a
 *     `:::` line that lives inside a code fence as a callout delimiter, so a
 *     callout body that itself contains a fenced code block with a `:::` line is
 *     no longer corrupted;
 *   - matches an opening `:::type` line with the next CLOSING `:::` at the SAME
 *     nesting level, supporting NESTED callouts via a depth counter (an inner
 *     `:::type` opens a deeper level and consumes a matching `:::`);
 *   - emits the same `<div data-type="callout" data-callout-type="TYPE">` output
 *     (inner rendered through marked) as the previous regex implementation.
 */
async function preprocessCallouts(markdown: string): Promise<string> {
  // Defensive cap: skip preprocessing for pathologically large inputs.
  if (markdown.length > MAX_CALLOUT_PREPROCESS_BYTES) {
    return markdown;
  }

  // Recursively transform a slice of lines, converting top-level callouts in
  // that slice into <div> blocks and rendering their inner content (which may
  // itself contain nested callouts) through this same function.
  const transform = async (lines: string[]): Promise<string> => {
    const out: string[] = [];
    let inCodeFence = false;
    let codeFenceMarker = ""; // the exact run of backticks/tildes that opened it
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Inside a code fence, only its matching closing fence is significant;
      // everything else (including `:::` lines) is copied through verbatim.
      if (inCodeFence) {
        out.push(line);
        const fence = line.match(CODE_FENCE_RE);
        if (fence && fence[2].startsWith(codeFenceMarker[0]) &&
            fence[2].length >= codeFenceMarker.length) {
          inCodeFence = false;
          codeFenceMarker = "";
        }
        i++;
        continue;
      }

      // A code fence opening outside any callout body: enter code-fence mode.
      const fenceOpen = line.match(CODE_FENCE_RE);
      if (fenceOpen) {
        inCodeFence = true;
        codeFenceMarker = fenceOpen[2];
        out.push(line);
        i++;
        continue;
      }

      // An opening callout fence: scan forward (with code-fence and nested
      // callout awareness) for its matching closing `:::` at the same level.
      const open = line.match(CALLOUT_OPEN_RE);
      if (open) {
        const type = open[1].toLowerCase();
        const bodyLines: string[] = [];
        let depth = 1;
        let innerInCodeFence = false;
        let innerCodeFenceMarker = "";
        let j = i + 1;
        for (; j < lines.length; j++) {
          const bl = lines[j];
          if (innerInCodeFence) {
            const f = bl.match(CODE_FENCE_RE);
            if (f && f[2].startsWith(innerCodeFenceMarker[0]) &&
                f[2].length >= innerCodeFenceMarker.length) {
              innerInCodeFence = false;
              innerCodeFenceMarker = "";
            }
            bodyLines.push(bl);
            continue;
          }
          const innerFence = bl.match(CODE_FENCE_RE);
          if (innerFence) {
            innerInCodeFence = true;
            innerCodeFenceMarker = innerFence[2];
            bodyLines.push(bl);
            continue;
          }
          if (CALLOUT_OPEN_RE.test(bl)) {
            depth++;
            bodyLines.push(bl);
            continue;
          }
          if (CALLOUT_CLOSE_RE.test(bl)) {
            depth--;
            if (depth === 0) break; // matching close for THIS callout
            bodyLines.push(bl);
            continue;
          }
          bodyLines.push(bl);
        }

        if (j < lines.length) {
          // Found the matching closing fence: render the body (recursively, so
          // nested callouts are handled) and emit the callout div.
          const inner = await transform(bodyLines);
          const renderedInner = await marked.parse(inner);
          out.push(
            `\n<div data-type="callout" data-callout-type="${type}">${renderedInner}</div>\n`,
          );
          i = j + 1; // skip past the closing `:::`
          continue;
        }
        // No matching close (unterminated callout): treat the opener as a
        // literal line and continue, preserving the original text.
        out.push(line);
        i++;
        continue;
      }

      out.push(line);
      i++;
    }

    return out.join("\n");
  };

  return transform(markdown.split("\n"));
}

/**
 * Bridge marked's checkbox lists to TipTap task lists.
 *
 * marked renders GitHub task list items (`- [x] done`) as a plain
 * `<ul><li><p><input type="checkbox" checked> text</p></li></ul>` WITHOUT the
 * markup TipTap's TaskList/TaskItem extensions parse. This rewrites such lists
 * into the shape those extensions expect:
 *   TaskList parseHTML matches `ul[data-type="taskList"]`,
 *   TaskItem matches `li[data-type="taskItem"]`,
 *   the checked state is read from `data-checked === "true"`.
 *
 * A list is only converted when it has at least one `<li>` and EVERY direct
 * `<li>` contains a checkbox input. Both `<ul>` and `<ol>` are considered: a
 * numbered checklist (`1. [x] a`, which marked renders as an `<ol>` of checkbox
 * `<li>`s) would otherwise lose its task state. TipTap task lists are unordered,
 * so a matching `<ol>` is emitted as `data-type="taskList"` exactly like a
 * `<ul>`. Mixed or ordinary lists (including ordinary `<ol>` lists) are left
 * untouched so they keep rendering as bullet/numbered lists. The marked `<p>`
 * wrapper is kept inside the `<li>` because TaskItem content allows paragraphs.
 */
function bridgeTaskLists(html: string): string {
  // Cheap early-out: if the markup contains no checkbox input at all there is
  // nothing to bridge, so skip the expensive JSDOM parse entirely. This is the
  // common case (most pages have no task lists).
  if (!/type=["']?checkbox/i.test(html)) {
    return html;
  }
  // Defensive cap (consistent with preprocessCallouts): skip the bridge for
  // pathologically large inputs rather than running a second expensive JSDOM
  // parse on a multi-megabyte payload. The markup is passed through verbatim.
  if (html.length > MAX_CALLOUT_PREPROCESS_BYTES) {
    return html;
  }
  const dom = new JSDOM(html);
  const document = dom.window.document;
  // Collect the checkbox(es) that belong to THIS <li> directly: either direct
  // child <input type="checkbox"> elements or ones inside the <li>'s direct <p>
  // child (the shape marked emits: `<li><p><input type="checkbox"> text</p></li>`).
  // Checkboxes nested deeper (e.g. inside a child <ul>/<ol>) are excluded so a
  // bullet <li> that merely contains a nested task sublist is not misdetected.
  // Raw inline HTML can put more than one checkbox in a single <li>; we gather
  // ALL of them so none survive into the converted item.
  const directCheckboxes = (li: Element): Element[] => {
    const found: Element[] = [];
    for (const child of Array.from(li.children)) {
      if (
        child.tagName === "INPUT" &&
        child.getAttribute("type") === "checkbox"
      ) {
        found.push(child);
        continue;
      }
      if (child.tagName === "P") {
        for (const inp of Array.from(
          child.querySelectorAll(":scope > input[type='checkbox']"),
        )) {
          found.push(inp);
        }
      }
    }
    return found;
  };
  // Both <ul> and <ol> are candidates: an <ol> whose every direct <li> carries
  // its own checkbox is a numbered checklist that must also become a taskList.
  const lists = Array.from(document.querySelectorAll("ul, ol"));
  for (const list of lists) {
    // Only consider DIRECT child <li> elements; nested lists are handled by
    // their own iteration of the outer loop.
    const items = Array.from(list.children).filter(
      (child) => child.tagName === "LI",
    );
    if (items.length === 0) continue;
    const itemCheckboxes = items.map((li) => directCheckboxes(li));
    // Convert only when every direct <li> carries at least one OWN checkbox.
    if (!itemCheckboxes.every((boxes) => boxes.length > 0)) continue;

    // A numbered checklist arrives as an <ol>. We must NOT leave the tag as
    // <ol> while tagging it data-type="taskList": generateJSON would then match
    // BOTH the orderedList rule (tag ol) and the taskList rule (data-type),
    // emitting a phantom empty orderedList beside the real taskList. So rename a
    // qualifying <ol> to a <ul> — move its <li> children over and replace it —
    // leaving only the taskList rule to match. Already-<ul> lists are unchanged.
    let target: Element = list;
    if (list.tagName === "OL") {
      const ul = document.createElement("ul");
      // Carry over existing attributes (e.g. class) so nothing is silently lost.
      for (const attr of Array.from(list.attributes)) {
        ul.setAttribute(attr.name, attr.value);
      }
      // Move every child node (including the <li>s we collected) into the <ul>.
      while (list.firstChild) {
        ul.appendChild(list.firstChild);
      }
      list.replaceWith(ul);
      target = ul;
    }

    target.setAttribute("data-type", "taskList");
    items.forEach((li, index) => {
      const boxes = itemCheckboxes[index];
      // The first checkbox determines the checked state (matches the previous
      // single-checkbox behaviour); any extras only need removing.
      const input = boxes[0] ?? null;
      li.setAttribute("data-type", "taskItem");
      const checked =
        input != null &&
        (input.hasAttribute("checked") || (input as any).checked);
      li.setAttribute("data-checked", checked ? "true" : "false");
      // Remove ALL direct checkbox inputs so none survive into the content
      // (a raw-inline-HTML <li> may carry more than one).
      for (const box of boxes) {
        box.remove();
      }
    });
  }
  return document.body.innerHTML;
}

// Mirror of packages/editor-ext footnote markdown handling. A `[^id]` inline
// marker becomes <sup data-footnote-ref data-id="id">, and `[^id]: text`
// definition lines are collected into a single <section data-footnotes>.
// Definition detection + fence handling are shared with analyzeFootnotes via
// lexFootnoteLines (footnote-lex.js). FOOTNOTE_REF_RE is the inline tokenizer's.
const FOOTNOTE_REF_RE = /\[\^([^\]\s]+)\]/;

function escapeFootnoteAttr(value: string): string {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

const footnoteRefMarkedExtension = {
  name: "footnoteRef",
  level: "inline" as const,
  start(src: string) {
    return src.match(/\[\^/)?.index ?? -1;
  },
  tokenizer(src: string) {
    const match = FOOTNOTE_REF_RE.exec(src);
    if (match && match.index === 0) {
      return { type: "footnoteRef", raw: match[0], id: match[1] };
    }
    return undefined;
  },
  renderer(token: any) {
    return `<sup data-footnote-ref data-id="${escapeFootnoteAttr(
      token.id,
    )}"></sup>`;
  },
};

marked.use({ extensions: [footnoteRefMarkedExtension] });

/**
 * Pull `[^id]: text` definition lines out of the body and render a single
 * <section data-footnotes> for them (or "" when there are none).
 */
function extractFootnotes(markdown: string): {
  body: string;
  section: string;
} {
  const bodyLines: string[] = [];
  const defs: Array<{ id: string; text: string }> = [];
  // Shared lexer (footnote-lex): a `[^id]: ...` line inside a ``` / ~~~ code
  // block is inert and stays in the body verbatim; only real definition lines
  // are pulled out. analyzeFootnotes() consumes the SAME lexer so its diagnostics
  // match exactly what import keeps/strips (#166).
  for (const tok of lexFootnoteLines(markdown)) {
    if (!tok.inFence && tok.definition) defs.push(tok.definition);
    else bodyLines.push(tok.line);
  }
  if (defs.length === 0) return { body: markdown, section: "" };

  // Duplicate definition ids: FIRST WINS, the rest are DROPPED (mirror of
  // editor-ext extractFootnoteDefinitions). Reference markers are left untouched
  // so repeated `[^a]` references reuse the single footnote (Pandoc semantics,
  // #166). The dropped duplicate is surfaced to the caller via analyzeFootnotes
  // (`duplicateDefinitions`), not silently lost. MUST stay in sync with the
  // editor-ext mirror.
  const firstById = new Map<string, string>(); // id -> first definition text
  for (const def of defs) {
    if (!firstById.has(def.id)) firstById.set(def.id, def.text);
  }

  const inner = [...firstById.entries()]
    .map(
      ([id, text]) =>
        `<div data-footnote-def data-id="${escapeFootnoteAttr(
          id,
        )}"><p>${marked.parseInline(text || "")}</p></div>`,
    )
    .join("");
  return {
    body: bodyLines.join("\n"),
    section: `<section data-footnotes>${inner}</section>`,
  };
}

/**
 * Convert markdown to a ProseMirror doc using the full Docmost schema.
 *
 * NOTE: besides the page-import write paths, this is also reused for comment
 * bodies (createComment / updateComment). For an ordinary comment the
 * canonicalize call below is a no-op (a comment carries no footnotes), so the
 * reuse is safe; the only theoretical effect is if footnote markup were ever
 * authored INSIDE a comment — a narrow case where canonicalizing the comment's
 * own (self-contained) footnotes is still the correct behaviour.
 */
export async function markdownToProseMirror(
  markdownContent: string,
): Promise<any> {
  const withCallouts = await preprocessCallouts(markdownContent);
  const { body, section } = extractFootnotes(withCallouts);
  const html = (await marked.parse(body)) + section;
  const bridged = bridgeTaskLists(html);
  const json = generateJSON(bridged, docmostExtensions);
  // Canonicalize footnotes on EVERY import: the section above is built in
  // definition order, but numbering is derived from REFERENCE order — so without
  // this the bottom list renders out of order (`1, 4, 2, 3, …`). Idempotent, so
  // it is a no-op when the footnotes are already canonical.
  return canonicalizeFootnotes(json);
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
  try {
    PMNode.fromJSON(docmostSchema, safe);
  } catch (e) {
    throw unstorableYjsError(safe, "fromJSON", e);
  }
}

/** Time we wait for the initial handshake/sync before giving up. */
const CONNECT_TIMEOUT_MS = 25000;
/** Time we wait for the server to acknowledge our write before giving up. */
const PERSIST_TIMEOUT_MS = 20000;

/**
 * Safely mutate the live content of a page over the collaboration websocket.
 *
 * This is the single safe write path for every MCP content mutation. It:
 *   1. serializes per-page writes through withPageLock (no two MCP writes on
 *      the same page overlap);
 *   2. connects to Hocuspocus and waits for the initial sync so the local ydoc
 *      mirrors the authoritative server doc — INCLUDING edits/comments/images
 *      that are not yet in the debounced REST snapshot;
 *   3. inside onSynced, SYNCHRONOUSLY reads the live doc, runs `transform`, and
 *      writes the result back — with no `await` between read and write so no
 *      remote update can interleave and clobber concurrent human edits;
 *   4. waits for the server to acknowledge the write (unsyncedChanges -> 0)
 *      before resolving, so the next operation observes our change.
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
  pageId: string,
  collabToken: string,
  baseUrl: string,
  transform: (liveDoc: any) => any | null,
): Promise<MutationResult> {
  return withPageLock(pageId, () => {
    if (process.env.DEBUG) {
      console.error(`Starting realtime content mutate for page ${pageId}`);
      // Token prefix is sensitive; only log it under DEBUG.
      console.error(
        `Token prefix: ${collabToken ? collabToken.substring(0, 5) : "NONE"}...`,
      );
    }

    const ydoc = new Y.Doc();
    const wsUrl = buildCollabWsUrl(baseUrl);
    if (process.env.DEBUG) console.error(`Connecting to WebSocket: ${wsUrl}`);

    return new Promise<MutationResult>((resolve, reject) => {
      let provider: HocuspocusProvider | undefined;
      let applied = false; // onSynced may fire again on reconnect — apply once.
      let settled = false;
      // Set true on disconnect/close so a reconnect-driven unsyncedChanges->0
      // cannot be mistaken for a successful persist of our write.
      let connectionLost = false;
      let connectTimer: ReturnType<typeof setTimeout> | undefined;
      let persistTimer: ReturnType<typeof setTimeout> | undefined;
      let unsyncedHandler: ((data: { number: number }) => void) | undefined;

      const cleanup = () => {
        if (connectTimer) clearTimeout(connectTimer);
        if (persistTimer) clearTimeout(persistTimer);
        if (provider) {
          if (unsyncedHandler) {
            try {
              provider.off("unsyncedChanges", unsyncedHandler);
            } catch (err) {}
          }
          try {
            provider.destroy();
          } catch (err) {}
        }
      };

      const finish = (err: Error | null, value?: MutationResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) reject(err);
        else resolve(value as MutationResult);
      };

      connectTimer = setTimeout(() => {
        finish(new Error("Connection timeout to collaboration server"));
      }, CONNECT_TIMEOUT_MS);

      // Resolve once the server has acknowledged our update. The provider
      // increments unsyncedChanges when our local update is sent and
      // decrements it when the server replies with a SyncStatus(applied=true);
      // reaching 0 means the authoritative in-memory ydoc on the server now
      // contains our write.
      const waitForPersistence = () => {
        if (settled) return;
        // A missing provider is a failure, not a success: without it the write
        // can never have been acknowledged. Only an actual unsyncedChanges===0
        // on a live provider counts as persisted.
        if (!provider) {
          finish(new Error("collab provider gone before persistence"));
          return;
        }
        if (provider.unsyncedChanges === 0) {
          finish(null, mutationResult);
          return;
        }
        persistTimer = setTimeout(() => {
          finish(
            new Error(
              "Timeout waiting for collaboration server to persist the update",
            ),
          );
        }, PERSIST_TIMEOUT_MS);
        unsyncedHandler = (data: { number: number }) => {
          // Only treat unsyncedChanges->0 as success when the connection is
          // still up. A transient disconnect + reconnect handshake can drive
          // the counter back to 0 without our write being re-transmitted; in
          // that case let the disconnect/close error win instead.
          if (data.number === 0 && !connectionLost) {
            finish(null, mutationResult);
          }
        };
        provider.on("unsyncedChanges", unsyncedHandler);
      };

      // The verifiable result resolved on every success/abort path. Set on
      // abort (no-op report) and after a real write (computed change report).
      let mutationResult: MutationResult;

      provider = new HocuspocusProvider({
        url: wsUrl,
        name: `page.${pageId}`,
        document: ydoc,
        token: collabToken,
        // @ts-ignore - Required for Node.js environment
        WebSocketPolyfill: WebSocket,
        onConnect: () => {
          if (process.env.DEBUG) console.error("WS Connect");
        },
        // An unexpected disconnect/close while we are still waiting (during the
        // connect-wait before onSynced, or during the persistence wait after the
        // write) means the update will never be acknowledged — surface it now
        // instead of hanging until the connect/persist timeout fires. `finish`
        // is idempotent via the `settled` flag, so the onClose that our own
        // cleanup()->provider.destroy() triggers (after settled=true is set) is
        // a harmless no-op and cannot cause a double-resolve.
        onDisconnect: () => {
          if (process.env.DEBUG) console.error("WS Disconnect");
          // Mark BEFORE finish so the unsyncedChanges handler (if it races)
          // sees the connection as lost and won't report a false success.
          connectionLost = true;
          finish(
            new Error(
              "Collaboration connection closed before the update was persisted/synced",
            ),
          );
        },
        onClose: () => {
          if (process.env.DEBUG) console.error("WS Close");
          // Mark BEFORE finish so the unsyncedChanges handler (if it races)
          // sees the connection as lost and won't report a false success.
          connectionLost = true;
          finish(
            new Error(
              "Collaboration connection closed before the update was persisted/synced",
            ),
          );
        },
        onSynced: () => {
          if (applied || settled) return;
          applied = true;
          if (process.env.DEBUG) console.error("Connected and synced!");

          // CRITICAL: everything between reading the live doc and writing it
          // back must stay synchronous (no await). While the JS event loop is
          // not yielded, no incoming remote update can interleave, so any
          // already-synced concurrent edits are preserved in liveDoc.
          let newDoc: any;
          let beforeDoc: any;
          try {
            let liveDoc = TiptapTransformer.fromYdoc(ydoc, "default");
            if (
              !liveDoc ||
              typeof liveDoc !== "object" ||
              !Array.isArray(liveDoc.content)
            ) {
              liveDoc = { type: "doc", content: [] };
            }

            // Snapshot the before-doc for the change report. Docs are
            // JSON-serializable, so this is a safe deep clone.
            beforeDoc = JSON.parse(JSON.stringify(liveDoc));

            newDoc = transform(liveDoc);

            if (newDoc == null) {
              // Transform aborted — write nothing, return the live doc with a
              // no-op change report.
              mutationResult = {
                doc: liveDoc,
                verify: {
                  changed: false,
                  textInserted: 0,
                  textDeleted: 0,
                  blocksChanged: 0,
                  marks: {},
                  summary: "no changes (transform aborted)",
                },
              };
              finish(null, mutationResult);
              return;
            }

            // Structural diff into the live fragment (issue #152): preserves
            // the Yjs ids of unchanged nodes, so an open editor's cursor is not
            // yanked to the end of the document on every agent write.
            applyDocToFragment(ydoc, newDoc);
          } catch (e) {
            // Includes errors thrown by transform (e.g. "afterText not found",
            // "text not found"): propagate them verbatim to the caller.
            finish(e instanceof Error ? e : new Error(String(e)));
            return;
          }

          // Compute the verifiable change report AFTER the transact write: it
          // only needs the JSON before/after, so it cannot affect the atomic
          // read->write window, and summarizeChange never throws.
          mutationResult = {
            doc: newDoc,
            verify: summarizeChange(beforeDoc, newDoc),
          };
          if (process.env.DEBUG)
            console.error("Content written, waiting for server to persist...");
          waitForPersistence();
        },
        onAuthenticationFailed: () => {
          finish(
            new Error("Authentication failed for collaboration connection"),
          );
        },
      });
    });
  });
}

/**
 * Replace the live content of a page over the collaboration websocket.
 * Accepts a ready ProseMirror JSON document; the caller controls whether
 * it was produced from markdown (ids regenerate) or edited in place
 * (existing block ids preserved).
 *
 * This is an intentional full replace (used by update_page / update_page_json),
 * but now runs under the per-page lock and waits for server persistence via
 * mutatePageContent.
 */
export async function replacePageContent(
  pageId: string,
  prosemirrorDoc: any,
  collabToken: string,
  baseUrl: string,
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
  );
}

/**
 * Markdown update path (kept for backwards compatibility).
 * NOTE: this re-imports the whole document — block ids are regenerated.
 * Tables and :::callout::: blocks survive thanks to the full schema.
 */
export async function updatePageContentRealtime(
  pageId: string,
  markdownContent: string,
  collabToken: string,
  baseUrl: string,
): Promise<MutationResult> {
  const tiptapJson = await markdownToProseMirror(markdownContent);
  return await mutatePageContent(
    pageId,
    collabToken,
    baseUrl,
    () => tiptapJson,
  );
}
