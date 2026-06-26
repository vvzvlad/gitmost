import type { Extensions, JSONContent } from "@tiptap/core";
import { findChildren, getSchema } from "@tiptap/core";
import { Node } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import type { UniqueID } from "./unique-id";

/**
 * Creates a new document with unique IDs added to the nodes. Does the same
 * thing as the UniqueID extension, but without the need to create an `Editor`
 * instance. This lets you add unique IDs to the document in the server.
 *
 * When you call it, include the `UniqueID` extension in the `extensions` array.
 * The configuration from the `UniqueID` extension will be picked up
 * automatically, including its configuration options like `types` and
 * `attributeName`.
 *
 * @see `UniqueID` extension for more information.
 *
 * @throws {Error} If the `UniqueID` extension is not found in the extensions array.
 *
 * @example
 * const doc = {
 *   type: 'doc',
 *   content: [
 *     { type: 'paragraph', content: [{ type: 'text', text: 'Hello, world!' }] }
 *   ]
 * }
 * const newDoc = addUniqueIds(doc, [StarterKit, UniqueID.configure({ types: ['paragraph', 'heading'] })])
 * console.log(newDoc)
 * // Result:
 * // {
 * //   type: 'doc',
 * //   content: [
 * //     { type: 'paragraph', content: [{ type: 'text', text: 'Hello, world!' }], id: '123' }
 * //   ]
 * // }
 *
 * @param doc - A Tiptap JSON document to add unique IDs to.
 * @param extensions - The extensions to use. Must include the `UniqueID` extension.
 * @returns The updated Tiptap JSON document, with the unique IDs added to the nodes.
 */
export function addUniqueIdsToDoc(
  doc: JSONContent,
  extensions: Extensions,
): JSONContent {
  // Find the UniqueID extension in the extensions array. If it's not found, throw an error.
  const uniqueIDExtension = extensions.find(
    (ext) => ext.name === "uniqueID",
  ) as typeof UniqueID | undefined;
  if (!uniqueIDExtension) {
    throw new Error("UniqueID extension not found in the extensions array");
  }
  const { types, attributeName, generateID } = uniqueIDExtension.options;

  // Convert the JSON content to a ProseMirror node
  const schema = getSchema([
    ...extensions.filter((ext) => ext.name !== "uniqueID"),
    uniqueIDExtension,
  ]);
  const contentNode = Node.fromJSON(schema, doc);

  // All nodes of the configured types, in document order, so that the FIRST
  // occurrence of any given id keeps it and later duplicates get reassigned.
  const idNodes = findChildren(contentNode, (node) => {
    return types.includes(node.type.name);
  });

  // `transclusionSource` ids are cross-reference keys (a transclusionReference /
  // the page_transclusions table resolves a source by this id), so rewriting one
  // would orphan its references. We only fill a MISSING id for those, never
  // reassign an existing one; plain block anchors (heading/paragraph) are safe to
  // dedupe.
  const NO_REASSIGN = new Set(["transclusionSource"]);

  // Edit the document to (a) add ids where missing and (b) dedupe collisions. A
  // duplicate id otherwise lets copy/paste/import produce two nodes sharing an
  // id, so MCP addressed edits (patch_node / delete_node "before/after id") hit
  // the wrong node or both (#206 editor-pm-7). This previously only filled
  // missing ids and never deduplicated existing ones.
  const seenIds = new Set<string>();
  let tr = EditorState.create({
    doc: contentNode,
  }).tr;
  // eslint-disable-next-line no-restricted-syntax
  for (const { node, pos } of idNodes) {
    const currentId = node.attrs[attributeName];
    const isDuplicate = currentId != null && seenIds.has(currentId);
    const needsNewId =
      currentId == null || (isDuplicate && !NO_REASSIGN.has(node.type.name));

    if (needsNewId) {
      // setNodeAttribute only changes attributes (no size change), so positions
      // from the original node stay valid across the whole loop.
      const newId = generateID({ node, pos });
      tr = tr.setNodeAttribute(pos, attributeName, newId);
      seenIds.add(newId);
    } else if (currentId != null) {
      seenIds.add(currentId);
    }
  }

  // Return the updated document
  return tr.doc.toJSON();
}
