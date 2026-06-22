import { type Extensions, type JSONContent, getSchema } from '@tiptap/core';
import { Node } from '@tiptap/pm/model';
import { getHTMLFromFragment } from './getHTMLFromFragment';

/**
 * This function generates HTML from a ProseMirror JSON content object.
 *
 * @remarks **Important**: This function requires `happy-dom` to be installed in your project.
 * @param doc - The ProseMirror JSON content object.
 * @param extensions - The Tiptap extensions used to build the schema.
 * @returns The generated HTML string.
 * @example
 * ```js
 * const html = generateHTML(doc, extensions)
 * console.log(html)
 * ```
 */
export function generateHTML(doc: JSONContent, extensions: Extensions): string {
  // No global-`window` guard here: this helper is server-only and self-contained
  // (it serializes via `getHTMLFromFragment`, which creates its own happy-dom
  // `Window` and never reads the global `window`). A guard on `typeof window`
  // would be a false positive whenever a global `window` is injected into the
  // Node process (e.g. by the in-process MCP module, which sets `global.window`
  // via jsdom).

  const schema = getSchema(extensions);
  const contentNode = Node.fromJSON(schema, doc);

  return getHTMLFromFragment(contentNode, schema);
}
