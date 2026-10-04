import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { Workspace } from '@docmost/db/types/entity.types';
import { EnvironmentService } from '../../integrations/environment/environment.service';

/**
 * The ONE canonical way to resolve the workspace for an incoming request:
 *   - self-hosted (single workspace) -> the first/default workspace;
 *   - cloud (multi-tenant)           -> resolved by the host-header subdomain.
 * Returns null when none resolves (no workspace configured, or a blank/unknown
 * subdomain on cloud). `isSelfHosted()` is `!isCloud()`, so exactly one branch is
 * always taken.
 *
 * Extracted so the self-hosted/cloud branch is not hand-duplicated. Shared by
 * `DomainMiddleware` (the normal /api request path) and `GitHttpService` (the raw
 * root-mounted /git smart-HTTP host, which Nest middleware does NOT run for) so
 * the two cannot drift.
 *
 * This helper does NOT catch DB errors — callers decide: DomainMiddleware lets a
 * throw bubble (as before); GitHttpService wraps it to log + treat as
 * unresolvable (-> 404). A blank/missing host on cloud resolves to null rather
 * than throwing.
 */
export async function resolveRequestWorkspace(
  environmentService: EnvironmentService,
  workspaceRepo: WorkspaceRepo,
  hostHeader: string | undefined,
): Promise<Workspace | null> {
  if (environmentService.isSelfHosted()) {
    return (await workspaceRepo.findFirst()) ?? null;
  }
  // Cloud (isSelfHosted === !isCloud, so this is the only remaining branch).
  const subdomain = hostHeader ? hostHeader.split('.')[0] : '';
  if (!subdomain) return null;
  return (await workspaceRepo.findByHostname(subdomain)) ?? null;
}
