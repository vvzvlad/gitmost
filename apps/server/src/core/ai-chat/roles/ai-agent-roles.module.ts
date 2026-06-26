import { Module } from '@nestjs/common';
import { AiAgentRolesController } from './ai-agent-roles.controller';
import { AiAgentRolesService } from './ai-agent-roles.service';
import { AiAgentRolesCatalogProvider } from './catalog/ai-agent-roles-catalog.provider';

/**
 * Agent roles unit (v1). Admin CRUD + member-visible listing for the chat
 * role picker, plus the admin catalog (browse/import/update). AiAgentRoleRepo
 * (DatabaseModule, global), WorkspaceAbilityFactory (CaslModule, global) and
 * EnvironmentService (EnvironmentModule, global — used by the catalog provider)
 * are resolved without explicit imports. The stream-time role resolution +
 * model override live in AiChatService / AiService; this module only hosts the
 * management API.
 */
@Module({
  controllers: [AiAgentRolesController],
  providers: [AiAgentRolesService, AiAgentRolesCatalogProvider],
})
export class AiAgentRolesModule {}
