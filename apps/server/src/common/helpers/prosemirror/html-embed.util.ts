import { JSONContent } from '@tiptap/core';

export const HTML_EMBED_NODE_NAME = 'htmlEmbed';

/**
 * Recursively remove every `htmlEmbed` node from a ProseMirror JSON document.
 *
 * The `htmlEmbed` node renders inside a SANDBOXED iframe (no `allow-same-origin`)
 * on the client, so its content cannot touch the viewer's session/cookies/API —
 * it is NOT a stored-XSS surface. This helper is retained ONLY to honor the
 * workspace master toggle (`settings.htmlEmbed`) on the anonymous public-share
 * read path: an anonymous viewer cannot read the workspace toggle, so the server
 * strips the block when the toggle is OFF before serving shared content.
 *
 * Returns a NEW document; the input is not mutated. If the input is not a valid
 * doc object it is returned unchanged (callers persist what they were given).
 */
export function stripHtmlEmbedNodes<T = JSONContent>(pmJson: T): T {
  if (!pmJson || typeof pmJson !== 'object') {
    return pmJson;
  }

  const node = pmJson as unknown as JSONContent;

  if (Array.isArray(node.content)) {
    const filtered: JSONContent[] = [];
    for (const child of node.content) {
      // Drop any htmlEmbed child outright.
      if (child && child.type === HTML_EMBED_NODE_NAME) {
        continue;
      }
      // Recurse so nested htmlEmbed nodes (e.g. inside columns/callouts) are
      // also removed.
      filtered.push(stripHtmlEmbedNodes(child));
    }
    return { ...node, content: filtered } as unknown as T;
  }

  return { ...node } as unknown as T;
}

/**
 * Returns true if the document contains at least one `htmlEmbed` node anywhere
 * in its tree. Useful to decide whether a strip pass on the share read path
 * actually changed anything. After the write-path role gate removal this is no
 * longer called by production code; it is retained as a test-only assertion
 * helper (and a detection primitive should a future read path need it).
 */
export function hasHtmlEmbedNode(pmJson: unknown): boolean {
  if (!pmJson || typeof pmJson !== 'object') {
    return false;
  }
  const node = pmJson as JSONContent;
  if (node.type === HTML_EMBED_NODE_NAME) {
    return true;
  }
  if (Array.isArray(node.content)) {
    return node.content.some((child) => hasHtmlEmbedNode(child));
  }
  return false;
}

/**
 * Read the workspace-level htmlEmbed master toggle from a workspace's settings
 * jsonb. ABSENT/non-true => OFF (the default). Kept here so the share read path
 * resolves the toggle the same way it is persisted.
 */
export function isHtmlEmbedFeatureEnabled(
  settings: unknown | null | undefined,
): boolean {
  if (!settings || typeof settings !== 'object') {
    return false;
  }
  return (settings as Record<string, unknown>).htmlEmbed === true;
}
