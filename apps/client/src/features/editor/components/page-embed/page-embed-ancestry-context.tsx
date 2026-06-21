import React, { createContext, useContext, useMemo } from "react";

/** Hard cap on nesting depth for whole-page embeds (cycle/runaway guard). */
export const PAGE_EMBED_MAX_DEPTH = 5;

type AncestryValue = {
  /** sourcePageIds of every ancestor pageEmbed up the render tree. */
  chain: string[];
  /** Includes the host page id so a top-level self-embed is also caught. */
  hostPageId: string | null;
};

const PageEmbedAncestryContext = createContext<AncestryValue>({
  chain: [],
  hostPageId: null,
});

/**
 * Carries the ancestor `sourcePageId` chain down the nested read-only editors.
 * The node view reads it to detect cycles (current id already in the chain) and
 * to enforce a hard depth limit before mounting a deeper nested editor.
 */
export function PageEmbedAncestryProvider({
  sourcePageId,
  hostPageId,
  children,
}: {
  sourcePageId?: string | null;
  hostPageId?: string | null;
  children: React.ReactNode;
}) {
  const parent = useContext(PageEmbedAncestryContext);
  const value = useMemo<AncestryValue>(() => {
    const nextHost = parent.hostPageId ?? hostPageId ?? null;
    if (!sourcePageId) {
      return { chain: parent.chain, hostPageId: nextHost };
    }
    return {
      chain: [...parent.chain, sourcePageId],
      hostPageId: nextHost,
    };
  }, [parent, sourcePageId, hostPageId]);

  return (
    <PageEmbedAncestryContext.Provider value={value}>
      {children}
    </PageEmbedAncestryContext.Provider>
  );
}

export function usePageEmbedAncestry() {
  return useContext(PageEmbedAncestryContext);
}
