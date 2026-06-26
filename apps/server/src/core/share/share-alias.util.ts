/**
 * Vanity share-alias helpers shared by the write path (set/availability) and the
 * `/l/:alias` resolve path. Aliases are ASCII-only, lowercase, hyphen-separated
 * slugs — deliberately no Cyrillic / transliteration: the user types the exact
 * canonical form. Keep this in sync with the client copy in
 * `apps/client/src/features/share/share-alias.util.ts`.
 */

// Normalize a user-provided vanity alias into canonical ASCII storage form.
// This only canonicalizes shape (case, separators); it does NOT enforce the
// charset — call isValidShareAlias afterwards to reject anything illegal.
export function normalizeShareAlias(raw: string): string {
  return (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-') // spaces/underscores -> single hyphen
    .replace(/-{2,}/g, '-') // collapse repeated hyphens
    .replace(/^-+|-+$/g, ''); // trim leading/trailing hyphens
}

// ASCII only: lowercase letters/digits in hyphen-separated groups, length 2..60.
const ALIAS_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function isValidShareAlias(alias: string): boolean {
  return (
    typeof alias === 'string' &&
    alias.length >= 2 &&
    alias.length <= 60 &&
    ALIAS_RE.test(alias)
  );
}
