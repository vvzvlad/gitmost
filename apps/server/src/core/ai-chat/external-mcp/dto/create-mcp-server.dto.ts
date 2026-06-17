import {
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** Allowed external MCP transports (the @ai-sdk/mcp http/sse transports). */
export const MCP_TRANSPORTS = ['http', 'sse'] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

/**
 * Admin create payload for an external MCP server (§7.3).
 *
 * `headers` is write-only (§8.10): the auth headers (e.g. the Tavily API key)
 * are encrypted at rest and NEVER returned. The global ValidationPipe runs with
 * `whitelist: true`, so unknown fields are stripped.
 */
export class CreateMcpServerDto {
  @IsString()
  @MaxLength(200)
  name: string;

  @IsIn(MCP_TRANSPORTS)
  transport: McpTransport;

  @IsString()
  @MaxLength(2048)
  url: string;

  // Auth headers map (e.g. { Authorization: 'Bearer ...' }). Encrypted on save;
  // never returned. Omitted on create => no auth headers.
  @IsOptional()
  @IsObject()
  headers?: Record<string, string>;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  toolAllowlist?: string[];

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
