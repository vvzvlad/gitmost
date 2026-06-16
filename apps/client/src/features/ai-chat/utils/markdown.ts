import { markdownToHtml } from "@docmost/editor-ext";
import DOMPurify from "dompurify";

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
export function renderChatMarkdown(markdown: string): string {
  if (!markdown) return "";
  const html = markdownToHtml(markdown);
  if (typeof html !== "string") return "";
  return DOMPurify.sanitize(html);
}
