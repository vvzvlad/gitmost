import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import { FastifyRequest, FastifyReply } from 'fastify';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { Workspace } from '@docmost/db/types/entity.types';
import { withCache } from '../helpers/with-cache';
import { CacheKey, WORKSPACE_CACHE_TTL_MS } from '../helpers/cache-keys';

// #348 — timestamptz columns on the workspace row. The cache store (Keyv/Redis)
// JSON-serializes values, so a cached workspace comes back with these fields as
// ISO strings. Reviving them to Date keeps the cached path byte-identical to the
// direct DB path (postgres.js returns Date), so nothing downstream can observe a
// cache hit vs miss. Idempotent: `new Date(date)` on an already-Date value is a
// no-op-equivalent. Keep in sync with the workspace timestamptz columns.
const WORKSPACE_DATE_FIELDS: Array<keyof Workspace> = [
  'createdAt',
  'updatedAt',
  'deletedAt',
  'trialEndAt',
];

function reviveWorkspaceDates(workspace: Workspace): Workspace {
  for (const field of WORKSPACE_DATE_FIELDS) {
    const value = workspace[field];
    if (value != null) {
      (workspace as any)[field] = new Date(value as any);
    }
  }
  return workspace;
}

@Injectable()
export class DomainMiddleware implements NestMiddleware {
  constructor(
    private workspaceRepo: WorkspaceRepo,
    private environmentService: EnvironmentService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}
  async use(
    req: FastifyRequest['raw'],
    res: FastifyReply['raw'],
    next: () => void,
  ) {
    if (this.environmentService.isSelfHosted()) {
      // #348 — cache the single-workspace lookup that runs on every request.
      // Invalidated by every WorkspaceRepo mutator (see bustWorkspaceCache).
      const workspace = await withCache(
        this.cacheManager,
        CacheKey.WORKSPACE_SELF_HOSTED,
        WORKSPACE_CACHE_TTL_MS,
        () => this.workspaceRepo.findFirst(),
      );
      if (!workspace) {
        //throw new NotFoundException('Workspace not found');
        (req as any).workspaceId = null;
        return next();
      }

      reviveWorkspaceDates(workspace);
      // TODO: unify
      (req as any).workspaceId = workspace.id;
      (req as any).workspace = workspace;
    } else if (this.environmentService.isCloud()) {
      const header = req.headers.host;
      const subdomain = header.split('.')[0];

      // #348 — cache per-subdomain workspace resolution. Keyed by subdomain (the
      // hostname column); busted per hostname by every WorkspaceRepo mutator.
      const workspace = await withCache(
        this.cacheManager,
        CacheKey.WORKSPACE_BY_HOST(subdomain),
        WORKSPACE_CACHE_TTL_MS,
        () => this.workspaceRepo.findByHostname(subdomain),
      );

      if (!workspace) {
        (req as any).workspaceId = null;
        return next();
      }

      reviveWorkspaceDates(workspace);
      (req as any).workspaceId = workspace.id;
      (req as any).workspace = workspace;
    }

    next();
  }
}
