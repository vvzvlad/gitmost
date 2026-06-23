import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { DOMSerializer, Node, Schema } from "@tiptap/pm/model";
import { ChangeSet, simplifyChanges } from "@tiptap/pm/changeset";
import { recreateTransform } from "@docmost/editor-ext";

export interface HistoryDiff {
  decorationSet: DecorationSet;
  added: number;
  deleted: number;
  total: number;
}

// Block-level nodes that are diffed as a whole ("this image/table/callout was
// added/removed") instead of by inline character ranges.
const SPECIAL_NODE_TYPES = new Set([
  "image",
  "attachment",
  "video",
  "excalidraw",
  "drawio",
  "mermaid",
  "mathBlock",
  "mathInline",
  "table",
  "details",
  "callout",
]);

// Pure core of the history diff (extracted from history-editor.tsx, behaviour
// preserving): given the editor schema and two ProseMirror document JSONs, return
// the decoration set plus added/deleted/total counts. The widget decorations carry
// lazy DOM-building callbacks (only run by ProseMirror at render time), so this
// function itself does no DOM work and needs no live editor instance.
//
// `previousContent` undefined -> first version, so there is nothing to diff
// (empty decorations, all counts 0). Malformed JSON that throws while building
// nodes falls back to the same empty diff so the caller can still render plain
// content without crashing.
export function computeHistoryDiff(
  schema: Schema,
  content: any,
  previousContent?: any,
): HistoryDiff {
  const empty: HistoryDiff = {
    decorationSet: DecorationSet.empty,
    added: 0,
    deleted: 0,
    total: 0,
  };

  if (!content || !previousContent) {
    return empty;
  }

  try {
    const oldContent = Node.fromJSON(schema, previousContent);
    const newContent = Node.fromJSON(schema, content);

    const tr = recreateTransform(oldContent, newContent, {
      complexSteps: false,
      wordDiffs: true,
      simplifyDiff: true,
    });

    const changeSet = ChangeSet.create(oldContent).addSteps(
      tr.doc,
      tr.mapping.maps,
      [],
    );
    const changes = simplifyChanges(changeSet.changes, newContent);

    const decorations: Decoration[] = [];
    let addedCount = 0;
    let deletedCount = 0;
    let changeIndex = 0;

    for (const change of changes) {
      if (change.toB > change.fromB) {
        changeIndex++;
        const currentIndex = changeIndex;
        let foundSpecialNode: { node: Node; pos: number } | null = null;
        newContent.nodesBetween(change.fromB, change.toB, (node, pos) => {
          if (SPECIAL_NODE_TYPES.has(node.type.name)) {
            const nodeEnd = pos + node.nodeSize;
            if (change.fromB <= pos && change.toB >= nodeEnd) {
              foundSpecialNode = { node, pos };
              return false;
            }
          }
        });

        if (foundSpecialNode) {
          const special = foundSpecialNode as { node: Node; pos: number };
          const nodeEnd = special.pos + special.node.nodeSize;
          decorations.push(
            Decoration.node(special.pos, nodeEnd, {
              class: "history-diff-node-added",
              "data-diff-index": String(currentIndex),
            }),
          );
        } else {
          decorations.push(
            Decoration.inline(change.fromB, change.toB, {
              class: "history-diff-added",
              "data-diff-index": String(currentIndex),
            }),
          );
        }
        addedCount += 1;
      }
      if (change.toA > change.fromA) {
        changeIndex++;
        const currentIndex = changeIndex;
        let foundDeletedNode: { node: Node; pos: number } | null = null;
        oldContent.nodesBetween(change.fromA, change.toA, (node, pos) => {
          if (SPECIAL_NODE_TYPES.has(node.type.name)) {
            const nodeEnd = pos + node.nodeSize;
            if (change.fromA <= pos && change.toA >= nodeEnd) {
              foundDeletedNode = { node, pos };
              return false;
            }
          }
        });

        if (foundDeletedNode) {
          const deletedNode = foundDeletedNode as { node: Node; pos: number };
          decorations.push(
            Decoration.widget(change.fromB, () => {
              const wrapper = document.createElement("div");
              wrapper.className = "history-diff-node-deleted";
              wrapper.setAttribute("data-diff-index", String(currentIndex));
              const serializer = DOMSerializer.fromSchema(schema);
              const dom = serializer.serializeNode(deletedNode.node);
              wrapper.appendChild(dom);
              return wrapper;
            }),
          );
        } else {
          const deletedText = oldContent.textBetween(
            change.fromA,
            change.toA,
            "",
          );
          if (deletedText) {
            decorations.push(
              Decoration.widget(change.fromB, () => {
                const span = document.createElement("span");
                span.className = "history-diff-deleted";
                span.setAttribute("data-diff-index", String(currentIndex));
                span.textContent = deletedText;
                return span;
              }),
            );
          }
        }
        deletedCount += 1;
      }
    }

    const decorationSet = DecorationSet.create(newContent, decorations);
    const total = addedCount + deletedCount;
    return { decorationSet, added: addedCount, deleted: deletedCount, total };
  } catch (e) {
    // Malformed version JSON: fall back to a plain (no-diff) render.
    console.error("History diff failed:", e);
    return empty;
  }
}
