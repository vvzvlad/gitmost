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
import { McpServersService } from './mcp-servers.service';
import { CreateMcpServerDto } from './dto/create-mcp-server.dto';
import { UpdateMcpServerDto } from './dto/update-mcp-server.dto';

/** Path param for the per-server routes (update/delete/test). */
class McpServerIdDto {
  @IsString()
  id: string;
}

/**
 * Admin-only external MCP server management (§7.3 / E3 backend). Routes are POST
 * to match this codebase's convention (it uses POST for reads too). Access is
 * gated by the workspace admin ability — the same gate as `POST /workspace/
 * update` and the AI provider settings. SECURITY (§8.10): no route ever returns
 * the encrypted auth headers; the list/create/update views carry only
 * `hasHeaders`.
 */
@UseGuards(JwtAuthGuard)
@Controller('workspace/ai-mcp-servers')
export class McpServersController {
  constructor(
    private readonly mcpServersService: McpServersService,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
  ) {}

  private assertAdmin(user: User, workspace: Workspace): void {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings)
    ) {
      throw new ForbiddenException();
    }
  }

  @HttpCode(HttpStatus.OK)
  @Post()
  async list(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertAdmin(user, workspace);
    return this.mcpServersService.list(workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('create')
  async create(
    @Body() dto: CreateMcpServerDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertAdmin(user, workspace);
    return this.mcpServersService.create(workspace.id, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  async update(
    @Body() idDto: McpServerIdDto,
    @Body() dto: UpdateMcpServerDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertAdmin(user, workspace);
    return this.mcpServersService.update(workspace.id, idDto.id, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('delete')
  async remove(
    @Body() idDto: McpServerIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertAdmin(user, workspace);
    return this.mcpServersService.remove(workspace.id, idDto.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('test')
  async test(
    @Body() idDto: McpServerIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertAdmin(user, workspace);
    return this.mcpServersService.test(workspace.id, idDto.id);
  }
}
