// Auto-split from client.ts (issue #450). Mixin over the shared client context.
// Bodies are VERBATIM from the original DocmostClient; only the enclosing class
// changed to a mixin factory. See client/context.ts for the shared base.
import type { GConstructor, DocmostClientContext } from "./context.js";
import {
  updatePageContentRealtime,
  replacePageContent,
  markdownToProseMirror,
  markdownToProseMirrorCanonical,
  mutatePageContent,
  assertYjsEncodable,
  MutationResult,
} from "../lib/collaboration.js";
import { diffDocs, summarizeChange } from "../lib/diff.js";
import {
  blockText,
  walk,
  getList,
  insertMarkerAfter,
  setCalloutRange,
  noteItem,
  mdToInlineNodes,
  commentsToFootnotes,
  canonicalizeFootnotes,
  insertInlineFootnote,
  mergeFootnoteDefinitions,
} from "../lib/transforms.js";
import { normalizeAndMergeFootnotes } from "../lib/footnote-normalize-merge.js";
import vm from "node:vm";

// Public method surface of TransformsMixin (issue #450) — a NAMED type so the factory
// return type is expressible in the emitted .d.ts (the anonymous mixin class
// carries the base's protected shared state, which would otherwise trip TS4094).
// Derived from the class below; `implements ITransformsMixin` fails to compile on drift.
export interface ITransformsMixin {
  transformPage(pageId: string, transformJs: string, opts?: { dryRun?: boolean; deleteComments?: boolean }): any;
}

