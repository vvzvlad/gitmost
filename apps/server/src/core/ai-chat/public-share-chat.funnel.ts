/**
 * Pure guardrail-funnel decision for the anonymous public-share assistant.
 *
 * Extracted so the ORDER of the checks (which is security-relevant — each
 * failure must exit before any streaming begins, and the codes are chosen so
 * the feature/share existence is never revealed) can be unit-tested without the
 * heavy Nest/DB graph. The controller resolves the inputs (toggle on?, share
 * found?, page in tree?) asynchronously and feeds the booleans here.
 *
 * Funnel (order matters; first failing condition wins):
 *  1. workspace toggle off                  -> 404 (don't reveal the feature)
 *  2. share not found / wrong ws / disabled -> 404 (indistinguishable)
 *  3. pageId not in the share tree          -> 404 (don't confirm private page)
 *  4. AI provider not configured            -> 503 (config, not access)
 *  (Anti-abuse 429s bracket this pure decision: the per-IP rate limit is
 *   enforced by the ThrottlerGuard BEFORE this funnel, and an IP-independent
 *   per-workspace cap is enforced by the controller AFTER it passes — both
 *   surface as 429 and neither changes the access-shaped 404/503 grading here.)
 */

export type FunnelOutcome =
  | { ok: true }
  | { ok: false; status: 404 | 503; reason: string };

export interface FunnelInput {
  /** settings.ai.publicShareAssistant === true */
  assistantEnabled: boolean;
  /** A share was found AND its workspace matches AND sharing is allowed. */
  shareUsable: boolean;
  /** getShareForPage(pageId, workspaceId) resolved to THIS share. */
  pageInShare: boolean;
  /** A chat model could be resolved (provider configured). */
  providerConfigured: boolean;
}

export function evaluateShareAssistantFunnel(
  input: FunnelInput,
): FunnelOutcome {
  if (!input.assistantEnabled) {
    // 404: do not reveal that the assistant feature exists at all.
    return { ok: false, status: 404, reason: 'assistant-disabled' };
  }
  if (!input.shareUsable) {
    // 404: indistinguishable from "no such share".
    return { ok: false, status: 404, reason: 'share-not-found' };
  }
  if (!input.pageInShare) {
    // 404: do not confirm a private/other page exists.
    return { ok: false, status: 404, reason: 'page-not-in-share' };
  }
  if (!input.providerConfigured) {
    // 503: configuration problem, not an access decision.
    return { ok: false, status: 503, reason: 'provider-not-configured' };
  }
  return { ok: true };
}
