import { IsUUID } from 'class-validator';

/**
 * Path/body param identifying a single MCP server for the per-server routes
 * (update/delete/test). Shared (#686) by the admin controller and the personal
 * `account/mcp-servers` controller so both validate the id the same way.
 *
 * `@IsUUID` (not `@IsString`): the id column is `uuid`, so a non-UUID value would
 * reach the query and make Postgres throw 22P02 -> a bare 500. Validating the
 * shape up front returns a clean 400 instead (loud/specific, invariant #10).
 */
export class McpServerIdDto {
  @IsUUID()
  id: string;
}
