/**
 * Catalog wire shapes. The catalog is curated, untrusted JSON (a GitHub repo or
 * a local folder), so every shape is validated by a hand-written type guard in
 * the provider before any field is used — no zod / new deps on the server.
 *
 * Localized fields (`name` / `description` at the bundle level) are
 * `Record<language, string>` so one bundle serves many UI languages; per-role
 * `name` / `description` are already language-specific (the bundle file is keyed
 * by language).
 */

/** One role's content as shipped in a per-language bundle file. */
export interface CatalogRole {
  slug: string;
  emoji?: string;
  name: string;
  description?: string;
  instructions: string;
  autoStart?: boolean;
  launchMessage?: string | null;
  // Optional model override; same loose object shape as ai_agent_roles.model_config.
  modelConfig?: Record<string, unknown> | null;
}

/** A single language file: `bundles/<id>/<language>.json`. */
export interface CatalogBundleFile {
  schemaVersion: number;
  language: string;
  roles: CatalogRole[];
}

/** Bundle metadata as listed in the top-level index. Versions live here (per
 *  slug), so an UPDATE check needs only the index, not every language file. */
export interface CatalogBundleMeta {
  id: string;
  // Localized display name/description: { en: '...', ru: '...' }.
  name: Record<string, string>;
  description?: Record<string, string>;
  languages: string[];
  roles: { slug: string; version: number }[];
}

/** Top-level catalog index: `index.json`. */
export interface CatalogIndex {
  schemaVersion: number;
  bundles: CatalogBundleMeta[];
}
