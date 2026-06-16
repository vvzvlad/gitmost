import { Controller, Delete, Get, Post, Req, Res } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { McpService } from './mcp.service';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';

// The global prefix in main.ts excludes 'mcp', so these handlers map to /mcp
// (not /api/mcp). The MCP Streamable-HTTP transport uses POST for JSON-RPC
// requests, GET for the SSE stream, and DELETE to terminate a session.
@Controller()
export class McpController {
  constructor(private readonly mcpService: McpService) {}

  @SkipTransform()
  @Post('mcp')
  async post(
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ): Promise<void> {
    await this.mcpService.handle(req, res);
  }

  @SkipTransform()
  @Get('mcp')
  async get(
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ): Promise<void> {
    await this.mcpService.handle(req, res);
  }

  @SkipTransform()
  @Delete('mcp')
  async delete(
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ): Promise<void> {
    await this.mcpService.handle(req, res);
  }
}
