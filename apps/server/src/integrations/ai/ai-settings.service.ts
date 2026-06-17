import { BadRequestException, Injectable } from '@nestjs/common';
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
 * controller DTO. `apiKey` is write-only: undefined = leave, '' = clear,
 * non-empty = encrypt + store (§6.4/§8).
 */
export interface UpdateAiSettingsInput {
  driver?: AiDriver;
  chatModel?: string;
  embeddingModel?: string;
  baseUrl?: string;
  systemPrompt?: string;
  apiKey?: string;
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
  ) {}

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

    if (provider.driver !== 'ollama') {
      const creds = await this.aiProviderCredentialsRepo.find(
        workspaceId,
        provider.driver,
      );
      if (creds?.apiKeyEnc) {
        config.apiKey = this.secretBox.decryptSecret(creds.apiKeyEnc);
      }
    }

    return config;
  }

  /**
   * Masked settings safe for admin clients. NEVER includes the key (even
   * encrypted); only `hasApiKey` for the current driver. Also reports RAG
   * indexing coverage (`indexedPages`/`totalPages`) for the settings UI.
   */
  async getMasked(workspaceId: string): Promise<MaskedAiSettings> {
    const provider = await this.readProvider(workspaceId);

    let hasApiKey = false;
    if (provider.driver) {
      const creds = await this.aiProviderCredentialsRepo.find(
        workspaceId,
        provider.driver,
      );
      hasApiKey = !!creds?.apiKeyEnc;
    }

    const [indexedPages, totalPages] = await Promise.all([
      this.pageEmbeddingRepo.countIndexedPages(workspaceId),
      this.pageRepo.countByWorkspace(workspaceId),
    ]);

    return {
      driver: provider.driver,
      chatModel: provider.chatModel,
      embeddingModel: provider.embeddingModel,
      baseUrl: provider.baseUrl,
      systemPrompt: provider.systemPrompt,
      hasApiKey,
      indexedPages,
      totalPages,
    };
  }

  /**
   * Apply a partial update. Non-secret fields are persisted via
   * `updateAiProviderSettings`; the API key is handled separately:
   *   - apiKey === undefined → leave existing key untouched
   *   - apiKey === ''        → clear the key for the target driver
   *   - apiKey non-empty     → encrypt + upsert for the target driver
   *
   * Target driver for the key = incoming dto.driver, else the stored driver.
   * If a key is supplied but no driver can be determined → BadRequest.
   */
  async update(
    workspaceId: string,
    dto: UpdateAiSettingsInput,
  ): Promise<MaskedAiSettings> {
    const { apiKey, ...nonSecret } = dto;

    // Persist non-secret provider fields (only those present in the partial).
    const providerPatch: Partial<AiProviderSettings> = {};
    for (const key of [
      'driver',
      'chatModel',
      'embeddingModel',
      'baseUrl',
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

    // Key handling (write-only).
    if (apiKey !== undefined) {
      const stored = await this.readProvider(workspaceId);
      const targetDriver = dto.driver ?? stored.driver;
      if (!targetDriver) {
        throw new BadRequestException(
          'Cannot set the API key without a driver; set the driver first',
        );
      }

      if (apiKey === '') {
        await this.aiProviderCredentialsRepo.clearKey(workspaceId, targetDriver);
      } else {
        const enc = this.secretBox.encryptSecret(apiKey);
        await this.aiProviderCredentialsRepo.upsert(
          workspaceId,
          targetDriver,
          enc,
        );
      }
    }

    return this.getMasked(workspaceId);
  }
}
