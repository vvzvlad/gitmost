// Auto-split from client.ts (issue #450). Mixin over the shared client context.
// Bodies are VERBATIM from the original DocmostClient; only the enclosing class
// changed to a mixin factory. See client/context.ts for the shared base.
import type { GConstructor, DocmostClientContext } from "./context.js";
import { parseCells as parseDrawioCells } from "../lib/drawio-xml.js";
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
  prepareModel,
  decodeDrawioSvg,
  buildDrawioSvg,
  mxHash,
  normalizeXml,
  countUserCells,
  extractDrawioRaster,
  stripRasterAttr,
} from "../lib/drawio-xml.js";
import { renderDiagramShapes } from "../lib/drawio-preview.js";
import { applyElkLayout } from "../lib/drawio-layout.js";
import {
  buildFromGraph,
  type Graph,
  type LayoutMode as GraphLayoutMode,
} from "../lib/drawio-graph.js";
import { applyCellOps, type CellOp } from "../lib/drawio-cell-ops.js";
import { mermaidToGraph } from "../lib/drawio-mermaid.js";
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

// Public method surface of DrawioMixin (issue #450) — a NAMED type so the factory
// return type is expressible in the emitted .d.ts (the anonymous mixin class
// carries the base's protected shared state, which would otherwise trip TS4094).
// Derived from the class below; `implements IDrawioMixin` fails to compile on drift.
export interface IDrawioMixin {
  drawioGet(pageId: string, node: string, format?: "xml" | "svg"): Promise<{ pageId: string; nodeId: string; format: "xml" | "svg"; content: string; meta: { attachmentId: string | null; title: string | null; width: number | null; height: number | null; cellCount: number; hash: string; hasRaster: boolean; }; }>;
  drawioCreate(pageId: string, where: { position: "before" | "after" | "append"; anchorNodeId?: string; anchorText?: string; }, xml: string, title?: string, layout?: "elk"): Promise<{ success: boolean; nodeId: string | null; attachmentId: string; warnings: string[]; verify?: any; }>;
  drawioUpdate(pageId: string, node: string, xml: string, baseHash: string, layout?: "elk"): Promise<{ success: boolean; nodeId: string; attachmentId: string; warnings: string[]; verify?: any; }>;
  drawioEditCells(pageId: string, node: string, operations: CellOp[], baseHash: string): Promise<{ success: boolean; nodeId: string; attachmentId: string; warnings: string[]; verify?: any; }>;
  drawioFromGraph(pageId: string, where: { position: "before" | "after" | "append"; anchorNodeId?: string; anchorText?: string; }, graph: Graph, direction?: "LR" | "RL" | "TB" | "BT", preset?: string, layout?: GraphLayoutMode, node?: string): Promise<{ success: boolean; nodeId: string | null; attachmentId: string; warnings: string[]; iconsResolved: number; iconsMissing: string[]; verify?: any; }>;
  drawioFromMermaid(pageId: string, where: { position: "before" | "after" | "append"; anchorNodeId?: string; anchorText?: string; }, mermaid: string, preset?: string): Promise<{ success: boolean; nodeId: string | null; attachmentId: string; warnings: string[]; iconsResolved: number; iconsMissing: string[]; verify?: any; }>;
}

