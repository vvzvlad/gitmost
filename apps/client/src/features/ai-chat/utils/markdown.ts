import { markdownToHtml } from "@docmost/editor-ext";
import DOMPurify from "dompurify";

export interface RenderChatMarkdownOptions {
  /**
   * Neutralize INTERNAL links so they render as inert text (no `href`/`target`).
   * Used by the anonymous public share: the assistant's answer can contain
   * relative app links (e.g. `[page](/p/{uuid})`, `[settings](/settings/members)`)
   * that would otherwise become clickable `<a href="/p/...">`, leaking internal
   * UUIDs/structure and pointing at auth-gated routes. An anonymous reader can
   * still follow genuinely EXTERNAL `http(s)` links (a DIFFERENT host than the
   * app's own origin), so those are kept (with a safe `rel`/`target`); absolute
   * links back to our OWN origin (e.g. `https://self/p/{uuid}`) are internal and
   * neutralized too. Defaults to false — the internal chat keeps internal links
   * clickable for authenticated users.
   */
  neutralizeInternalLinks?: boolean;
}

/**
 * Whether `href` points at an EXTERNAL absolute URL we are happy for an
 * anonymous reader to follow. A link qualifies only if it is absolute
 * `http(s)://` AND its host differs from the app's own origin
 * (`window.location.host`): absolute links back to our OWN host (e.g.
 * `https://self/p/{uuid}`) are internal and must be neutralized, exactly like
 * relative `/p/...` links. Everything else (relative `/...`, bare fragments
 * `#...`, protocol-relative `//...`, other schemes, or anything that does not
 * parse) is treated as internal/unsafe and neutralized — fail closed.
 */
function isExternalHttpUrl(href: string): boolean {
  const value = href.trim();
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    // External only if it points at a DIFFERENT host than the app's own origin.
    // Absolute links back to our own host (e.g. https://self/p/{uuid}) are
    // internal and must be neutralized, same as relative `/p/...` links.
    return new URL(value).host !== window.location.host;
  } catch {
    return false; // unparseable -> treat as internal/unsafe, neutralize
  }
}

/**
 * DOMPurify `afterSanitizeAttributes` hook that neutralizes internal links.
 * Hooks are GLOBAL on the DOMPurify instance, so this is only ever registered
 * for the duration of a single sanitize call (added then removed in
 * `renderChatMarkdown`) — it must never leak into the internal chat's renders.
 */
function neutralizeInternalLinksHook(node: Element): void {
  if (node.nodeName !== "A") return;
  const href = node.getAttribute("href");
  if (href !== null && isExternalHttpUrl(href)) {
    // Genuinely external link: keep it, but force a safe rel/target.
    node.setAttribute("rel", "noopener noreferrer nofollow");
    node.setAttribute("target", "_blank");
    return;
  }
  // Internal/relative/fragment link (or no href): make it inert text. Drop the
  // href and any target so it is no longer clickable; the visible text stays.
  node.removeAttribute("href");
  node.removeAttribute("target");
}

/**
 * Render AI markdown to sanitized HTML for read-only display. We reuse the
 * app's `markdownToHtml` (the same `marked` pipeline used for paste/import) so
 * chat output matches the editor's markdown flavor, then sanitize with
 * DOMPurify — LLM output is untrusted, so it must never reach the DOM unsanitized.
 *
 * `markdownToHtml` can return `string | Promise<string>` (it has async marked
 * extensions registered). In practice plain chat markdown resolves
 * synchronously, but we guard the Promise case by returning a safe empty string
 * for that branch (the caller renders the raw text fallback instead).
 */
export function renderChatMarkdown(
  markdown: string,
  options: RenderChatMarkdownOptions = {},
): string {
  if (!markdown) return "";
  const html = markdownToHtml(markdown);
  if (typeof html !== "string") return "";

  if (!options.neutralizeInternalLinks) {
    // Internal chat: unchanged behavior, no hook registered.
    return DOMPurify.sanitize(html);
  }

  // Public share: register the neutralization hook only for THIS sanitize call,
  // then remove it immediately so it can never affect the internal chat (hooks
  // are global on the shared DOMPurify instance).
  DOMPurify.addHook("afterSanitizeAttributes", neutralizeInternalLinksHook);
  try {
    return DOMPurify.sanitize(html);
  } finally {
    // Remove by reference (not a bare pop) so we only ever remove OUR hook,
    // robust to any other afterSanitizeAttributes hook registered in future.
    DOMPurify.removeHook(
      "afterSanitizeAttributes",
      neutralizeInternalLinksHook,
    );
  }
}
