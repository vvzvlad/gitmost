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
 * Walk the document and collect a stable identity for every `htmlEmbed` node.
 *
 * The identity is the node's `attrs.source` string — the raw HTML the embed
 * renders. Two embeds that render the exact same HTML are treated as the same
 * identity. Used by the collab persist path to know which embeds are ALREADY
 * present in the currently-persisted (admin-vetted) page content, so a later
 * non-admin store can strip only NEWLY-introduced embeds while preserving the
 * pre-existing admin-authored ones.
 *
 * Absent attrs or a non-string/absent `source` are skipped gracefully (such a
 * node contributes no identity to the set).
 */
export function collectHtmlEmbedSources(pmJson: unknown): Set<string> {
  const sources = new Set<string>();

  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') {
      return;
    }
    const n = node as JSONContent;
    if (n.type === HTML_EMBED_NODE_NAME) {
      const source = (n.attrs as Record<string, unknown> | undefined)?.source;
      if (typeof source === 'string') {
        sources.add(source);
      }
    }
    if (Array.isArray(n.content)) {
      for (const child of n.content) {
        walk(child);
      }
    }
  };

  walk(pmJson);
  return sources;
}

/**
 * Like {@link stripHtmlEmbedNodes}, but KEEP any `htmlEmbed` node whose
 * `attrs.source` is in `allowedSources`; remove the rest.
 *
 * Used on the collab persist path when the feature toggle is ON but the storing
 * user is a NON-admin: `allowedSources` is the set of embed sources already
 * present in the currently-persisted page content (admin-authored, already
 * vetted). A non-admin therefore cannot ADD a new embed, but their unrelated
 * edit also cannot destroy an admin's existing one.
 *
 * NOTE: identity is the raw source string, so a non-admin who COPIES an existing
 * admin embed's exact source into a NEW location passes this check. That is
 * acceptable — the source is already admin-vetted content present in the doc; no
 * new untrusted HTML is introduced.
 *
 * Returns a NEW document; the input is not mutated. Same defensive root-type
 * check pattern as {@link stripHtmlEmbedNodes}.
 */
export function stripDisallowedHtmlEmbedNodes<T = JSONContent>(
  pmJson: T,
  allowedSources: Set<string>,
): T {
  if (!pmJson || typeof pmJson !== 'object') {
    return pmJson;
  }

  const node = pmJson as unknown as JSONContent;

  // Defensive root-type check (mirrors stripHtmlEmbedNodes): if the ROOT node is
  // itself an htmlEmbed and its source is NOT allowed, the children-filtering
  // below could never drop it, so neutralize it here. Unreachable in normal use
  // (the PM document root is always a `doc`).
  if (node.type === HTML_EMBED_NODE_NAME) {
    const source = (node.attrs as Record<string, unknown> | undefined)?.source;
    if (typeof source === 'string' && allowedSources.has(source)) {
      return { ...node } as unknown as T;
    }
    return { type: 'doc', content: [] } as unknown as T;
  }

  if (Array.isArray(node.content)) {
    const filtered: JSONContent[] = [];
    for (const child of node.content) {
      // Drop a disallowed htmlEmbed child (newly introduced); keep an allowed
      // one (already present in the persisted, admin-vetted content).
      if (child && child.type === HTML_EMBED_NODE_NAME) {
        const source = (child.attrs as Record<string, unknown> | undefined)
          ?.source;
        if (typeof source === 'string' && allowedSources.has(source)) {
          filtered.push({ ...child });
        }
        continue;
      }
      // Recurse so nested htmlEmbed nodes (e.g. inside columns/callouts) are
      // also filtered by the same allow-list.
      filtered.push(stripDisallowedHtmlEmbedNodes(child, allowedSources));
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
 * Strip htmlEmbed nodes unless the (feature-enabled AND role-allowed) gate
 * passes. Returns the possibly-stripped doc. The caller resolves featureEnabled
 * (from workspace settings) and role (actor) itself — those legitimately differ
 * per call-site (e.g. share path uses role=null) — this helper owns only the
 * has-check + AND + strip + optional onStrip callback.
 *
 * Centralizes the 4-step write-path ritual (resolve role -> resolve
 * featureEnabled -> htmlEmbedAllowed AND -> stripHtmlEmbedNodes) so the plain
 * strip-all call-sites share one tested decision. Sites with CUSTOM strip logic
 * (e.g. the collab persist path's preserve-admin variant) keep their own code.
 */
export function stripHtmlEmbedIfNotAllowed<T>(
  json: T,
  opts: { featureEnabled: boolean; role: string | null | undefined; onStrip?: () => void },
): T {
  if (htmlEmbedAllowed(opts.featureEnabled, opts.role)) return json;
  if (hasHtmlEmbedNode(json)) {
    opts.onStrip?.();
    return stripHtmlEmbedNodes(json);
  }
  return json;
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
