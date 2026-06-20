import { PAGE_EMBED_MAX_DEPTH } from "./page-embed-ancestry-context";
import type { PageTemplateLookup } from "@/features/page-embed/types/page-embed.types";

/**
 * The render outcome of a single pageEmbed node, decided BEFORE rendering a
 * nested editor. Kept pure (no React) so the cycle / depth / access / not-found
 * branch logic is unit-testable in isolation; the node view maps each outcome
 * to a placeholder or the embedded content.
 */
export type EmbedState =
  | "no_source" // no sourcePageId picked yet
  | "cycle" // self-embed or an ancestor already shows this page
  | "too_deep" // nesting depth limit reached
  | "unavailable" // no lookup context (e.g. public share)
  | "loading" // context present, result not back yet
  | "ok" // resolved template content to render
  | "no_access" // server says the viewer can't see the page
  | "not_found"; // server says the page no longer exists

export interface DecideEmbedStateInput {
  sourcePageId: string | null;
  /** sourcePageIds of every ancestor pageEmbed up the render tree. */
  chain: string[];
  /** Host page id; a top-level self-embed must be caught against it. */
  hostPageId: string | null;
  /** Whether a lookup context is mounted (false on public shares in MVP). */
  available: boolean;
  /** The lookup result, or null while still loading. */
  result: PageTemplateLookup | null;
}

/**
 * Decide what a pageEmbed should render. The order matters: cycle and depth
 * guards run first (before any lookup is even consulted), then availability,
 * then the resolved result. Mirrors the branch ladder in PageEmbedBody.
 */
export function decideEmbedState({
  sourcePageId,
  chain,
  hostPageId,
  available,
  result,
}: DecideEmbedStateInput): EmbedState {
  if (!sourcePageId) return "no_source";

  // Self-embed or a source already present in the ancestor chain → cycle.
  const isCycle = chain.includes(sourcePageId) || hostPageId === sourcePageId;
  if (isCycle) return "cycle";

  if (chain.length >= PAGE_EMBED_MAX_DEPTH) return "too_deep";

  if (!available) return "unavailable";
  if (!result) return "loading";

  if (!("status" in result)) return "ok";
  if (result.status === "no_access") return "no_access";
  return "not_found";
}
