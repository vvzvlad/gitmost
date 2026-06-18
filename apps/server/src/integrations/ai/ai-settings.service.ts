import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QueueName, QueueJob } from '../queue/constants';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { AiProviderCredentialsRepo } from '@docmost/db/repos/ai-chat/ai-provider-credentials.repo';
import { PageEmbeddingRepo } from '@docmost/db/repos/ai-chat/page-embedding.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SecretBoxService } from '../crypto/secret-box';
import {
  AiDriver,
  AiProviderSettings,
  MaskedAiSettings,
  ResolvedAiConfig,
} from './ai.types';

/**
 * Shape of the partial update accepted by `update`. Mirrors the validated
 * controller DTO. `apiKey` / `embeddingApiKey` are write-only: undefined =
 * leave, '' = clear, non-empty = encrypt + store (§6.4/§8).
 */
export interface UpdateAiSettingsInput {
  driver?: AiDriver;
  chatModel?: string;
  embeddingModel?: string;
  baseUrl?: string;
  embeddingBaseUrl?: string;
  systemPrompt?: string;
  apiKey?: string;
  embeddingApiKey?: string;
}

/**
 * Reads/writes the per-workspace AI provider config.
 *
 * Non-secret fields live in `settings.ai.provider`; the API key lives encrypted
 * in `ai_provider_credentials` (per driver). The decrypted key is only ever
 * returned by `resolve` (server-side use) and is NEVER logged or returned to a
 * client (§8).
 */
@Injectable()
export class AiSettingsService {
  constructor(
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly aiProviderCredentialsRepo: AiProviderCredentialsRepo,
    private readonly pageEmbeddingRepo: PageEmbeddingRepo,
    private readonly pageRepo: PageRepo,
    private readonly secretBox: SecretBoxService,
    @InjectQueue(QueueName.AI_QUEUE) private readonly aiQueue: Queue,
  ) {}

