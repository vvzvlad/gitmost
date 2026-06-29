import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';
import { DatabaseModule } from '@docmost/db/database.module';
import { AuthModule } from '../../core/auth/auth.module';
import { TokenModule } from '../../core/auth/token.module';

// Community MCP feature: the server itself serves the Model Context Protocol
// over HTTP at /mcp. DatabaseModule (global) provides WorkspaceRepo. AuthModule
// supplies AuthService (per-user HTTP-Basic login validation) and TokenModule
// supplies TokenService (Bearer access-JWT verification for the token fallback).
@Module({
  imports: [DatabaseModule, AuthModule, TokenModule],
  controllers: [McpController],
  providers: [McpService],
})
export class McpModule {}