export function DrawioMixin<TBase extends GConstructor<DocmostClientContext>>(Base: TBase): GConstructor<DocmostClientContext & IDrawioMixin> & TBase {
  abstract class DrawioMixin extends Base implements IDrawioMixin {
  /**
   * Resolve a drawio node on a page by its `#<index>` and return the node plus
   * its ref. Drawio nodes carry no id in the schema, so `#<index>` is the
   * reliable ref (the resolver also accepts an attrs.id, which only a rare
   * legacy node carries). Throws a clear error if the ref does not resolve to a
   * drawio node.
   */
  protected async resolveDrawioNode(
    pageId: string,
    node: string,
  ): Promise<{ node: any; ref: string }> {
    const data = await this.getPageRaw(pageId);
    const hit = getNodeByRef(
      data.content ?? { type: "doc", content: [] },
      node,
    );
    if (!hit) {
      throw new Error(
        `drawio: no node found for "${node}" on page ${pageId} (use the diagram block's "#<index>" from getOutline — drawio nodes carry no id in the schema)`,
      );
    }
    if (hit.type !== "drawio") {
      throw new Error(
        `drawio: node "${node}" on page ${pageId} is a ${hit.type}, not a drawio diagram`,
      );
    }
    return { node: hit.node, ref: node };
  }

  /**
   * Read a drawio diagram as mxGraph XML (default) or as the raw `.drawio.svg`.
   * Runs the decode chain (base64/entity content= → drawio file → nested XML or
   * pako-inflated compressed <diagram>). The returned `hash` is the
   * optimistic-lock key for drawioUpdate.
   */
  async drawioGet(
    pageId: string,
    node: string,
    format: "xml" | "svg" = "xml",
  ): Promise<{
    pageId: string;
    nodeId: string;
    format: "xml" | "svg";
    content: string;
    meta: {
      attachmentId: string | null;
      title: string | null;
      width: number | null;
      height: number | null;
      cellCount: number;
      hash: string;
      hasRaster: boolean;
    };
  }> {
    await this.ensureAuthenticated();
    const { node: drawio } = await this.resolveDrawioNode(pageId, node);
    const attrs = drawio.attrs || {};
    const src = attrs.src;
    if (!src) {
      throw new Error(
        `drawio: node "${node}" on page ${pageId} has no src to read`,
      );
    }
    const rawSvg = await this.fetchAttachmentText(src);
    // A `.drawio.svg` may carry a ~100 KB browser-embedded PNG raster (#629).
    // Detect it (validated) for meta.hasRaster, then STRIP the attribute at the
    // string level BEFORE the decodeDrawioSvg jsdom parse (so a huge attribute
    // never reaches jsdom) and before returning the svg (so it never bloats the
    // model context on format:"svg").
    const hasRaster = extractDrawioRaster(rawSvg) !== null;
    const svg = stripRasterAttr(rawSvg);
    const modelXml = decodeDrawioSvg(svg);
    const meta = {
      attachmentId: attrs.attachmentId ?? null,
      title: attrs.title ?? null,
      width: attrs.width != null ? Number(attrs.width) : null,
      height: attrs.height != null ? Number(attrs.height) : null,
      cellCount: countUserCells(modelXml),
      hash: mxHash(modelXml),
      hasRaster,
    };
    return {
      pageId,
      nodeId: attrs.id ?? node,
      format,
      content: format === "svg" ? svg : normalizeXml(modelXml),
      meta,
    };
  }

  /**
   * Create a drawio diagram from mxGraph XML: lint → schematic SVG preview
   * (pure TS) → build the `.drawio.svg` (createDrawioSvg contract) → create the
   * attachment → insert a `drawio` node before/after an anchor or appended.
   * `xml` is a bare `<mxGraphModel>` or a list of `<mxCell>` (the server wraps
   * it and adds the id=0/id=1 sentinels).
   */
  async drawioCreate(
    pageId: string,
    where: {
      position: "before" | "after" | "append";
      anchorNodeId?: string;
      anchorText?: string;
    },
    xml: string,
    title?: string,
    layout?: "elk",
  ): Promise<{
    success: boolean;
    // `null` when the diagram was written but nested (no addressable "#<index>"
    // handle) — see the nested-insert branch below (#494).
    nodeId: string | null;
    attachmentId: string;
    warnings: string[];
    verify?: any;
  }> {
    await this.ensureAuthenticated();
    if (
      !where ||
      (where.position !== "before" &&
        where.position !== "after" &&
        where.position !== "append")
    ) {
      throw new Error(
        'drawioCreate: `where.position` must be one of "before", "after", "append"',
      );
    }
    if (where.position === "before" || where.position === "after") {
      const hasId =
        typeof where.anchorNodeId === "string" && where.anchorNodeId.length > 0;
      const hasText =
        typeof where.anchorText === "string" && where.anchorText.length > 0;
      if (hasId === hasText) {
        throw new Error(
          `drawioCreate: position "${where.position}" requires exactly one of anchorNodeId or anchorText`,
        );
      }
    }

    // Optional server-side ELK auto-layout: the model declares structure with
    // rough coords, ELK computes the pixels (best-effort — returns the input
    // unchanged on any layout failure).
    const laidOutXml = layout === "elk" ? await applyElkLayout(xml) : xml;
    // Pre-write pipeline (throws a structured DrawioLintError on any violation).
    const prepared = prepareModel(laidOutXml);
    const inner = renderDiagramShapes(prepared.cells, prepared.bbox);
    const diagramTitle = title || "Page-1";
    const svg = buildDrawioSvg(prepared.modelXml, inner, prepared.bbox, diagramTitle);

    const att = await this.uploadAttachmentBuffer(
      pageId,
      Buffer.from(svg, "utf-8"),
      "diagram.drawio.svg",
      "image/svg+xml",
    );

    // NOTE: no `id` attribute is set here. The vendored `drawio` node schema
    // (diagramAttributes) declares no `id`, so any block id would be silently
    // dropped by PMNode.fromJSON on save and the returned handle would fail to
    // resolve. The addressable handle is the node's "#<index>" (like image/table
    // nodes), computed after the insert below.
    const drawioNode: any = {
      type: "drawio",
      attrs: {
        src: `/api/files/${att.id}/${att.fileName}`,
        attachmentId: att.id,
        width: prepared.bbox.width,
        height: prepared.bbox.height,
        align: "center",
      },
    };
    if (title) drawioNode.attrs.title = title;
    // Reuse the existing URL trust boundary (rejects unsafe src schemes).
    this.validateDocUrls(drawioNode);

    const collabToken = await this.getCollabTokenWithReauth();
    const pageUuid = await this.resolvePageId(pageId);

    let inserted = false;
    let insertedIndex = -1;
    const mutation = await this.mutatePage(
      pageUuid,
      collabToken,
      this.apiUrl,
      (liveDoc) => {
        inserted = false;
        insertedIndex = -1;
        const { doc: nd, inserted: ins } = insertNodeRelative(
          liveDoc,
          drawioNode,
          where,
        );
        inserted = ins;
        if (!inserted) return null; // anchor not found -> skip the write
        // Locate the freshly-inserted node to derive its "#<index>" handle. The
        // just-uploaded attachmentId is unique, so it identifies our node.
        if (Array.isArray(nd.content)) {
          insertedIndex = nd.content.findIndex(
            (b: any) =>
              b &&
              b.type === "drawio" &&
              b.attrs &&
              b.attrs.attachmentId === att.id,
          );
        }
        return nd;
      },
    );

    if (!inserted) {
      const anchorDesc = where.anchorNodeId
        ? `anchorNodeId "${where.anchorNodeId}"`
        : `anchorText "${where.anchorText}"`;
      throw new Error(
        `drawioCreate: anchor not found (${anchorDesc}) on page ${pageId}. The diagram attachment ${att.id} is now an unreferenced orphan.`,
      );
    }

    if (insertedIndex < 0) {
      // The node was inserted nested (e.g. inside a callout/table cell via an
      // anchor), where "#<index>" — which addresses only top-level blocks —
      // cannot reference it. drawio nodes carry no persisted id, so there is no
      // stable handle for a nested diagram.
      //
      // CRITICAL (#494): the diagram is ALREADY WRITTEN and committed at this
      // point (the mutation above succeeded). Throwing here reported a FAILURE for
      // a write that in fact landed, so a retry-prone agent re-ran drawioCreate
      // and inserted a DUPLICATE diagram (the #435 double-apply class). Return
      // SUCCESS with nodeId:null and a warning instead: the write is
      // acknowledged, and the agent is told there is no addressable handle and how
      // to re-read the diagram — so it never blind-retries a landed write.
      return {
        success: true,
        nodeId: null,
        attachmentId: att.id,
        warnings: [
          ...prepared.warnings,
          `The diagram was written on page ${pageId} but as a NESTED block (not ` +
            `top-level), so it has no addressable "#<index>" handle. It is saved ` +
            `— do NOT re-create it. To read or edit it, locate it via getOutline ` +
            `/ getPageJson (attachmentId ${att.id}). To get a stable "#<index>" ` +
            `handle, anchor on a top-level block (or append).`,
        ],
        verify: mutation.verify,
      };
    }

    // The returned handle is POSITIONAL ("#<index>"): valid for the immediate
    // create -> get/update flow, but re-resolve via getOutline if the document
    // structure changes (blocks added/removed before it shift the index).
    const nodeId = `#${insertedIndex}`;

    return {
      success: true,
      nodeId,
      attachmentId: att.id,
      warnings: prepared.warnings,
      verify: mutation.verify,
    };
  }

  /**
   * Full-replacement update of a drawio diagram. `baseHash` is MANDATORY: it is
   * compared against the hash of the diagram's CURRENT XML (from drawioGet);
   * any mismatch means a human or another agent edited the diagram after the
   * read, so the write is refused with a conflict error. On success the new
   * `.drawio.svg` is uploaded as a FRESH attachment (in-place byte overwrite is
   * avoided — some Docmost versions corrupt an attachment on overwrite, exactly
   * as replaceImage documents) and the node is repointed with new dimensions.
   *
   * KNOWN LIMITATION (same class as replaceImage's, see media.ts): this repoints
   * `src`/`attachmentId` on the SAME node, so the diagram COUNT is unchanged
   * (drawio: 1 -> 1) and no text or marks move — `summarizeChange` therefore may
   * report `verify.changed === false`. #600 added drawio/excalidraw integrity
   * counts, which name a diagram that is LOST or GAINED; an attribute-only swap
   * of a surviving diagram is still outside the text+marks+counts model. That is
   * acceptable here: the write is confirmed by `repointed` / the baseHash CAS,
   * and verify is supplementary.
   */
  async drawioUpdate(
    pageId: string,
    node: string,
    xml: string,
    baseHash: string,
    layout?: "elk",
  ): Promise<{
    success: boolean;
    nodeId: string;
    attachmentId: string;
    warnings: string[];
    verify?: any;
  }> {
    await this.ensureAuthenticated();
    if (typeof baseHash !== "string" || baseHash.length === 0) {
      throw new Error(
        "drawioUpdate: baseHash is mandatory — read the diagram with drawioGet first and pass back its meta.hash",
      );
    }

    // Resolve the node and read the CURRENT diagram to enforce the optimistic
    // lock before doing any write or upload.
    const { node: drawio, ref } = await this.resolveDrawioNode(pageId, node);
    const oldAttrs = drawio.attrs || {};
    const oldSrc = oldAttrs.src;
    // The returned handle is the caller-supplied reference. drawio nodes carry
    // no persisted id, so `ref` (an "#<index>" or a rare legacy attrs.id) is the
    // honest identifier to hand back.
    const nodeId = oldAttrs.id ?? ref;
    if (!oldSrc) {
      throw new Error(
        `drawioUpdate: node "${node}" on page ${pageId} has no src to compare against`,
      );
    }
    const currentSvg = await this.fetchAttachmentText(oldSrc);
    const currentHash = mxHash(decodeDrawioSvg(currentSvg));
    if (currentHash !== baseHash) {
      throw new Error(
        `drawioUpdate: conflict — the diagram changed since it was read ` +
          `(baseHash ${baseHash} != current ${currentHash}). Re-read it with drawioGet and retry.`,
      );
    }

    // Optional server-side ELK auto-layout (best-effort; see drawioCreate).
    const laidOutXml = layout === "elk" ? await applyElkLayout(xml) : xml;
    // Pipeline for the new content (throws a structured DrawioLintError).
    const prepared = prepareModel(laidOutXml);
    const inner = renderDiagramShapes(prepared.cells, prepared.bbox);
    const diagramTitle = oldAttrs.title || "Page-1";
    const svg = buildDrawioSvg(prepared.modelXml, inner, prepared.bbox, diagramTitle);

    const att = await this.uploadAttachmentBuffer(
      pageId,
      Buffer.from(svg, "utf-8"),
      "diagram.drawio.svg",
      "image/svg+xml",
    );
    const newSrc = `/api/files/${att.id}/${att.fileName}`;

    const collabToken = await this.getCollabTokenWithReauth();
    const pageUuid = await this.resolvePageId(pageId);

    let repointed = 0;
    const repoint = (n: any) => {
      n.attrs = {
        ...n.attrs,
        src: newSrc,
        attachmentId: att.id,
        width: prepared.bbox.width,
        height: prepared.bbox.height,
      };
      repointed++;
    };

    const mutation = await this.mutatePage(
      pageUuid,
      collabToken,
      this.apiUrl,
      (liveDoc) => {
        repointed = 0;
        const doc =
          liveDoc && liveDoc.type === "doc"
            ? liveDoc
            : { type: "doc", content: [] };
        if (!Array.isArray(doc.content)) doc.content = [];
        // Repoint ONLY the resolved node — never every node that happens to
        // share this attachmentId (a copied diagram is two nodes with one
        // attachmentId; keying on it would clobber both). Re-resolve the same
        // handle against the live doc and walk to its exact position.
        const hit = getNodeByRef(doc, ref);
        if (!hit || hit.type !== "drawio") return null; // vanished/changed -> skip
        let target: any = doc;
        for (const idx of hit.path) {
          if (!target || !Array.isArray(target.content)) {
            target = null;
            break;
          }
          target = target.content[idx];
        }
        if (!target || target.type !== "drawio") return null;
        repoint(target);
        if (repointed === 0) return null; // node vanished concurrently -> skip
        return doc;
      },
    );

    if (repointed === 0) {
      return {
        success: true,
        nodeId,
        attachmentId: att.id,
        warnings: [
          ...prepared.warnings,
          "target drawio node was removed concurrently; uploaded attachment is unreferenced",
        ],
        verify: mutation.verify,
      };
    }

    return {
      success: true,
      nodeId,
      attachmentId: att.id,
      warnings: prepared.warnings,
      verify: mutation.verify,
    };
  }

  // --- draw.io high-level semantic tools (issue #425) ---

  /**
   * ID-based targeted edits of an existing drawio diagram (add / update / delete
   * cells) instead of resending the whole XML. Reads the CURRENT diagram, checks
   * the optimistic lock (`baseHash` is MANDATORY, exactly as drawioUpdate), applies
   * the operations to the parsed model (a `delete` CASCADES to container children
   * and to every edge whose source/target is deleted), then runs the SAME #423
   * pipeline as drawioUpdate (lint + quality warnings -> preview -> attachment ->
   * repoint the node). Ids are stable so diffs stay meaningful across edits.
   */

  // --- draw.io high-level semantic tools (issue #425) ---

  /**
   * ID-based targeted edits of an existing drawio diagram (add / update / delete
   * cells) instead of resending the whole XML. Reads the CURRENT diagram, checks
   * the optimistic lock (`baseHash` is MANDATORY, exactly as drawioUpdate), applies
   * the operations to the parsed model (a `delete` CASCADES to container children
   * and to every edge whose source/target is deleted), then runs the SAME #423
   * pipeline as drawioUpdate (lint + quality warnings -> preview -> attachment ->
   * repoint the node). Ids are stable so diffs stay meaningful across edits.
   *
   * KNOWN LIMITATION: shares drawioUpdate's attribute-only blind spot — the node
   * is repointed, so the diagram count stays 1 -> 1 and `verify.changed` may be
   * false. The write is confirmed by `repointed` / the baseHash CAS, not verify.
   */
  async drawioEditCells(
    pageId: string,
    node: string,
    operations: CellOp[],
    baseHash: string,
  ): Promise<{
    success: boolean;
    nodeId: string;
    attachmentId: string;
    warnings: string[];
    verify?: any;
  }> {
    await this.ensureAuthenticated();
    if (typeof baseHash !== "string" || baseHash.length === 0) {
      throw new Error(
        "drawioEditCells: baseHash is mandatory — read the diagram with drawioGet first and pass back its meta.hash",
      );
    }
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new Error(
        "drawioEditCells: operations must be a non-empty array of { op, ... }",
      );
    }

    const { node: drawio, ref } = await this.resolveDrawioNode(pageId, node);
    const oldAttrs = drawio.attrs || {};
    const oldSrc = oldAttrs.src;
    const nodeId = oldAttrs.id ?? ref;
    if (!oldSrc) {
      throw new Error(
        `drawioEditCells: node "${node}" on page ${pageId} has no src to edit`,
      );
    }
    const currentSvg = await this.fetchAttachmentText(oldSrc);
    const currentModel = decodeDrawioSvg(currentSvg);
    const currentHash = mxHash(currentModel);
    if (currentHash !== baseHash) {
      throw new Error(
        `drawioEditCells: conflict — the diagram changed since it was read ` +
          `(baseHash ${baseHash} != current ${currentHash}). Re-read it with drawioGet and retry.`,
      );
    }

    // Apply the operations to the parsed model, then run the standard pipeline.
    const editedModel = applyCellOps(currentModel, operations);
    const prepared = prepareModel(editedModel);
    const inner = renderDiagramShapes(prepared.cells, prepared.bbox);
    const diagramTitle = oldAttrs.title || "Page-1";
    const svg = buildDrawioSvg(prepared.modelXml, inner, prepared.bbox, diagramTitle);

    const att = await this.uploadAttachmentBuffer(
      pageId,
      Buffer.from(svg, "utf-8"),
      "diagram.drawio.svg",
      "image/svg+xml",
    );
    const newSrc = `/api/files/${att.id}/${att.fileName}`;

    const collabToken = await this.getCollabTokenWithReauth();
    const pageUuid = await this.resolvePageId(pageId);

    let repointed = 0;
    const mutation = await this.mutatePage(
      pageUuid,
      collabToken,
      this.apiUrl,
      (liveDoc) => {
        repointed = 0;
        const doc =
          liveDoc && liveDoc.type === "doc" ? liveDoc : { type: "doc", content: [] };
        if (!Array.isArray(doc.content)) doc.content = [];
        const hit = getNodeByRef(doc, ref);
        if (!hit || hit.type !== "drawio") return null;
        let target: any = doc;
        for (const idx of hit.path) {
          if (!target || !Array.isArray(target.content)) {
            target = null;
            break;
          }
          target = target.content[idx];
        }
        if (!target || target.type !== "drawio") return null;
        target.attrs = {
          ...target.attrs,
          src: newSrc,
          attachmentId: att.id,
          width: prepared.bbox.width,
          height: prepared.bbox.height,
        };
        repointed++;
        return doc;
      },
    );

    if (repointed === 0) {
      return {
        success: true,
        nodeId,
        attachmentId: att.id,
        warnings: [
          ...prepared.warnings,
          "target drawio node was removed concurrently; uploaded attachment is unreferenced",
        ],
        verify: mutation.verify,
      };
    }
    return {
      success: true,
      nodeId,
      attachmentId: att.id,
      warnings: prepared.warnings,
      verify: mutation.verify,
    };
  }

  /**
   * The main high-level tool: build a diagram from a SEMANTIC graph (nodes with
   * a `kind`/`icon`, groups, edges) — the model never supplies coordinates or
   * style strings. The server resolves icons via the shape catalog (#424),
   * assigns palette colors from the preset, runs ELK layered layout (honouring
   * `direction` and the `layer`/`sameLayerAs`/`pinned` hints and compound groups),
   * and assembles linter-clean XML, then inserts it through the SAME create
   * pipeline as drawioCreate. `layout:"incremental"` is only meaningful when a
   * target `node` is given (it preserves that diagram's existing coordinates and
   * places only new cells); on a fresh insert it behaves like "full".
   */
  async drawioFromGraph(
    pageId: string,
    where: {
      position: "before" | "after" | "append";
      anchorNodeId?: string;
      anchorText?: string;
    },
    graph: Graph,
    direction?: "LR" | "RL" | "TB" | "BT",
    preset?: string,
    layout?: GraphLayoutMode,
    node?: string,
  ): Promise<{
    success: boolean;
    // `null` when written nested (no addressable handle) — inherited from
    // drawioCreate (#494).
    nodeId: string | null;
    attachmentId: string;
    warnings: string[];
    iconsResolved: number;
    iconsMissing: string[];
    verify?: any;
  }> {
    await this.ensureAuthenticated();
    // Direction/preset supplied as separate params override the graph fields so
    // both the flat tool schema and an inline graph can set them.
    const merged: Graph = {
      ...graph,
      direction: direction ?? graph.direction,
      preset: preset ?? graph.preset,
    };
    const mode: GraphLayoutMode = layout ?? "full";

    // Incremental into an EXISTING node: read its coords so ELK preserves them,
    // and keep the full existing model so incremental MERGES (never drops) any
    // cell the new graph doesn't re-list.
    let existingCoords: Map<string, { x: number; y: number }> | undefined;
    let existingModelXml: string | undefined;
    let editExisting = false;
    let baseHash: string | undefined;
    if (node && (mode === "incremental" || mode === "none")) {
      const { node: drawio } = await this.resolveDrawioNode(pageId, node);
      const src = (drawio.attrs || {}).src;
      if (src) {
        const svg = await this.fetchAttachmentText(src);
        const model = decodeDrawioSvg(svg);
        baseHash = mxHash(model);
        existingModelXml = model;
        existingCoords = new Map();
        for (const c of parseDrawioCells(model)) {
          if (c.vertex && c.geometry.x != null && c.geometry.y != null) {
            existingCoords.set(c.id, { x: c.geometry.x, y: c.geometry.y });
          }
        }
        editExisting = true;
      }
    }

    const built = await buildFromGraph(
      merged,
      mode,
      existingCoords,
      existingModelXml,
    );

    if (editExisting && node && baseHash) {
      // Re-target the existing diagram: replace it with the assembled model.
      const res = await this.drawioUpdate(pageId, node, built.modelXml, baseHash);
      return {
        ...res,
        iconsResolved: built.iconsResolved,
        iconsMissing: built.iconsMissing,
      };
    }

    const res = await this.drawioCreate(pageId, where, built.modelXml);
    return {
      ...res,
      iconsResolved: built.iconsResolved,
      iconsMissing: built.iconsMissing,
    };
  }

  /**
   * Convert a Mermaid `flowchart` to a redactable draw.io diagram via a PURE
   * parser (no Electron / draw.io CLI): mermaid text -> graph-JSON -> the
   * drawioFromGraph pipeline. Only `flowchart`/`graph` is supported (the most
   * common wiki case); other diagram types throw a clear error so the model can
   * fall back to drawioFromGraph.
   */
  async drawioFromMermaid(
    pageId: string,
    where: {
      position: "before" | "after" | "append";
      anchorNodeId?: string;
      anchorText?: string;
    },
    mermaid: string,
    preset?: string,
  ): Promise<{
    success: boolean;
    // `null` when written nested (no addressable handle) — inherited from
    // drawioFromGraph/drawioCreate (#494).
    nodeId: string | null;
    attachmentId: string;
    warnings: string[];
    iconsResolved: number;
    iconsMissing: string[];
    verify?: any;
  }> {
    await this.ensureAuthenticated();
    const graph = mermaidToGraph(mermaid);
    if (preset) graph.preset = preset;
    return this.drawioFromGraph(pageId, where, graph, graph.direction, graph.preset);
  }

  // --- Page history / diff / transform ---

  /**
   * List the saved versions (history snapshots) of a page, newest first.
   * Docmost auto-snapshots on every save. Returns one cursor-paginated page of
   * results: `{ items, nextCursor }`. The history record's id field is `id`.
   */
  }
  return DrawioMixin;
}
