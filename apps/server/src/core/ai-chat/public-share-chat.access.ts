/**
 * Pure access-control derivation for the anonymous public-share assistant.
 *
 * Extracted (mirroring `evaluateShareAssistantFunnel`) so the real access-control
 * JOIN POINT — "does this (shareId, pageId) pair actually resolve to a usable,
 * non-restricted page inside THIS share?" — is unit-testable without the full
 * Nest/DB graph. The controller performs the async lookups (getShareForPage,
 * isSharingAllowed, page resolution, hasRestrictedAncestor) and feeds the
 * resolved FACTS here; this function holds the security-relevant combination
 * logic so it can be exercised directly against the red-team boundaries
 * (cross-share id swap, restricted descendant, out-of-tree page).
 *
 * Behavior is IDENTICAL to the inlined controller logic it replaces:
 *   shareUsable = resolvedShare matches the requested shareId AND sharing allowed
 *   pageInShare = shareUsable AND the opened page has NO restricted ancestor
 *                 (an unresolvable opened page fails closed -> restricted=true)
 */

export interface ShareAccessFacts {
  /**
   * The id of the share that `getShareForPage(pageId, workspaceId)` resolved to,
   * or null/undefined when the page is not publicly reachable in this workspace.
   * Server-derived; never the attacker's `body.shareId`.
   */
  resolvedShareId: string | null | undefined;
  /** The `shareId` the client claims it is chatting about (attacker-controlled). */
  requestedShareId: string;
  /**
   * Whether sharing is currently allowed for the resolved share's space
   * (workspace/space-level share toggle). Only meaningful when the share
   * resolved; pass false when it did not.
   */
  sharingAllowed: boolean;
  /**
   * Whether the opened page has a restricted ancestor (hidden from the public
   * view). Resolve the opened pageId to its UUID first; an UNRESOLVABLE opened
   * page MUST be passed as `true` (fail closed) so it is graded not-in-share.
   */
  restricted: boolean;
}

export interface ShareAccessDecision {
  /**
   * A share was found AND it is the one the client asked for AND sharing is
   * allowed. Feeds the funnel's `shareUsable` gate.
   */
  shareUsable: boolean;
  /**
   * The opened page resolves to THIS share AND has no restricted ancestor.
   * Feeds the funnel's `pageInShare` gate. A restricted descendant grades to
   * false so it returns the SAME 404 as an out-of-tree page (no existence leak).
   */
  pageInShare: boolean;
}

/**
 * Derive the share/page access decision from server-resolved facts. Pure: no
 * I/O, no Nest, no DB — just the membership + restricted-gate combination.
 *
 * Critically, `requestedShareId` (attacker-controlled) is only ever compared for
 * EQUALITY against the server-resolved `resolvedShareId`; it can never widen
 * access. A mismatch (cross-share id swap) yields shareUsable=false.
 */
export function deriveShareAccess(facts: ShareAccessFacts): ShareAccessDecision {
  const shareResolved =
    !!facts.resolvedShareId && facts.resolvedShareId === facts.requestedShareId;
  const shareUsable = shareResolved && facts.sharingAllowed;
  const pageInShare = shareUsable && !facts.restricted;
  return { shareUsable, pageInShare };
}
