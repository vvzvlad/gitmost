import type {
  IAiRole,
  IAiRoleCatalogRole,
} from "@/features/ai-chat/types/ai-chat.types.ts";
import { catalogRoleInstallState } from "@/features/ai-chat/utils/catalog-role-install-state.ts";

/**
 * The redesigned catalog modal renders bundles as cards with a summary status
 * (readable without expanding) and a single primary action. The per-role and
 * per-bundle view model that drives that UI is derived here as PURE functions so
 * the mapping, the "installed in another language" hint, and the bundle-phase
 * computation are unit-testable without mounting the component (mirrors the
 * `catalogRoleInstallState` precedent).
 */

/**
 * A role's status in the catalog view model.
 *  - `import`    — not installed in the current content language.
 *  - `installed` — installed and up to date.
 *  - `update`    — installed, but the catalog ships a newer version.
 *  - `skipped`   — TRANSIENT client-only status set after a conflicted import
 *                  (a name collision under `conflict:'skip'`); never from the
 *                  backend.
 */
export type RoleStatus = "import" | "installed" | "update" | "skipped";

/** A catalog role mapped into the modal's view model. */
export interface CatalogViewRole {
  // Slug is the stable identity within a bundle; used as the row key and as the
  // `slugs[]` payload for import.
  slug: string;
  // Optional in the catalog — the row reserves space and renders nothing when
  // absent.
  emoji?: string;
  name: string;
  description: string;
  // For `installed`/`import`: the catalog version. For `update`: the installed
  // (from) version, with `newVersion` holding the catalog (to) version.
  version: number;
  newVersion?: number;
  status: RoleStatus;
  // The language a same-slug role is installed under, when it differs from the
  // current content language (drives the Р5 hint). Only set for `import` roles.
  installedLang?: string;
  // The workspace role id, present for `installed`/`update` — needed to call the
  // update-from-catalog mutation.
  installedRoleId?: string;
}

/**
 * The summary phase of a bundle, derived from its roles' statuses. Determines
 * the collapsed-header summary and the bundle's single primary action.
 *  - `empty`        — the bundle has no roles.
 *  - `allNew`       — everything is importable, nothing installed.
 *  - `allInstalled` — everything installed & up to date; nothing else pending.
 *  - `updates`      — updates available and nothing left to import.
 *  - `mixed`        — any other combination.
 */
export type BundlePhase =
  | "empty"
  | "allNew"
  | "allInstalled"
  | "updates"
  | "mixed";

/** Per-status tallies for a bundle's roles (the single source of truth). */
export interface BundleCounts {
  importable: number;
  installed: number;
  update: number;
  skipped: number;
}

/**
 * Count a bundle's roles by status ONCE. Both `bundlePhase` and the panel derive
 * from this, so the tally logic lives in exactly one place (no rescans / drift).
 */
export function bundleCounts(roles: CatalogViewRole[]): BundleCounts {
  const counts: BundleCounts = {
    importable: 0,
    installed: 0,
    update: 0,
    skipped: 0,
  };
  for (const r of roles) {
    if (r.status === "import") counts.importable += 1;
    else if (r.status === "installed") counts.installed += 1;
    else if (r.status === "update") counts.update += 1;
    else if (r.status === "skipped") counts.skipped += 1;
  }
  return counts;
}

export function bundlePhase(roles: CatalogViewRole[]): BundlePhase {
  if (roles.length === 0) return "empty";
  const { importable, installed, update, skipped } = bundleCounts(roles);
  // A `skipped` role is a pending post-import conflict (0 installed for it), so a
  // bundle that has ANY skipped role is NOT "all installed & up to date" — that
  // would make the collapsed green "up to date" header contradict the open
  // panel's "Installed 0 · 1 skipped" plaque. It is `mixed` until resolved.
  if (importable === 0 && update === 0 && skipped === 0) return "allInstalled";
  if (update > 0 && importable === 0 && skipped === 0) return "updates";
  if (importable > 0 && installed === 0 && update === 0 && skipped === 0)
    return "allNew";
  return "mixed";
}

/**
 * The subset of a skip result that should be shown as a TRANSIENT `skipped`
 * overlay in the bundle (so the row offers a re-import path). Only NAME-CONFLICT
 * skips qualify: an `already-installed` skip (a concurrent-import race) has
 * nothing to act on — re-importing the same slug would just skip again — so it
 * must NOT be overlaid (else the row shows a misleading "Rename & install" that
 * self-heals into a false "installed"). Pure so both reason branches are tested.
 */
export function nameConflictSlugs(
  skipped: { slug: string; reason: "name-conflict" | "already-installed" }[],
): string[] {
  return skipped
    .filter((s) => s.reason === "name-conflict")
    .map((s) => s.slug);
}

/**
 * Whether a partial-import result should offer the "Rename & install" action:
 * only when at least one skip is a name conflict (renameable). An
 * `already-installed`-only partial is informational.
 */
export function partialOffersRename(
  skipped: { reason: "name-conflict" | "already-installed" }[],
): boolean {
  return skipped.some((s) => s.reason === "name-conflict");
}

/**
 * For a role NOT installed in the current `language`, find a workspace role with
 * the same catalog `slug` installed under a DIFFERENT language, and return that
 * language. Drives the "installed in another language" hint (Р5): a different
 * language of the same slug is a separate install and appears as `import`.
 */
export function installedLangForRole(
  slug: string,
  workspaceRoles: IAiRole[],
  language: string,
): string | undefined {
  const other = workspaceRoles.find(
    (r) =>
      r.source?.slug === slug &&
      !!r.source?.language &&
      r.source.language !== language,
  );
  return other?.source?.language;
}

/**
 * Map one catalog role to the view model, computing its install status against
 * the workspace roles (via `catalogRoleInstallState`) and, for importable roles,
 * the other-language hint.
 */
export function mapCatalogRoleToView(
  role: IAiRoleCatalogRole,
  workspaceRoles: IAiRole[],
  language: string,
): CatalogViewRole {
  const state = catalogRoleInstallState(role, workspaceRoles, language);
  const base = {
    slug: role.slug,
    emoji: role.emoji ?? undefined,
    name: role.name,
    description: role.description ?? "",
  };
  if (state.state === "update") {
    return {
      ...base,
      status: "update",
      version: state.fromVersion,
      newVersion: state.toVersion,
      installedRoleId: state.installed.id,
    };
  }
  if (state.state === "installed") {
    return {
      ...base,
      status: "installed",
      version: role.version,
      installedRoleId: state.installed.id,
    };
  }
  return {
    ...base,
    status: "import",
    version: role.version,
    installedLang: installedLangForRole(role.slug, workspaceRoles, language),
  };
}

/**
 * Map a whole bundle's catalog roles to the view model, preserving order.
 */
export function mapBundleRolesToView(
  roles: IAiRoleCatalogRole[],
  workspaceRoles: IAiRole[],
  language: string,
): CatalogViewRole[] {
  return roles.map((r) => mapCatalogRoleToView(r, workspaceRoles, language));
}
