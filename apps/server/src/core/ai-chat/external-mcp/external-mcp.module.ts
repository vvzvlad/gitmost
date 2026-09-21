import { Module } from '@nestjs/common';
import { CryptoModule } from '../../../integrations/crypto/crypto.module';
import { McpClientsService } from './mcp-clients.service';
import { McpServersService } from './mcp-servers.service';
import { McpServersController } from './mcp-servers.controller';
import { AccountMcpServersService } from './account-mcp-servers.service';
import { AccountMcpServersController } from './account-mcp-servers.controller';

/**
 * External MCP servers unit (§6.8 / E1-E3). Lets the agent use admin-configured
 * external MCP servers (e.g. Tavily web search); gitmost is the MCP CLIENT.
 *
 * CryptoModule supplies SecretBoxService for the encrypted auth headers.
 * AiMcpServerRepo (DatabaseModule, global), WorkspaceAbilityFactory (CaslModule,
 * global) and EnvironmentService (EnvironmentModule, global) are resolved
 * without explicit imports. McpClientsService is exported so the agent loop can
 * merge external tools into the toolset.
 *
 * The `Account*` pair (#686) exposes the personal-server CRUD API
 * (`account/mcp-servers`) — no admin gate, owner-scoped, kill-switch guarded.
 */
@Module({
  imports: [CryptoModule],
  controllers: [McpServersController, AccountMcpServersController],
  providers: [McpClientsService, McpServersService, AccountMcpServersService],
  exports: [McpClientsService],
})
export class ExternalMcpModule {}
