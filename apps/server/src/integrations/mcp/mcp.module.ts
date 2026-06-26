import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';
import { DatabaseModule } from '@docmost/db/database.module';
import { EnvironmentModule } from '../environment/environment.module';
import { AuthModule } from '../../core/auth/auth.module';
import { TokenModule } from '../../core/auth/token.module';

// Community MCP feature: the server itself serves the Model Context Protocol
// over HTTP at /mcp. DatabaseModule (global) provides WorkspaceRepo and
// EnvironmentModule (global) provides EnvironmentService. AuthModule supplies
// AuthService (per-user HTTP-Basic login validation) and TokenModule supplies
// TokenService (Bearer access-JWT verification for the token fallback).
@Module({
  imports: [DatabaseModule, EnvironmentModule, AuthModule, TokenModule],
  controllers: [McpController],
  providers: [McpService],
})
export class McpModule {}
