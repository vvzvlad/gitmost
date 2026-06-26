import type {
  IAiRole,
  IAiRoleCatalogRole,
} from "@/features/ai-chat/types/ai-chat.types.ts";

/**
 * The install state of a single catalog role relative to the workspace's
 * existing roles. Extracted as a pure function so the catalog modal's role-state
 * computation is unit-testable without mounting the component (mirrors the
 * `roleLaunchMessage` precedent in role-launch.ts).
 *
 * A catalog role is matched to an installed role by BOTH `source.slug` and
 * `source.language`: the same slug in a different language is a separate install
 * (so it shows as "import", not "installed"). When matched, the installed source
 * version decides the state:
 *   - no match                          -> "import"
 *   - matched & installed version >= catalog version -> "installed"
 *   - matched & installed version <  catalog version -> "update" (from -> to)
 */
export type CatalogRoleInstallState =
  | { state: "import" }
  | { state: "installed"; installed: IAiRole }
  | {
      state: "update";
      installed: IAiRole;
      fromVersion: number;
      toVersion: number;
    };

export function catalogRoleInstallState(
  role: Pick<IAiRoleCatalogRole, "slug" | "version">,
  workspaceRoles: IAiRole[],
  language: string,
): CatalogRoleInstallState {
  const installed = workspaceRoles.find(
    (r) => r.source?.slug === role.slug && r.source?.language === language,
  );
  if (!installed) return { state: "import" };
  const fromVersion = installed.source?.version ?? 0;
  if (fromVersion >= role.version) {
    return { state: "installed", installed };
  }
  return {
    state: "update",
    installed,
    fromVersion,
    toVersion: role.version,
  };
}
