import { Module } from '@nestjs/common';
import { CryptoModule } from '../../../integrations/crypto/crypto.module';
import { McpClientsService } from './mcp-clients.service';
import { McpServersService } from './mcp-servers.service';
import { McpServersController } from './mcp-servers.controller';

/**
 * External MCP servers unit (§6.8 / E1-E3). Lets the agent use admin-configured
 * external MCP servers (e.g. Tavily web search); gitmost is the MCP CLIENT.
 *
 * CryptoModule supplies SecretBoxService for the encrypted auth headers.
 * AiMcpServerRepo (DatabaseModule, global) and WorkspaceAbilityFactory
 * (CaslModule, global) are resolved without explicit imports. McpClientsService
 * is exported so the agent loop can merge external tools into the toolset.
 */
@Module({
  imports: [CryptoModule],
  controllers: [McpServersController],
  providers: [McpClientsService, McpServersService],
  exports: [McpClientsService],
})
export class ExternalMcpModule {}
