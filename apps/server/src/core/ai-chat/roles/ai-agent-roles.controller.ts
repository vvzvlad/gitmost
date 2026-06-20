import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsString } from 'class-validator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import WorkspaceAbilityFactory from '../../casl/abilities/workspace-ability.factory';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../../casl/interfaces/workspace-ability.type';
import { AiAgentRolesService } from './ai-agent-roles.service';
import {
  CreateAgentRoleDto,
  UpdateAgentRoleDto,
} from './dto/agent-role.dto';

/** Path/body param for the per-role routes (update/delete). */
class AgentRoleIdDto {
  @IsString()
  id: string;
}

/**
 * Agent role management + listing (v1 of the "agent roles" feature). Routes are
 * POST to match this codebase's convention (it uses POST for reads too) and live
 * under /api/ai-chat/roles, next to the chat.
 *
 * Access split (mirrors the AI settings / MCP servers admin gate):
 *  - `list`                     : ANY workspace member (needed for the chat-creation
 *                                 role picker). JwtAuthGuard + AuthWorkspace already
 *                                 establish membership; all reads are workspace-scoped.
 *  - `create` / `update` / `delete` : ADMIN only (Manage Settings ability).
 */
@UseGuards(JwtAuthGuard)
@Controller('ai-chat/roles')
export class AiAgentRolesController {
  constructor(
    private readonly rolesService: AiAgentRolesService,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
  ) {}

  /** Admin gate (same as workspace settings / MCP servers). */
  private assertAdmin(user: User, workspace: Workspace): void {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings)
    ) {
      throw new ForbiddenException();
    }
  }

  /** List roles — available to any workspace member for the chat picker. */
  @HttpCode(HttpStatus.OK)
  @Post()
  async list(@AuthWorkspace() workspace: Workspace) {
    return this.rolesService.list(workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('create')
  async create(
    @Body() dto: CreateAgentRoleDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertAdmin(user, workspace);
    return this.rolesService.create(workspace.id, user.id, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  async update(
    @Body() idDto: AgentRoleIdDto,
    @Body() dto: UpdateAgentRoleDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertAdmin(user, workspace);
    return this.rolesService.update(workspace.id, idDto.id, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('delete')
  async remove(
    @Body() idDto: AgentRoleIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertAdmin(user, workspace);
    return this.rolesService.remove(workspace.id, idDto.id);
  }
}
