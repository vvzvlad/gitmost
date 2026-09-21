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
import {
  replaceNodeById,
  replaceNodeByIdWithMany,
  reassignCollidingBlockIds,
  deleteNodeById,
  assertUnambiguousMatch,
  insertNodeRelative,
  insertNodesRelative,
  blockPlainText,
  buildOutline,
  getNodeByRef,
  readTable,
  insertTableRow,
  deleteTableRow,
  updateTableCell,
  findInvalidNode,
} from "@docmost/prosemirror-markdown";
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

// Public method surface of DocValidateMixin (issue #450) — a NAMED type so the factory
// return type is expressible in the emitted .d.ts (the anonymous mixin class
// carries the base's protected shared state, which would otherwise trip TS4094).
// Derived from the class below; `implements IDocValidateMixin` fails to compile on drift.
export interface IDocValidateMixin {
}

export function DocValidateMixin<TBase extends GConstructor<DocmostClientContext>>(Base: TBase): GConstructor<DocmostClientContext & IDocValidateMixin> & TBase {
  abstract class DocValidateMixin extends Base implements IDocValidateMixin {
  /**
   * Validate a URL string against a scheme allowlist for a given context.
   *
   * The markdown link path enforces safe schemes via TipTap, but the raw
   * JSON path (updatePageJson) bypasses that — so this is the sanitization
   * choke point for ProseMirror JSON written directly by the caller.
   *
   * - "link":  reject javascript:, vbscript:, data: (any scheme that can
   *            execute or smuggle script when the href is clicked).
   * - "src":   allow only http(s):, mailto:, /api/files paths, or a
   *            scheme-less relative/absolute path; reject
   *            javascript:/vbscript:/data:/file:.
   */
  protected isSafeUrl(url: unknown, context: "link" | "src"): boolean {
    if (typeof url !== "string") return false;
    const trimmed = url.trim();
    if (trimmed === "") return true; // empty href/src is harmless

    // Extract a leading "scheme:" if present. A scheme must start with a
    // letter and contain only letters/digits/+/-/. before the colon. Strip
    // whitespace and ASCII control chars first so a tab/newline embedded in
    // the scheme cannot smuggle a dangerous scheme past the check.
    const cleaned = trimmed.replace(/[\s\x00-\x1f]+/g, "");
    const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned);
    const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : null;

    const dangerous = new Set(["javascript", "vbscript", "data", "file"]);

    if (context === "link") {
      if (scheme === null) return true; // relative/anchor link is fine
      // For links, data: is also blocked (can carry script payloads).
      return !new Set(["javascript", "vbscript", "data"]).has(scheme);
    }

    // context === "src"
    if (scheme === null) return true; // relative/absolute path (incl. /api/files)
    if (dangerous.has(scheme)) return false;
    return scheme === "http" || scheme === "https" || scheme === "mailto";
  }

  /**
   * Recursively walk a ProseMirror doc and reject any unsafe URL on a link
   * mark href or on a media node's src/url. Media nodes covered: image,
   * attachment, video, plus embed (rendered as an iframe), youtube, drawio
   * and excalidraw — all of which carry a user-controlled URL that Docmost
   * renders. Throws a clear error on the first violation. A max-depth guard
   * turns an over-deep document into a clean error instead of a RangeError
   * stack overflow.
   */
  protected validateDocUrls(node: any, depth: number = 0): void {
    const MAX_DEPTH = 200;
    if (depth > MAX_DEPTH) {
      throw new Error(
        `document nesting exceeds the maximum depth of ${MAX_DEPTH}`,
      );
    }
    if (!node || typeof node !== "object") return;

    // Link marks on text nodes: validate the href.
    if (Array.isArray(node.marks)) {
      for (const mark of node.marks) {
        if (mark && mark.type === "link" && mark.attrs) {
          if (!this.isSafeUrl(mark.attrs.href, "link")) {
            throw new Error(`unsafe link href rejected: "${mark.attrs.href}"`);
          }
        }
      }
    }

    // Media nodes: validate src/url against the stricter src allowlist.
    // embed renders as an iframe (highest risk); youtube/drawio/excalidraw
    // likewise carry a user-controlled URL Docmost renders, so they get the
    // same scheme check as image/attachment/video.
    if (
      node.type === "image" ||
      node.type === "attachment" ||
      node.type === "video" ||
      node.type === "embed" ||
      node.type === "youtube" ||
      node.type === "drawio" ||
      node.type === "excalidraw" ||
      node.type === "audio" ||
      node.type === "pdf"
    ) {
      const attrs = node.attrs || {};
      for (const key of ["src", "url"]) {
        if (attrs[key] != null && !this.isSafeUrl(attrs[key], "src")) {
          throw new Error(
            `unsafe ${node.type} ${key} rejected: "${attrs[key]}"`,
          );
        }
      }
    }

    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        this.validateDocUrls(child, depth + 1);
      }
    }
  }

  /**
   * Recursively validate the STRUCTURE of a ProseMirror node (reuses the
   * recursion shape of validateDocUrls). Every node must be an object with a
   * string `type`; when present, `content` must be an array, `marks` must be
   * an array of objects each with a string `type`, and a text node's `text`
   * must be a string. Throws a clear "invalid ProseMirror document" error on
   * the first violation. A max-depth guard turns an over-deep document into a
   * clean error instead of a RangeError stack overflow.
   */
  protected validateDocStructure(node: any, depth: number = 0): void {
    const MAX_DEPTH = 200;
    if (depth > MAX_DEPTH) {
      throw new Error(
        `invalid ProseMirror document: nesting exceeds the maximum depth of ${MAX_DEPTH}`,
      );
    }
    if (!node || typeof node !== "object" || typeof node.type !== "string") {
      throw new Error(
        "invalid ProseMirror document: every node must be an object with a string `type`",
      );
    }
    if (
      "text" in node &&
      node.type === "text" &&
      typeof node.text !== "string"
    ) {
      throw new Error(
        "invalid ProseMirror document: a text node must have a string `text`",
      );
    }
    if (node.marks !== undefined) {
      if (!Array.isArray(node.marks)) {
        throw new Error(
          "invalid ProseMirror document: `marks` must be an array",
        );
      }
      for (const mark of node.marks) {
        if (
          !mark ||
          typeof mark !== "object" ||
          typeof mark.type !== "string"
        ) {
          throw new Error(
            "invalid ProseMirror document: every mark must be an object with a string `type`",
          );
        }
      }
    }
    if (node.content !== undefined) {
      if (!Array.isArray(node.content)) {
        throw new Error(
          "invalid ProseMirror document: `content` must be an array when present",
        );
      }
      for (const child of node.content) {
        this.validateDocStructure(child, depth + 1);
      }
    }
  }

  /**
   * Pre-write SHAPE gate (#409). Walk the WHOLE node tree with the shared
   * `findInvalidNode` and throw a rich, path-anchored error the instant a nested
   * node has an absent/unknown `type` (or an unknown mark) — the exact shape that
   * otherwise surfaces DEEP in the Yjs encode as the cryptic
   * `Unknown node type: undefined`, but only AFTER a collab session was opened
   * and a page lock taken. Calling this BEFORE `getCollabTokenWithReauth` /
   * `mutatePageContent` fails fast: no collab connection, no lock, deterministic
   * message. `op` names the tool for the message prefix (e.g. "patchNode").
   *
   * `findInvalidNode` derives its "known type" set from the very same
   * `docmostExtensions` the encode path uses, so a node this gate accepts is one
   * the encoder will accept too.
   */
  protected assertValidNodeShape(op: string, node: any): void {
    const bad = findInvalidNode(node);
    if (bad) {
      throw new Error(`${op}: invalid node — ${bad.summary}`);
    }
  }

  /**
   * Replace page content with a raw ProseMirror JSON document (lossless) and/or
   * update its title. Both `doc` and `title` are optional, but at least one must
   * be supplied:
   *  - `doc` provided   -> validate + full-overwrite the body (and update the
   *                        title too when `title` is also given).
   *  - `doc` omitted, `title` given -> title-only update; the body is NOT
   *                        touched/resent (no collab write happens).
   *  - neither given    -> throws (nothing to update).
   */
  }
  return DocValidateMixin;
}
