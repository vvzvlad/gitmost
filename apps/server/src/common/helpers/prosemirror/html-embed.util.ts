import { JSONContent } from '@tiptap/core';

export const HTML_EMBED_NODE_NAME = 'htmlEmbed';

/**
 * Recursively remove every `htmlEmbed` node from a ProseMirror JSON document.
 *
 * SECURITY: `htmlEmbed` renders raw, unsanitized HTML/CSS/JS in the wiki origin
 * (stored-XSS by design, Variant C). Only workspace admins/owners are allowed to
 * author it. This helper is the server-side enforcement primitive: every WRITE
 * path that may persist content from a NON-admin caller must run the incoming
 * document through this function so a non-admin cannot smuggle the node in via
 * the collab socket, the REST/MCP/AI content-update path, paste, or import.
 *
 * Returns a NEW document; the input is not mutated. If the input is not a valid
 * doc object it is returned unchanged (callers persist what they were given).
 */
export function stripHtmlEmbedNodes<T = JSONContent>(pmJson: T): T {
  if (!pmJson || typeof pmJson !== 'object') {
    return pmJson;
  }

  const node = pmJson as unknown as JSONContent;

  // Defensive root-type check: if the ROOT node is itself an htmlEmbed, the
  // children-filtering below could never drop it, so a bare htmlEmbed would be
  // returned as-is. This branch is unreachable in normal use (the PM document
  // root is always a `doc`) and exists only to make the helper total — a bare
  // htmlEmbed can never be returned by this function.
  if (node.type === HTML_EMBED_NODE_NAME) {
    return { type: 'doc', content: [] } as unknown as T;
  }

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
 * in its tree. Useful to decide whether a strip pass actually changed anything
 * (e.g. for logging a rejected non-admin embed attempt).
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
 * Map the workspace user role to whether it may author `htmlEmbed` nodes.
 * Owners and admins are trusted; everyone else (member, and any unknown role)
 * is not. Kept here so every write path shares one definition of "trusted".
 */
export function canAuthorHtmlEmbed(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

/**
 * Combined write-path gate for the htmlEmbed feature.
 *
 * htmlEmbed is allowed in a document only when the workspace feature toggle is
 * ON and the authoring/saving user is a workspace admin/owner. OFF (default) =>
 * stripped for EVERYONE, including admins (the feature is disabled).
 *
 * `featureEnabled` is read from the workspace settings for the relevant write
 * (`workspace.settings?.htmlEmbed === true`). Every WRITE path that may persist
 * htmlEmbed content must gate on this combined predicate, so that turning the
 * toggle OFF strips existing embeds on the next save and prevents new ones from
 * being persisted regardless of role.
 */
export function htmlEmbedAllowed(
  featureEnabled: boolean,
  role: string | null | undefined,
): boolean {
  return featureEnabled === true && canAuthorHtmlEmbed(role);
}

/**
 * Read the workspace-level htmlEmbed feature toggle from a workspace's settings
 * jsonb. ABSENT/non-true => OFF (the default). Kept here so every server write
 * path resolves the toggle the same way.
 */
export function isHtmlEmbedFeatureEnabled(
  settings: unknown | null | undefined,
): boolean {
  if (!settings || typeof settings !== 'object') {
    return false;
  }
  return (settings as Record<string, unknown>).htmlEmbed === true;
}
