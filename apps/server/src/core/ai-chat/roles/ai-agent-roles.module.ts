import { Module } from '@nestjs/common';
import { AiAgentRolesController } from './ai-agent-roles.controller';
import { AiAgentRolesService } from './ai-agent-roles.service';

/**
 * Agent roles unit (v1). Admin CRUD + member-visible listing for the chat
 * role picker. AiAgentRoleRepo (DatabaseModule, global) and
 * WorkspaceAbilityFactory (CaslModule, global) are resolved without explicit
 * imports. The stream-time role resolution + model override live in
 * AiChatService / AiService; this module only hosts the management API.
 */
@Module({
  controllers: [AiAgentRolesController],
  providers: [AiAgentRolesService],
})
export class AiAgentRolesModule {}
