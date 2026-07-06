import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  Get,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { SpaceRepo } from '@docmost/db/repos/space/space.repo';
import WorkspaceAbilityFactory from '../../core/casl/abilities/workspace-ability.factory';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../../core/casl/interfaces/workspace-ability.type';
import { EnvironmentService } from '../environment/environment.service';
import { IsUUID } from 'class-validator';
import {
  GitSyncOrchestrator,
  GitSyncRunStatus,
} from './services/git-sync.orchestrator';

/** Body for the manual one-shot trigger. */
class TriggerGitSyncDto {
  // The global ValidationPipe runs with whitelist:true, which STRIPS any field
  // lacking a validation decorator — without this @IsUUID the spaceId would be
  // dropped and arrive as undefined.
  @IsUUID()
  spaceId: string;
}

/**
 * Ops/testing endpoints for the git-sync control plane. Admin-guarded
 * (workspace Manage/Settings, mirroring WorkspaceController) so only workspace
 * admins can force a cycle. Mounted under the global `/api` prefix:
 *   - POST /api/git-sync/trigger { spaceId } — run one cycle now (await result),
 *   - GET  /api/git-sync/status — report whether sync is enabled + config.
 */
@UseGuards(JwtAuthGuard)
@Controller('git-sync')
export class GitSyncController {
  constructor(
    private readonly orchestrator: GitSyncOrchestrator,
    private readonly environmentService: EnvironmentService,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
    private readonly spaceRepo: SpaceRepo,
  ) {}

  /** Throw unless the caller is a workspace admin (Manage Settings). */
  private assertAdmin(user: User, workspace: Workspace): void {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings)
    ) {
      throw new ForbiddenException();
    }
  }

  @HttpCode(HttpStatus.OK)
  @Post('trigger')
  async trigger(
    @Body() dto: TriggerGitSyncDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ): Promise<GitSyncRunStatus> {
    this.assertAdmin(user, workspace);
    // Verify the client-supplied spaceId BELONGS to this workspace before doing
    // any work (review): without this, `runOnce` -> `buildSettings` reads the
    // raw `spaces` row and creates an empty per-space vault directory for a
    // foreign/non-existent space before the content read finally 404s. Resolve
    // it workspace-scoped and 404 early.
    const space = await this.spaceRepo.findById(dto.spaceId, workspace.id);
    if (!space) {
      throw new NotFoundException('Space not found');
    }
    // Use the workspace from the request context (never client-supplied).
    return this.orchestrator.runOnce(dto.spaceId, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Get('status')
  async status(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ): Promise<{
    enabled: boolean;
    dataDir: string;
    pollIntervalMs: number;
    debounceMs: number;
    serviceUserConfigured: boolean;
  }> {
    this.assertAdmin(user, workspace);
    return {
      enabled: this.environmentService.isGitSyncEnabled(),
      dataDir: this.environmentService.getGitSyncDataDir(),
      pollIntervalMs: this.environmentService.getGitSyncPollIntervalMs(),
      debounceMs: this.environmentService.getGitSyncDebounceMs(),
      serviceUserConfigured: Boolean(
        this.environmentService.getGitSyncServiceUserId(),
      ),
    };
  }
}
