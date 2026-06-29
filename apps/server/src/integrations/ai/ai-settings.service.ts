import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QueueName, QueueJob } from '../queue/constants';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { AiAgentRoleRepo } from '@docmost/db/repos/ai-agent-roles/ai-agent-roles.repo';
import { AiProviderCredentialsRepo } from '@docmost/db/repos/ai-chat/ai-provider-credentials.repo';
import { PageEmbeddingRepo } from '@docmost/db/repos/ai-chat/page-embedding.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SecretBoxService } from '../crypto/secret-box';
import { EmbeddingReindexProgressService } from './embedding-reindex-progress.service';
import {
  AiDriver,
  AiProviderSettings,
  MaskedAiSettings,
  ResolvedAiConfig,
  SttApiStyle,
  ChatApiStyle,
  PROVIDER_SETTINGS_KEYS,
} from './ai.types';

/**
 * Coerce a raw provider value (stored as `::text`, so it arrives as a string —
 * see workspace.repo.ts) into a positive integer, or `undefined` when it is not
 * a finite number greater than zero. Used for numeric `::text` settings such as
 * `chatContextWindow`. Fractions are floored: `"1.9" → 1`, `"0"`/`"-5"`/`""`/
 * `"abc"`/`undefined` → `undefined`.
 */
export function parsePositiveInt(raw: unknown): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/**
 * TTL (seconds) for the enqueue-time progress PRE-SEED written by `reindex()`
 * before the worker starts. Deliberately SHORT relative to the full 1h record
 * TTL: if `aiQueue.add()` de-duplicates against a job that is just finishing
 * (the worker's finally already ran `clear()` but removeOnComplete hasn't yet
 * removed the job), no new worker runs to overwrite/clear this seed — so this
 * shorter TTL lets the phantom "reindexing: 0 of N" expire instead of sticking
 * for the full 1h record TTL. A worker that DOES start re-seeds with the full
 * TTL, so a real run is unaffected.
 *
 * It MUST be >= the client poll cap (REINDEX_POLL_CAP_MS = 120000ms in
 * ai-provider-settings.tsx) though: the AI_QUEUE worker runs at concurrency 1
 * and shares the queue with page-level embedding jobs, so a queued reindex can
 * wait well beyond a few dozen seconds before the worker re-seeds with the full
 * TTL. If the pre-seed expired while the job is still pending, `get()` returns
 * null and getMasked() falls back to the steady-state COUNT (indexedPages ==
 * totalPages, reindexing=false) — the client reads that as "done & fully
 * indexed", clears its deadline and STOPS polling, so the admin never sees the
 * real climb. Pinning the pre-seed TTL to the client cap means a deduped phantom
 * is bounded to ~120s — the same window the client already polls — and a genuine
 * pending run never expires-into-"done" inside that window.
 */
const PRE_SEED_TTL_SECONDS = 120;

/**
 * Shape of the partial update accepted by `update`. Mirrors the validated
 * controller DTO. `apiKey` / `embeddingApiKey` are write-only: undefined =
 * leave, '' = clear, non-empty = encrypt + store (§6.4/§8).
 */
export interface UpdateAiSettingsInput {
  driver?: AiDriver;
  chatModel?: string;
  // Max context window in tokens for the chat header badge. 0/empty = no limit.
  chatContextWindow?: number;
  chatApiStyle?: ChatApiStyle;
  embeddingModel?: string;
  baseUrl?: string;
  embeddingBaseUrl?: string;
  systemPrompt?: string;
  apiKey?: string;
  embeddingApiKey?: string;
  sttModel?: string;
  sttBaseUrl?: string;
  sttApiStyle?: SttApiStyle;
  // ISO-639-1 dictation language hint (e.g. 'en', 'ru'). Empty = auto-detect.
  sttLanguage?: string;
  sttApiKey?: string;
  publicShareChatModel?: string;
  publicShareAssistantRoleId?: string;
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
    private readonly aiAgentRoleRepo: AiAgentRoleRepo,
    private readonly aiProviderCredentialsRepo: AiProviderCredentialsRepo,
    private readonly pageEmbeddingRepo: PageEmbeddingRepo,
    private readonly pageRepo: PageRepo,
    private readonly secretBox: SecretBoxService,
    private readonly reindexProgress: EmbeddingReindexProgressService,
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