export function TransformsMixin<TBase extends GConstructor<DocmostClientContext>>(Base: TBase): GConstructor<DocmostClientContext & ITransformsMixin> & TBase {
  abstract class TransformsMixin extends Base implements ITransformsMixin {
  /**
   * Edit a page by running an arbitrary user-supplied JS transform against the
   * live document, with a diff preview + page-history safety net.
   *
   * The transform string is evaluated as `(doc, ctx) => doc` inside a node:vm
   * sandbox: it gets ONLY `{ doc, ctx, structuredClone, console }` as globals,
   * a 5s timeout, and NO access to require/process/fs/network. It must return a
   * `{ type: "doc" }` node, which is validated structurally before any write.
   *
   * `ctx` exposes:
   *   - comments: the page's comments (fetched before the live read);
   *   - log: an array the transform can push diagnostics to (via console.log);
   *   - consume(id): mark a comment id as consumed (for deleteComments);
   *   - helpers: the transforms.ts primitives + commentsToFootnotes.
   *
   * Footnote convention used by the helpers: footnote markers are plain "[N]"
   * text in the body, and the notes are an orderedList under a heading whose
   * text is "Примечания переводчика".
   *
   * dryRun (default true): read the page's current content, run the transform,
   * and return `{ pushed:false, diff, log }` WITHOUT opening the collab socket.
   * Otherwise the transform runs atomically inside mutatePageContent, optionally
   * deletes consumed comments, and returns the new historyId + diff + log.
   */
  async transformPage(
    pageId: string,
    transformJs: string,
    opts: { dryRun?: boolean; deleteComments?: boolean } = {},
  ) {
    const dryRun = opts.dryRun ?? true;
    const deleteComments = opts.deleteComments ?? false;

    await this.ensureAuthenticated();
    // Full feed (incl. resolved): a page transform (e.g. comments -> footnotes)
    // must operate on every comment, so it opts into the unfiltered feed.
    const comments = (await this.listComments(pageId, true)).items;

    // ctx handed to the sandbox. consume() records ids; helpers are the pure
    // transform primitives. log is captured from console.log inside the sandbox.
    const ctx = {
      comments,
      log: [] as string[],
      consumed: new Set<string>(),
      consume(id: string) {
        this.consumed.add(id);
      },
      helpers: {
        blockText,
        walk,
        getList,
        insertMarkerAfter,
        setCalloutRange,
        noteItem,
        mdToInlineNodes,
        commentsToFootnotes,
        canonicalizeFootnotes,
        insertInlineFootnote,
      },
    };

    // Captured oldDoc / newDoc for the diff (set inside runTransform).
    let oldDoc: any;
    let newDoc: any;

    // SYNCHRONOUS transform runner — safe to call inside mutatePageContent's
    // onSynced (no await between the live read and the write).
    const runTransform = (liveDoc: any): any => {
      oldDoc = structuredClone(liveDoc);
      const sandbox: Record<string, any> = {
        doc: structuredClone(liveDoc),
        ctx,
        structuredClone,
        console: {
          log: (...a: any[]) => ctx.log.push(a.map((x) => String(x)).join(" ")),
        },
      };
      // Wrap the provided string in parentheses so both an expression-arrow
      // (`(doc, ctx) => {...}`) and a parenthesized function work. Run it in a
      // fresh context with no require/process/module so the transform cannot
      // touch fs/network/process. 5s wall-clock timeout.
      let fn: any;
      try {
        fn = vm.runInNewContext("(" + transformJs + ")", sandbox, {
          timeout: 5000,
        });
      } catch (e: any) {
        throw new Error(`transform did not compile: ${e?.message ?? e}`);
      }
      if (typeof fn !== "function") {
        throw new Error(
          "transform must evaluate to a function (doc, ctx) => doc",
        );
      }
      const raw = vm.runInNewContext(
        "f(d, c)",
        { f: fn, d: sandbox.doc, c: ctx },
        { timeout: 5000 },
      );
      if (
        !raw ||
        typeof raw !== "object" ||
        raw.type !== "doc" ||
        !Array.isArray(raw.content)
      ) {
        throw new Error(
          'transform must return a ProseMirror doc node ({ type:"doc", content:[...] })',
        );
      }
      // Validate the RAW transform output FIRST (structure — including the
      // MAX_DEPTH guard — and URLs), mirroring updatePageJson. The canonicalizer
      // recurses without a depth limiter, so validating after it would turn a
      // too-deep doc into an opaque "Maximum call stack size exceeded" instead of
      // the intended "nesting exceeds the maximum depth" error.
      this.validateDocStructure(raw);
      this.validateDocUrls(raw);
      // Auto-canonicalize footnotes after the transform (idempotent): no write
      // path can leave footnotes out of order / orphaned / in a raw `[^id]`
      // block. In a dryRun preview this may surface footnote edits the script
      // author did not write (the canonicalizer tidied them) — that is expected.
      // #419: normalize + merge glyph-forked definitions before canonicalizing.
      const result = canonicalizeFootnotes(normalizeAndMergeFootnotes(raw));
      newDoc = result;
      return result;
    };

    if (dryRun) {
      // Preview only: run against the current REST snapshot, never open the
      // socket. oldDoc/newDoc are captured by runTransform.
      const raw = await this.getPageRaw(pageId);
      const current = raw.content || { type: "doc", content: [] };
      runTransform(current);
      // Run an independent Yjs-encodability check (same sanitize + schema as the
      // apply path), so the preview fails with the same descriptive error when
      // the doc is not encodable instead of returning a misleadingly-green diff.
      assertYjsEncodable(newDoc);
      return {
        pushed: false,
        diff: diffDocs(oldDoc, newDoc),
        log: ctx.log,
      };
    }

    // Apply atomically against the live doc.
    const collabToken = await this.getCollabTokenWithReauth();
    // Open the collab doc by the canonical UUID, never the slugId (#260).
    const pageUuid = await this.resolvePageId(pageId);
    const mutation = await mutatePageContent(
      pageUuid,
      collabToken,
      this.apiUrl,
      runTransform,
    );
    // #654 — arm read-your-own-writes (no-op when nothing changed).
    this.rememberWrite(pageUuid, mutation.verify);

    // Optionally delete consumed comments (best-effort; a delete failure must
    // not undo the successful write).
    const deletedComments: string[] = [];
    if (deleteComments) {
      for (const id of ctx.consumed) {
        try {
          await this.deleteComment(id);
          deletedComments.push(id);
        } catch (e) {
          if (process.env.DEBUG) {
            console.error(`transform: failed to delete comment ${id}:`, e);
          }
        }
      }
    }

    // Fetch the newest historyId (Docmost snapshots on the write above).
    let historyId: string | null = null;
    try {
      const hist = await this.listPageHistory(pageId);
      historyId = hist.items?.[0]?.id ?? null;
    } catch (e) {
      if (process.env.DEBUG) {
        console.error("transform: failed to fetch history id:", e);
      }
    }

    return {
      pushed: true,
      historyId,
      diff: diffDocs(oldDoc, newDoc),
      deletedComments,
      log: ctx.log,
      verify: mutation.verify,
    };
  }
  }
  return TransformsMixin;
}
