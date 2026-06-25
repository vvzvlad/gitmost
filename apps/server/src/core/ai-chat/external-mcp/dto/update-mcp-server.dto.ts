import {
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { MCP_TRANSPORTS, McpTransport } from './create-mcp-server.dto';

/**
 * Admin update payload for an external MCP server (§7.3). Every field is
 * optional (partial update).
 *
 * `headers` write-only semantics (§8.10):
 *  - absent          -> auth headers left unchanged;
 *  - {} (empty)      -> auth headers cleared;
 *  - non-empty value -> auth headers re-encrypted and replaced.
 * The headers are NEVER returned by any endpoint.
 */
export class UpdateMcpServerDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsIn(MCP_TRANSPORTS)
  transport?: McpTransport;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  url?: string;

  @IsOptional()
  @IsObject()
  headers?: Record<string, string>;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  toolAllowlist?: string[];

  // Admin-authored prompt guidance (#180). Absent => unchanged; blank => cleared
  // (stored as null by the repo). Capped to bound prompt/token size.
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  instructions?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
