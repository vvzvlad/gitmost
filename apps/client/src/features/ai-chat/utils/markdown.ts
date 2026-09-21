import {
  markdownToProseMirrorSync,
  docmostExtensions,
} from "@docmost/prosemirror-markdown/browser";
import { getSchema } from "@tiptap/core";
import { Node as PMNode, DOMSerializer } from "@tiptap/pm/model";
import DOMPurify from "dompurify";

// The Docmost editor schema, built once. Chat markdown is rendered through the
// SAME schema the editor/import use (issue #347), so chat output matches how the
// page would render the same markdown.
const chatSchema = getSchema(docmostExtensions);

/**
 * Markdown -> HTML for chat display, via the canonical converter. We serialize
 * the ProseMirror doc with `DOMSerializer` into a real element and read its
 * `innerHTML` (rather than `@tiptap/html`'s `generateHTML`, whose browser path
 * uses `XMLSerializer` and stamps a `xmlns` on every block) so the markup is
 * clean HTML. `li > p` wrapping is inherent to the schema (listItem content is
 * `paragraph+`); the chat CSS zeroes those paragraph margins so lists still
 * render tight.
 */
function markdownToChatHtml(markdown: string): string {
  const doc = markdownToProseMirrorSync(markdown);
  const node = PMNode.fromJSON(chatSchema, doc);
  const div = document.createElement("div");
  DOMSerializer.fromSchema(chatSchema).serializeFragment(
    node.content,
    { document },
    div,
  );
  return div.innerHTML;
}

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
 * canonical converter (issue #347): markdown -> ProseMirror JSON (the SAME
 * `markdownToProseMirrorSync` the editor paste/import path uses, so chat output
 * matches the editor's markdown flavor) -> HTML via `markdownToChatHtml`
 * (DOMSerializer), then sanitize with DOMPurify — LLM output is untrusted, so it
 * must never reach the DOM unsanitized.
 *
 * Stays SYNCHRONOUS: both callers render inside React (a memo and a useMemo),
 * so the whole pipeline must resolve without awaiting. The converter's sync
 * entry makes that possible; on any conversion error we return "" so the caller
 * falls back to raw text (the same fallback the old Promise-guard produced).
 */
export function renderChatMarkdown(
  markdown: string,
  options: RenderChatMarkdownOptions = {},
): string {
  if (!markdown) return "";
  let html: string;
  try {
    // markdown -> canonical PM JSON -> HTML (native DOMParser in the browser;
    // jsdom is never bundled — see @docmost/prosemirror-markdown/browser).
    html = markdownToChatHtml(markdown);
  } catch {
    // Malformed/unsupported markdown must not crash the chat render; fall back
    // to raw text (empty return -> caller shows the plain-text branch).
    return "";
  }

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
