import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';
import { DatabaseModule } from '@docmost/db/database.module';
import { EnvironmentModule } from '../environment/environment.module';

// Community MCP feature: the server itself serves the Model Context Protocol
// over HTTP at /mcp. DatabaseModule (global) provides WorkspaceRepo and
// EnvironmentModule (global) provides EnvironmentService; both are imported
// explicitly for clarity.
@Module({
  imports: [DatabaseModule, EnvironmentModule],
  controllers: [McpController],
  providers: [McpService],
})
export class McpModule {}
