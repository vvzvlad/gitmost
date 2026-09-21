import { sanitizeUrl as braintreeSanitizeUrl } from "@braintree/sanitize-url";

// Client-local copy of editor-ext's sanitizeUrl wrapper. Importing it from the
// editor-ext barrel dragged the whole TipTap engine into the eager startup graph
// via the app-wide config module (getFileUrl). This keeps the exact same
// behavior (braintree sanitize + normalize "about:blank" -> "") without that
// dependency.
export function sanitizeUrl(url: string | undefined): string {
  if (!url) return "";

  const sanitized = braintreeSanitizeUrl(url);

  // Return an empty string instead of "about:blank".
  return sanitized === "about:blank" ? "" : sanitized;
}
