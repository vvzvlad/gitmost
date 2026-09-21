/**
 * Filter functions to extract only relevant information from API responses
 * for better agent consumption
 */

export function filterWorkspace(data: any) {
  return {
    id: data.id,
    name: data.name,
    description: data.description,
    defaultSpaceId: data.defaultSpaceId,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    deletedAt: data.deletedAt,
  };
}

export function filterSpace(space: any) {
  return {
    id: space.id,
    name: space.name,
    description: space.description,
    slug: space.slug,
    visibility: space.visibility,
    createdAt: space.createdAt,
    updatedAt: space.updatedAt,
    deletedAt: space.deletedAt,
  };
}

export function filterGroup(group: any) {
  return {
    id: group.id,
    name: group.name,
    description: group.description,
    workspaceId: group.workspaceId,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    deletedAt: group.deletedAt,
  };
}

export function filterPage(page: any, content?: string, subpages?: any[]) {
  return {
    id: page.id,
    slugId: page.slugId,
    title: page.title,
    parentPageId: page.parentPageId,
    spaceId: page.spaceId,
    isLocked: page.isLocked,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    deletedAt: page.deletedAt,
    // Include converted markdown content if valid string (even empty)
    ...(typeof content === "string" && { content }),
    // Include subpages if provided
    ...(subpages &&
      subpages.length > 0 && {
        subpages: subpages.map((p) => ({ id: p.id, title: p.title })),
      }),
  };
}

export function filterComment(comment: any, markdownContent?: string) {
  return {
    id: comment.id,
    pageId: comment.pageId,
    content: markdownContent ?? comment.content,
    selection: comment.selection || null,
    type: comment.type || "page",
    parentCommentId: comment.parentCommentId || null,
    creatorId: comment.creatorId,
    creatorName: comment.creator?.name || null,
    createdAt: comment.createdAt,
    editedAt: comment.editedAt || null,
    resolvedAt: comment.resolvedAt || null,
    resolvedById: comment.resolvedById || null,
    // Suggestion state: the proposed replacement text (if any) and, once a human
    // applies it via the UI, when and by whom.
    suggestedText: comment.suggestedText || null,
    suggestionAppliedAt: comment.suggestionAppliedAt || null,
    suggestionAppliedById: comment.suggestionAppliedById || null,
  };
}

// Map one server search hit to the MCP output contract (#443):
//   { pageId, title, path, snippet, score }
//
// INVARIANT: the only page identifier exposed is `pageId` (the server `id`
// UUID). The server also carries `slugId` — it is NEVER surfaced.
//
// GRACEFUL DEGRADATION: against a stock upstream server the opt-in lookup DTO
// fields are stripped, so the response is the legacy FTS shape (no path/snippet/
// score, a `highlight` + `rank` instead). We synthesize the contract from
// whatever is present: `snippet` falls back to the FTS `highlight`, `score` to
// the FTS `rank`, and `path` to [] (upstream has no path). This keeps the tool
// usable even when the server has not been upgraded.
export function filterSearchResult(result: any) {
  return {
    pageId: result.id,
    title: result.title,
    path: Array.isArray(result.path) ? result.path : [],
    snippet:
      typeof result.snippet === "string"
        ? result.snippet
        : (result.highlight ?? ""),
    score:
      typeof result.score === "number"
        ? result.score
        : typeof result.rank === "number"
          ? result.rank
          : 0,
  };
}
