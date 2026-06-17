import { BadRequestException, Injectable } from '@nestjs/common';
import { AiMcpServerRepo } from '@docmost/db/repos/ai-chat/ai-mcp-server.repo';
import { AiMcpServer } from '@docmost/db/types/entity.types';
import { SecretBoxService } from '../../../integrations/crypto/secret-box';
import { McpClientsService } from './mcp-clients.service';
import { isUrlAllowed } from './ssrf-guard';
import { CreateMcpServerDto } from './dto/create-mcp-server.dto';
import { UpdateMcpServerDto } from './dto/update-mcp-server.dto';

/**
 * Public (admin-facing) view of an external MCP server row. SECURITY (§8.10):
 * `headersEnc` is NEVER part of this shape — only `hasHeaders` signals whether
 * auth headers are configured.
 */
export interface McpServerView {
  id: string;
  name: string;
  transport: string;
  url: string;
  enabled: boolean;
  toolAllowlist: string[] | null;
  hasHeaders: boolean;
}

/**
 * Admin business logic for external MCP servers (§7.3): CRUD with write-only
 * encrypted auth headers, SSRF validation on save, and tool-cache invalidation
 * on every mutation.
 */
@Injectable()
export class McpServersService {
  constructor(
    private readonly repo: AiMcpServerRepo,
    private readonly secretBox: SecretBoxService,
    private readonly clients: McpClientsService,
  ) {}

  async list(workspaceId: string): Promise<McpServerView[]> {
    const rows = await this.repo.listByWorkspace(workspaceId);
    return rows.map((r) => this.toView(r));
  }

  async create(
    workspaceId: string,
    dto: CreateMcpServerDto,
  ): Promise<McpServerView> {
    await this.assertUrlAllowed(dto.url);

    // Encrypt the auth headers if any non-empty set was provided.
    const headersEnc = this.encryptHeaders(dto.headers);

    const row = await this.repo.insert({
      workspaceId,
      name: dto.name,
      transport: dto.transport,
      url: dto.url,
      headersEnc,
      toolAllowlist: dto.toolAllowlist ?? null,
      enabled: dto.enabled ?? true,
    });
    this.clients.invalidate(workspaceId);
    return this.toView(row);
  }

  async update(
    workspaceId: string,
    id: string,
    dto: UpdateMcpServerDto,
  ): Promise<McpServerView> {
    const existing = await this.repo.findById(id, workspaceId);
    if (!existing) {
      throw new BadRequestException('MCP server not found');
    }

    // Re-validate the URL whenever it changes (admin-supplied -> SSRF risk).
    if (dto.url !== undefined && dto.url !== existing.url) {
      await this.assertUrlAllowed(dto.url);
    }

    // Header write-only semantics (§8.10):
    //  - absent      -> leave unchanged (headersEnc stays undefined in patch);
    //  - {} empty     -> clear (null);
    //  - non-empty   -> encrypt + replace.
    let headersEnc: string | null | undefined;
    if (dto.headers === undefined) {
      headersEnc = undefined; // unchanged
    } else if (Object.keys(dto.headers).length === 0) {
      headersEnc = null; // clear
    } else {
      headersEnc = this.encryptHeaders(dto.headers) ?? null;
    }

    await this.repo.update(id, workspaceId, {
      name: dto.name,
      transport: dto.transport,
      url: dto.url,
      headersEnc,
      // undefined => unchanged; [] / value handled by repo (empty => null).
      toolAllowlist: dto.toolAllowlist,
      enabled: dto.enabled,
    });
    this.clients.invalidate(workspaceId);

    const updated = await this.repo.findById(id, workspaceId);
    return this.toView(updated as AiMcpServer);
  }

  async remove(workspaceId: string, id: string): Promise<{ success: true }> {
    await this.repo.delete(id, workspaceId);
    this.clients.invalidate(workspaceId);
    return { success: true };
  }

  /**
   * Connect to the server and list its tools (admin "Test connection"). Never
   * leaks headers or raw upstream bodies — returns only ok + tool names or a
   * short error.
   */
  async test(
    workspaceId: string,
    id: string,
  ): Promise<{ ok: true; tools: string[] } | { ok: false; error: string }> {
    const row = await this.repo.findById(id, workspaceId);
    if (!row) {
      return { ok: false, error: 'MCP server not found' };
    }
    return this.clients.testServer({
      transport: row.transport,
      url: row.url,
      headersEnc: row.headersEnc,
    });
  }

  // --- internals ---

  /** Throw a clear BadRequest when the URL is disallowed by the SSRF policy. */
  private async assertUrlAllowed(url: string): Promise<void> {
    const check = await isUrlAllowed(url);
    if (!check.ok) {
      throw new BadRequestException(
        `URL not allowed: ${check.reason ?? 'blocked by SSRF policy'}`,
      );
    }
  }

  /** Encrypt a non-empty header map to a blob; undefined for empty/absent. */
  private encryptHeaders(
    headers: Record<string, string> | undefined,
  ): string | undefined {
    if (!headers) return undefined;
    // Keep only string values; drop anything else defensively.
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v === 'string' && v.length > 0) clean[k] = v;
    }
    if (Object.keys(clean).length === 0) return undefined;
    return this.secretBox.encryptSecret(JSON.stringify(clean));
  }

  /** Project a row to the public admin view (NEVER includes headersEnc). */
  private toView(row: AiMcpServer): McpServerView {
    return {
      id: row.id,
      name: row.name,
      transport: row.transport,
      url: row.url,
      enabled: row.enabled,
      toolAllowlist: row.toolAllowlist ?? null,
      hasHeaders: Boolean(row.headersEnc),
    };
  }
}