    // Seed a live progress record BEFORE enqueueing so the very first status
    // poll already reports done=0 (the reindex POST returns the PRE-job counts,
    // so without this seed the first poll would still show "total of total").
    // `totalPages` uses countEmbeddablePages — the SAME set the worker iterates
    // and the SAME denominator the status endpoint reports, so the live and
    // steady-state totals match.
    //
    // ONLY seed when no run is active: aiQueue.add() de-duplicates an already-
    // running reindex, so a mid-run re-trigger (second click / second admin /
    // second tab) must NOT reset the visible counter to 0 — that would
    // understate the live worker's real position for the rest of the run. The
    // worker's own start() at run begin is the single authoritative reset.
    let seeded = false;
    if ((await this.reindexProgress.get(workspaceId)) === null) {
      const totalPages = await this.pageRepo.countEmbeddablePages(workspaceId);
      // Short TTL (vs the full 1h record TTL): if add() below de-duplicates
      // against a just-finishing job whose worker already clear()ed but isn't
      // removed yet, no worker runs to clear this seed — the shorter TTL expires
      // the phantom record rather than leaving a stuck "reindexing: 0 of N" for
      // the full record TTL. It is kept >= the client poll cap (120s) so a
      // genuine but still-pending run never expires into a false "done" while
      // the client is still polling (see PRE_SEED_TTL_SECONDS).
      await this.reindexProgress.start(
        workspaceId,
        totalPages,
        PRE_SEED_TTL_SECONDS,
      );
      seeded = true;
    }

    const jobId = `ai-reindex-${workspaceId}`;
    // Clear a prior non-active entry so a stale job can't block this reindex.
    // A locked/active job is left in place (remove() no-ops) and the add() below
    // de-duplicates against it, keeping the in-progress pass.
    await this.aiQueue.remove(jobId).catch(() => undefined);