  /**
   * Enqueue a full workspace RAG reindex (manual "Reindex now").
   *
   * Uses a stable per-workspace jobId so rapid re-triggers de-duplicate instead
   * of stacking multiple full reindex passes. A prior non-active job with that
   * id is removed first so a lingering completed/failed/waiting entry can never
   * block a fresh reindex (BullMQ ignores add() when the jobId already exists).
   * If a reindex is already running, remove() is a no-op (it leaves a
   * locked/active job in place, returning 0 without throwing), and the add()
   * below then de-duplicates against that still-present jobId — so the running
   * pass is kept and no duplicate is started. The .catch only guards against
   * transport/Redis errors.
   *
   * Also cancels any pending delayed WORKSPACE_DELETE_EMBEDDINGS job (scheduled
   * when AI Search was disabled) so it cannot wipe the embeddings we are about
   * to rebuild. The job no-ops if embeddings are unconfigured.
   */
  async reindex(workspaceId: string): Promise<void> {
    // A reindex means embeddings must persist: drop the delayed purge, if any.
    await this.aiQueue
      .remove(`ai-search-disabled-${workspaceId}`)
      .catch(() => undefined);

    const jobId = `ai-reindex-${workspaceId}`;
    // Clear a prior non-active entry so a stale job can't block this reindex.
    // A locked/active job is left in place (remove() no-ops) and the add() below
    // de-duplicates against it, keeping the in-progress pass.
    await this.aiQueue.remove(jobId).catch(() => undefined);

    await this.aiQueue.add(
      QueueJob.WORKSPACE_CREATE_EMBEDDINGS,
      { workspaceId },
      {
        jobId,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  /** Read the stored non-secret provider settings for a workspace. */
  private async readProvider(
    workspaceId: string,
  ): Promise<Partial<AiProviderSettings>> {
    const workspace = await this.workspaceRepo.findById(workspaceId);
    const settings = (workspace?.settings ?? {}) as {
      ai?: { provider?: Partial<AiProviderSettings> };
    };
    return settings?.ai?.provider ?? {};
  }

  /**
   * Resolve the full config including the decrypted API key for the stored
   * driver. Returns null when no driver is configured. Ollama needs no key.
   * The key is never logged.
   */
  async resolve(workspaceId: string): Promise<ResolvedAiConfig | null> {
    const provider = await this.readProvider(workspaceId);
    if (!provider.driver) return null;

    const config: ResolvedAiConfig = {
      driver: provider.driver,
      chatModel: provider.chatModel,
      embeddingModel: provider.embeddingModel,
      baseUrl: provider.baseUrl,
      systemPrompt: provider.systemPrompt,
    };

    // Effective embedding base URL: the embedding-specific value, else the chat
    // base URL. URL is non-secret and relevant for ollama too, so set it
    // unconditionally.
    config.embeddingBaseUrl = provider.embeddingBaseUrl || provider.baseUrl;

    if (provider.driver !== 'ollama') {
      const creds = await this.aiProviderCredentialsRepo.find(
        workspaceId,
        provider.driver,
      );
      if (creds?.apiKeyEnc) {
        config.apiKey = this.secretBox.decryptSecret(creds.apiKeyEnc);
      }
      // Effective embedding key: the embedding-specific key, else the chat key.
      config.embeddingApiKey = creds?.embeddingApiKeyEnc
        ? this.secretBox.decryptSecret(creds.embeddingApiKeyEnc)
        : config.apiKey;
    }

    return config;
  }

  /**
   * Masked settings safe for admin clients. NEVER includes any key (even
   * encrypted); only `hasApiKey` / `hasEmbeddingApiKey` for the current driver.
   * Returns the RAW stored `embeddingBaseUrl` (empty means "uses chat value");
   * the fallback is applied only by `resolve`. Also reports RAG indexing
   * coverage (`indexedPages`/`totalPages`) for the settings UI.
   */
  async getMasked(workspaceId: string): Promise<MaskedAiSettings> {
    const provider = await this.readProvider(workspaceId);

    let hasApiKey = false;
    let hasEmbeddingApiKey = false;
    if (provider.driver) {
      const creds = await this.aiProviderCredentialsRepo.find(
        workspaceId,
        provider.driver,
      );
      hasApiKey = !!creds?.apiKeyEnc;
      hasEmbeddingApiKey = !!creds?.embeddingApiKeyEnc;
    }

    // totalPages now counts only pages with embeddable content (non-empty text
    // or already-stored embeddings), so empty/text-less pages don't keep the
    // "Indexed N of M pages" bar below 100% forever.
    const [indexedPages, totalPages] = await Promise.all([
      this.pageEmbeddingRepo.countIndexedPages(workspaceId),
      this.pageRepo.countEmbeddablePages(workspaceId),
    ]);

    return {
      driver: provider.driver,
      chatModel: provider.chatModel,
      embeddingModel: provider.embeddingModel,
      baseUrl: provider.baseUrl,
      embeddingBaseUrl: provider.embeddingBaseUrl,
      systemPrompt: provider.systemPrompt,
      hasApiKey,
      hasEmbeddingApiKey,
      indexedPages,
      totalPages,
    };
  }

  /**
   * Apply a partial update. Non-secret fields are persisted via
   * `updateAiProviderSettings`; the chat / embedding API keys are handled
   * separately, each write-only:
   *   - key === undefined → leave existing key untouched
   *   - key === ''        → clear the key for the target driver
   *   - key non-empty     → encrypt + upsert for the target driver
   *
   * Target driver for the keys = incoming dto.driver, else the stored driver.
   * If any key is supplied but no driver can be determined → BadRequest.
   */
  async update(
    workspaceId: string,
    dto: UpdateAiSettingsInput,
  ): Promise<MaskedAiSettings> {
    const { apiKey, embeddingApiKey, ...nonSecret } = dto;

    // Persist non-secret provider fields (only those present in the partial).
    const providerPatch: Partial<AiProviderSettings> = {};
    for (const key of [
      'driver',
      'chatModel',
      'embeddingModel',
      'baseUrl',
      'embeddingBaseUrl',
      'systemPrompt',
    ] as const) {
      if (nonSecret[key] !== undefined) {
        (providerPatch as Record<string, unknown>)[key] = nonSecret[key];
      }
    }
    if (Object.keys(providerPatch).length > 0) {
      await this.workspaceRepo.updateAiProviderSettings(
        workspaceId,
        providerPatch,
      );
    }

    // Key handling (write-only). Both keys share the same target driver and the
    // same "driver required" guard, resolved once.
    if (apiKey !== undefined || embeddingApiKey !== undefined) {
      const stored = await this.readProvider(workspaceId);
      const targetDriver = dto.driver ?? stored.driver;
      if (!targetDriver) {
        throw new BadRequestException(
          'Cannot set the API key without a driver; set the driver first',
        );
      }

      // Chat key.
      if (apiKey !== undefined) {
        if (apiKey === '') {
          await this.aiProviderCredentialsRepo.clearKey(
            workspaceId,
            targetDriver,
          );
        } else {
          const enc = this.secretBox.encryptSecret(apiKey);
          await this.aiProviderCredentialsRepo.upsert(
            workspaceId,
            targetDriver,
            enc,
          );
        }
      }

      // Embedding key.
      if (embeddingApiKey !== undefined) {
        if (embeddingApiKey === '') {
          await this.aiProviderCredentialsRepo.clearEmbeddingKey(
            workspaceId,
            targetDriver,
          );
        } else {
          const enc = this.secretBox.encryptSecret(embeddingApiKey);
          await this.aiProviderCredentialsRepo.upsertEmbeddingKey(
            workspaceId,
            targetDriver,
            enc,
          );
        }
      }
    }

    return this.getMasked(workspaceId);
  }
}
