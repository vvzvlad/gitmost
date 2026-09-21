import { Module } from '@nestjs/common';
import { WorkspaceService } from './services/workspace.service';
import { WorkspaceController } from './controllers/workspace.controller';
import { SpaceModule } from '../space/space.module';
import { WorkspaceInvitationService } from './services/workspace-invitation.service';
import { TokenModule } from '../auth/token.module';
// #686: WorkspaceService evicts a deleted user's per-user external-MCP toolset
// cache. ExternalMcpModule exports the shared McpClientsService singleton; it
// only imports CryptoModule, so there is no import cycle back to WorkspaceModule.
import { ExternalMcpModule } from '../ai-chat/external-mcp/external-mcp.module';

@Module({
  imports: [SpaceModule, TokenModule, ExternalMcpModule],
  controllers: [WorkspaceController],
  providers: [WorkspaceService, WorkspaceInvitationService],
  exports: [WorkspaceService],
})
export class WorkspaceModule {}
