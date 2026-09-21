import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { AiMcpServerRepo } from '@docmost/db/repos/ai-chat/ai-mcp-server.repo';
import { AiMcpServer } from '@docmost/db/types/entity.types';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { SecretBoxService } from '../../../integrations/crypto/secret-box';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { McpClientsService } from './mcp-clients.service';
import { CreateMcpServerDto } from './dto/create-mcp-server.dto';
import { UpdateMcpServerDto } from './dto/update-mcp-server.dto';
import {
  McpServerView,
  assertMcpUrlAllowed,
  encryptMcpHeaders,
  toMcpServerView,
} from './mcp-server-view.util';

/**
 * Personal external MCP servers (#686, phase 2 / PR A). A member manages their
 * OWN servers via `account/mcp-servers`; there is NO admin gate. This service is
 * the mirror of the admin `McpServersService` but every read/write goes through
 * the repo's owner-scoped `*ForUser` methods — a user can ONLY ever touch a row
 * they own (the repo is the isolation barrier, see ai-mcp-server.repo.ts).
 *
 * SECURITY (§8.10): the same write-only-headers contract as the admin path —
 * headers are encrypted on save and NEVER returned; the view carries only
 * `hasHeaders`. SSRF validation (`assertMcpUrlAllowed`) runs on every save.
 *
 * CACHE (#686 phase 3 / PR B): the agent loop now CONSUMES personal servers via
 * the per-user toolset cache (`McpClientsService.toolsFor(workspaceId, userId)`).
 * Every personal mutation therefore evicts THIS user's cache entry only, via
 * `invalidateUser(workspaceId, userId)` — the single-key eviction, never the
 * admin fan-out (a personal change affects no other user's toolset).
 */
@Injectable()
export class AccountMcpServersService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly repo: AiMcpServerRepo,
    private readonly secretBox: SecretBoxService,
    private readonly clients: McpClientsService,
    private readonly env: EnvironmentService,
  ) {}

  async list(workspaceId: string, userId: string): Promise<McpServerView[]> {
    const rows = await this.repo.listByUser(workspaceId, userId);
    return rows.map((r) => toMcpServerView(r));
  }

  /**
   * Create a personal server, enforcing the per-user cap under a row lock so
   * concurrent creates cannot both slip past the limit (#686). The whole
   * count-then-insert runs in ONE transaction:
   *   1. `lockUserRow` takes FOR NO KEY UPDATE on the user's `users` row —
   *      serializing this user's concurrent creates through a single gate;
   *   2. `countByUser` reads the current count under that lock;
   *   3. at/over the cap => reject; otherwise insert the row.
   * A burst of parallel creates therefore ends with AT MOST `max` rows.
   */
  async createPersonal(
    workspaceId: string,
    userId: string,
    dto: CreateMcpServerDto,
  ): Promise<McpServerView> {
    await assertMcpUrlAllowed(dto.url);

    // Encrypt the auth headers if any non-empty set was provided.
    const headersEnc = encryptMcpHeaders(this.secretBox, dto.headers);

    const max = this.env.getMcpPersonalServersMax();

    const row = await executeTx(this.db, async (trx) => {
      // Serialize this user's concurrent creates so the cap is race-free.
      await this.repo.lockUserRow(userId, trx);

      const count = await this.repo.countByUser(userId, trx);
      if (count >= max) {
        throw new BadRequestException(
          `Personal MCP server limit reached (${max}). Delete an existing server before adding another.`,
        );
      }

      return this.repo.insert(
        {
          workspaceId,
          userId,
          name: dto.name,
          transport: dto.transport,
          url: dto.url,
          headersEnc,
          toolAllowlist: dto.toolAllowlist ?? null,
          // Blank/whitespace guidance is normalized to null by the repo.
          instructions: dto.instructions ?? null,
          enabled: dto.enabled ?? true,
        },
        trx,
      );
    });

    // Evict this user's cached toolset so the new server is picked up next turn.
    this.clients.invalidateUser(workspaceId, userId);
    return toMcpServerView(row);
  }

  async update(
    workspaceId: string,
    userId: string,
    id: string,
    dto: UpdateMcpServerDto,
  ): Promise<McpServerView> {
    const existing = await this.repo.findByIdForUser(id, workspaceId, userId);
    if (!existing) {
      // 404: the server does not exist OR is not owned by this user — a member
      // can only ever act on their own rows.
      throw new NotFoundException('MCP server not found');
    }

    // Re-validate the URL whenever it changes (user-supplied -> SSRF risk).
    if (dto.url !== undefined && dto.url !== existing.url) {
      await assertMcpUrlAllowed(dto.url);
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
      headersEnc = encryptMcpHeaders(this.secretBox, dto.headers) ?? null;
    }

    await this.repo.updateForUser(id, workspaceId, userId, {
      name: dto.name,
      transport: dto.transport,
      url: dto.url,
      headersEnc,
      // undefined => unchanged; null => no restriction; `[]` is persisted
      // verbatim and means deny-all (#476).
      toolAllowlist: dto.toolAllowlist,
      // undefined => unchanged; blank => cleared (null) by the repo.
      instructions: dto.instructions,
      enabled: dto.enabled,
    });

    // Evict this user's cached toolset so the edit takes effect next turn.
    this.clients.invalidateUser(workspaceId, userId);
    const updated = await this.repo.findByIdForUser(id, workspaceId, userId);
    return toMcpServerView(updated as AiMcpServer);
  }

  async remove(
    workspaceId: string,
    userId: string,
    id: string,
  ): Promise<{ success: true }> {
    const existing = await this.repo.findByIdForUser(id, workspaceId, userId);
    if (!existing) {
      // 404: not found for this user (another user's row is invisible here).
      throw new NotFoundException('MCP server not found');
    }
    await this.repo.deleteForUser(id, workspaceId, userId);
    // Evict this user's cached toolset so the removed server is gone next turn.
    this.clients.invalidateUser(workspaceId, userId);
    return { success: true };
  }

  /**
   * Connect to the user's own server and list its tools ("Test connection").
   * Reuses the admin test transport (never leaks headers or upstream bodies).
   * Scoped to the owner: a non-owner's id is simply "not found".
   */
  async test(
    workspaceId: string,
    userId: string,
    id: string,
  ): Promise<{ ok: true; tools: string[] } | { ok: false; error: string }> {
    const row = await this.repo.findByIdForUser(id, workspaceId, userId);
    if (!row) {
      return { ok: false, error: 'MCP server not found' };
    }
    return this.clients.testServer({
      transport: row.transport,
      url: row.url,
      headersEnc: row.headersEnc,
    });
  }
}
