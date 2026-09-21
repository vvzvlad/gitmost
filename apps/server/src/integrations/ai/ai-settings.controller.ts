import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import WorkspaceAbilityFactory from '../../core/casl/abilities/workspace-ability.factory';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../../core/casl/interfaces/workspace-ability.type';
import { AiService } from './ai.service';
import { AiSettingsService } from './ai-settings.service';
import { UpdateAiSettingsDto } from './dto/update-ai-settings.dto';
import { TestAiConnectionDto } from './dto/test-ai-connection.dto';

/**
 * Admin-only AI provider settings (§6.4). Routes are POST to match the rest of
 * this codebase (it uses POST for reads too). Access is gated by the workspace
 * admin ability — the same gate as `POST /workspace/update`. No endpoint here
 * ever returns the API key (only `hasApiKey`).
 */
@UseGuards(JwtAuthGuard)
@Controller('workspace/ai-settings')
export class AiSettingsController {
  private readonly logger = new Logger(AiSettingsController.name);

  constructor(
    private readonly aiService: AiService,
    private readonly aiSettingsService: AiSettingsService,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
  ) {}

  private assertAdmin(user: User, workspace: Workspace) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings)
    ) {
      throw new ForbiddenException();
    }
  }

  @HttpCode(HttpStatus.OK)
  @Post()
  async getSettings(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertAdmin(user, workspace);
    return this.aiSettingsService.getMasked(workspace.id);
  }

  /**
   * #599 (R1) — the embedding FINGERPRINT this workspace's config currently
   * resolves to, or null when no embedding provider resolves at all (no workspace
   * provider AND no global TEI sidecar). Never throws: it is only used to DECIDE
   * whether a reindex is needed, and an unexpected resolve failure must not fail
   * the settings write that already succeeded.
   */
  private async embeddingFingerprint(
    workspaceId: string,
  ): Promise<string | null> {
    try {
      const provider =
        await this.aiService.resolveEmbeddingProvider(workspaceId);
      return provider.fingerprint;
    } catch {
      return null;
    }
  }

  /**
   * #599 (R1) — changing the embedding config AUTOMATICALLY starts the reindex.
   *
   * The fingerprint (model + revision + prefix scheme + dimensions) is what both
   * readers filter by, and PR-2's D2 guard turns the vector arm OFF while the
   * ACTIVE generation's model differs from the configured one. So without this,
   * switching the embedding model silently killed semantic search in BOTH search and
   * RAG — degraded to lexical-only — and left it that way INDEFINITELY, until some
   * human happened to click "Reindex now". Nothing else enqueues it: the AI-Search
   * toggle only fires on enable, and page events only reindex the edited page.
   *
   * So: resolve the fingerprint BEFORE and AFTER the write and enqueue a full
   * reindex only when it actually MOVED. Which means an unrelated settings edit —
   * rotating the provider API key, changing the chat model, the system prompt, the
   * STT language — enqueues NOTHING: none of them touch the fingerprint, so the
   * stored generation is still valid and a full re-embed of the workspace (an
   * expensive, provider-billed operation) would be pure waste.
   *
   * It goes through AiSettingsService.reindex — the SAME path as the manual button,
   * hence the same per-workspace jobId — so a run already in flight is de-duplicated
   * rather than doubled, and the job inherits the #599 retry policy.
   *
   * Why here and not inside AiSettingsService.update: the fingerprint can only be
   * resolved by AiService, and AiService already injects AiSettingsService — putting
   * the call there would create a circular dependency. This controller is the ONLY
   * caller of update(), and it already holds both services.
   */
  @HttpCode(HttpStatus.OK)
  @Post('update')
  async updateSettings(
    @Body() dto: UpdateAiSettingsDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertAdmin(user, workspace);

    const before = await this.embeddingFingerprint(workspace.id);
    // Returns masked settings only — never the key.
    const masked = await this.aiSettingsService.update(workspace.id, dto);
    const after = await this.embeddingFingerprint(workspace.id);

    // `after === null` = the change left the workspace with no embedding provider at
    // all: there is nothing to index, and a job would just no-op.
    if (after !== null && after !== before) {
      try {
        await this.aiSettingsService.reindex(workspace.id);
        // Re-read so the response already carries `reindexing: true` + the live
        // progress seed, instead of the pre-enqueue counts.
        return this.aiSettingsService.getMasked(workspace.id);
      } catch (err) {
        // The settings are ALREADY persisted; a Redis hiccup on the enqueue must not
        // turn a successful save into a 500. Log it and return the saved settings —
        // the admin can still trigger the reindex with the "Reindex now" button.
        this.logger.error(
          `ai-settings.reindex-enqueue-failed workspace=${workspace.id}: ` +
            `${err instanceof Error ? err.message : String(err)} ` +
            `(the embedding fingerprint changed but no reindex could be enqueued; ` +
            `semantic search stays on the previous generation until one is)`,
        );
      }
    }

    return masked;
  }

  @HttpCode(HttpStatus.OK)
  @Post('test')
  async testConnection(
    @Body() dto: TestAiConnectionDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertAdmin(user, workspace);
    return this.aiService.testConnection(workspace.id, dto.capability);
  }

  @HttpCode(HttpStatus.OK)
  @Post('reindex')
  async reindex(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertAdmin(user, workspace);
    await this.aiSettingsService.reindex(workspace.id);
    // Indexing runs as an async background job, so these masked settings carry
    // the PRE-job counts (the indexed total has not climbed yet). The client
    // polls this endpoint's GET counterpart to watch the counter advance.
    return this.aiSettingsService.getMasked(workspace.id);
  }
}
