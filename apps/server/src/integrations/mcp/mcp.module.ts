import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';
import { DatabaseModule } from '@docmost/db/database.module';
import { TokenModule } from '../../core/auth/token.module';
import { ApiKeyModule } from '../../core/api-key/api-key.module';

// Community MCP feature: the server itself serves the Model Context Protocol
// over HTTP at /mcp. An agent authenticates EXCLUSIVELY with a Bearer api_key.
// DatabaseModule (global) provides WorkspaceRepo. TokenModule supplies
// TokenService (Bearer JWT verification). ApiKeyModule supplies ApiKeyService
// (the shared api-key row-check for the API_KEY Bearer branch).
@Module({
  imports: [DatabaseModule, TokenModule, ApiKeyModule],
  controllers: [McpController],
  providers: [McpService],
})
export class McpModule {}
