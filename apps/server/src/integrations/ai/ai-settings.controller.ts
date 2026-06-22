import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import WorkspaceAbilityFactory from '../../core/casl/abilities/workspace-ability.factory';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../../core/casl/interfaces/workspace-ability.type';
import { AiService } from './ai.service';
import { AiSettingsService } from './ai-settings.service';
import { UpdateAiSettingsDto } from './dto/update-ai-settings.dto';
import { TestAiConnectionDto } from './dto/test-ai-connection.dto';

/**
 * Admin-only AI provider settings (§6.4). Routes are POST to match the rest of
 * this codebase (it uses POST for reads too). Access is gated by the workspace
 * admin ability — the same gate as `POST /workspace/update`. No endpoint here
 * ever returns the API key (only `hasApiKey`).
 */
@UseGuards(JwtAuthGuard)
@Controller('workspace/ai-settings')
export class AiSettingsController {
  constructor(
    private readonly aiService: AiService,
    private readonly aiSettingsService: AiSettingsService,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
  ) {}

  private assertAdmin(user: User, workspace: Workspace) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings)
    ) {
      throw new ForbiddenException();
    }
  }

  @HttpCode(HttpStatus.OK)
  @Post()
  async getSettings(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertAdmin(user, workspace);
    return this.aiSettingsService.getMasked(workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  async updateSettings(
    @Body() dto: UpdateAiSettingsDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertAdmin(user, workspace);
    // Returns masked settings only — never the key.
    return this.aiSettingsService.update(workspace.id, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('test')
  async testConnection(
    @Body() dto: TestAiConnectionDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertAdmin(user, workspace);
    return this.aiService.testConnection(workspace.id, dto.capability);
  }

  @HttpCode(HttpStatus.OK)
  @Post('reindex')
  async reindex(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertAdmin(user, workspace);
    await this.aiSettingsService.reindex(workspace.id);
    // Indexing runs as an async background job, so these masked settings carry
    // the PRE-job counts (the indexed total has not climbed yet). The client
    // polls this endpoint's GET counterpart to watch the counter advance.
    return this.aiSettingsService.getMasked(workspace.id);
  }
}
