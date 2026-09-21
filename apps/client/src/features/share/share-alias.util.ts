/**
 * Client copy of the vanity share-alias helpers. Kept in sync with the server
 * (`apps/server/src/core/share/share-alias.util.ts`) so live input feedback
 * matches what the server will store/accept. ASCII-only, lowercase, hyphen
 * separated, length 2..60.
 */

// Normalize a user-provided vanity alias into canonical ASCII storage form.
export function normalizeShareAlias(raw: string): string {
  return (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

const ALIAS_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function isValidShareAlias(alias: string): boolean {
  return (
    typeof alias === "string" &&
    alias.length >= 2 &&
    alias.length <= 60 &&
    ALIAS_RE.test(alias)
  );
}