    try {
      await this.aiQueue.add(
        QueueJob.WORKSPACE_CREATE_EMBEDDINGS,
        { workspaceId },
        {
          jobId,
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    } catch (err) {
      // If the enqueue fails (Redis hiccup/shutdown) the worker never runs, so
      // its finally->clear() never fires. Roll back the seed WE just wrote so
      // the status endpoint doesn't report a stuck "reindexing: 0 of N" for the
      // full TTL. Only clear when this call did the seed — never wipe a
      // concurrent active run's record (get() was non-null, seeded=false).
      if (seeded) {
        await this.reindexProgress.clear(workspaceId);
      }
      throw err;
    }
  }

  /**
   * Whether the anonymous public-share AI assistant is enabled for a workspace
   * (single master toggle `settings.ai.publicShareAssistant`, default false).
   * Used by the public `/api/shares/ai/stream` guardrail funnel: when off, the
   * route 404s so the feature's existence is not revealed.
   */
  async isPublicShareAssistantEnabled(workspaceId: string): Promise<boolean> {
    const workspace = await this.workspaceRepo.findById(workspaceId);
    const settings = (workspace?.settings ?? {}) as {
      ai?: { publicShareAssistant?: boolean };
    };
    return settings?.ai?.publicShareAssistant === true;
  }

  /**
   * Resolve the display name of the agent role acting as the public-share
   * assistant's identity, so the anonymous widget can label messages with the
   * persona name instead of the generic "AI agent". Returns null when no role
   * is configured, or the referenced role is missing/disabled (built-in persona
   * → the client falls back to "AI agent"). Mirrors the role resolution in
   * PublicShareChatService.resolveShareRole.
   */
  async resolvePublicShareAssistantName(
    workspaceId: string,
  ): Promise<string | null> {
    const resolved = await this.resolve(workspaceId);
    const roleId = resolved?.publicShareAssistantRoleId;
    if (!roleId) return null;
    const role = await this.aiAgentRoleRepo.findById(roleId, workspaceId);
    if (!role || !role.enabled) return null;
    const name = role.name?.trim();
    return name ? name : null;
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
      // Max context window for the chat header badge denominator. Stored as
      // ::text; 0/unset/invalid = no limit (undefined).
      chatContextWindow: parsePositiveInt(provider.chatContextWindow),
      // Plain passthrough; getChatModel defaults unset to 'openai-compatible'.
      chatApiStyle: provider.chatApiStyle,
      // Cheap model id for the anonymous public-share assistant; reuses the chat
      // driver/baseUrl/apiKey. Empty/unset → callers fall back to chatModel.
      publicShareChatModel: provider.publicShareChatModel,
      // Agent-role id whose persona the public-share assistant adopts; empty/unset
      // = built-in locked persona.
      publicShareAssistantRoleId: provider.publicShareAssistantRoleId,
      embeddingModel: provider.embeddingModel,
      sttModel: provider.sttModel,
      // Plain passthrough, no fallback; the transcribe path defaults unset to
      // 'multipart' (current behavior).
      sttApiStyle: provider.sttApiStyle,
      // Plain passthrough; empty/unset = auto-detect at the transcribe path.
      sttLanguage: provider.sttLanguage,
      baseUrl: provider.baseUrl,
      systemPrompt: provider.systemPrompt,
    };

    // Effective embedding base URL: the embedding-specific value, else the chat
    // base URL. URL is non-secret and relevant for ollama too, so set it
    // unconditionally.
    config.embeddingBaseUrl = provider.embeddingBaseUrl || provider.baseUrl;

    // Effective STT base URL: the STT-specific value, else the chat base URL.
    // Set unconditionally, same rationale as embeddingBaseUrl.
    config.sttBaseUrl = provider.sttBaseUrl || provider.baseUrl;

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
      // Effective STT key: the STT-specific key, else the chat key.
      config.sttApiKey = creds?.sttApiKeyEnc
        ? this.secretBox.decryptSecret(creds.sttApiKeyEnc)
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

    // Stored as ::text; coerce to a positive integer (or undefined) so the
    // client receives a real number.
    const chatContextWindow = parsePositiveInt(provider.chatContextWindow);

    let hasApiKey = false;
    let hasEmbeddingApiKey = false;
    let hasSttApiKey = false;
    if (provider.driver) {
      const creds = await this.aiProviderCredentialsRepo.find(
        workspaceId,
        provider.driver,
      );
      hasApiKey = !!creds?.apiKeyEnc;
      hasEmbeddingApiKey = !!creds?.embeddingApiKeyEnc;
      hasSttApiKey = !!creds?.sttApiKeyEnc;
    }

    // While a reindex run is active, report its LIVE progress (done climbs 0 ->
    // total) so the settings UI can watch it advance. Read progress FIRST and
    // short-circuit: this endpoint is polled every ~5s for the whole run, so when
    // a record is active we skip the two coverage COUNTs entirely (their results
    // would be discarded anyway). Without the live progress the counter never
    // drops: the per-page reindex hard-replaces rows in its own small
    // transaction, so countIndexedPages stays ~= total for the whole run. With no
    // active record we fall back to the steady-state DB coverage count, which
    // preserves the existing display and the client's "done == total -> stop
    // polling" condition (the run ends -> record cleared -> DB count == total).
    //
    // The fallback `totalPages` counts only pages with embeddable content
    // (non-empty text, content-borne text, or already-stored embeddings), so
    // empty/text-less pages don't keep the "Indexed N of M pages" bar below 100%
    // forever.
    const progress = await this.reindexProgress.get(workspaceId);
    let indexedPages: number;
    let totalPages: number;
    if (progress) {
      indexedPages = progress.done;
      totalPages = progress.total;
    } else {
      [indexedPages, totalPages] = await Promise.all([
        this.pageEmbeddingRepo.countIndexedPages(workspaceId),
        this.pageRepo.countEmbeddablePages(workspaceId),
      ]);
    }

    return {
      driver: provider.driver,
      chatModel: provider.chatModel,
      chatContextWindow,
      chatApiStyle: provider.chatApiStyle,
      embeddingModel: provider.embeddingModel,
      baseUrl: provider.baseUrl,
      embeddingBaseUrl: provider.embeddingBaseUrl,
      sttModel: provider.sttModel,
      sttBaseUrl: provider.sttBaseUrl,
      sttApiStyle: provider.sttApiStyle,
      sttLanguage: provider.sttLanguage,
      systemPrompt: provider.systemPrompt,
      publicShareChatModel: provider.publicShareChatModel,
      publicShareAssistantRoleId: provider.publicShareAssistantRoleId,
      hasApiKey,
      hasEmbeddingApiKey,
      hasSttApiKey,
      indexedPages,
      totalPages,
      // Optional hint for the client: a reindex run is currently in progress.
      reindexing: progress != null,
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
    const { apiKey, embeddingApiKey, sttApiKey, ...nonSecret } = dto;

    // Persist non-secret provider fields (only those present in the partial).
    const providerPatch: Partial<AiProviderSettings> = {};
    // Single source of truth for the writable provider keys (see ai.types).
    for (const key of PROVIDER_SETTINGS_KEYS) {
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
    if (
      apiKey !== undefined ||
      embeddingApiKey !== undefined ||
      sttApiKey !== undefined
    ) {
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

      // STT key.
      if (sttApiKey !== undefined) {
        if (sttApiKey === '') {
          await this.aiProviderCredentialsRepo.clearSttKey(
            workspaceId,
            targetDriver,
          );
        } else {
          const enc = this.secretBox.encryptSecret(sttApiKey);
          await this.aiProviderCredentialsRepo.upsertSttKey(
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
