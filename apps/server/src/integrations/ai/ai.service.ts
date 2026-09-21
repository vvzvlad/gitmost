import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  embedMany,
  experimental_transcribe as transcribe,
  generateText,
  type EmbeddingModel,
  type LanguageModel,
} from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOllama } from 'ai-sdk-ollama';
import { AiSettingsService } from './ai-settings.service';
import { AiNotConfiguredException } from './ai-not-configured.exception';
import { AiEmbeddingNotConfiguredException } from './ai-embedding-not-configured.exception';
import { AiSttNotConfiguredException } from './ai-stt-not-configured.exception';
import { describeProviderError } from './ai-error.util';
import { createInstrumentedFetch } from './ai-provider-http';
import {
  createStreamingFetch,
  withPreResponseRetry,
} from './ai-streaming-fetch';
import { AiProviderCredentialsRepo } from '@docmost/db/repos/ai-chat/ai-provider-credentials.repo';
import { SecretBoxService } from '../crypto/secret-box';
import { AiDriver } from './ai.types';
import { createHash } from 'node:crypto';

/**
 * A resolved embedding provider for #530 semantic search. `model` is the AI SDK
 * embedding model; `queryPrefix`/`docPrefix` are prepended to a query / a stored
 * chunk respectively (e5-style `"query: "` / `"passage: "`, empty for a non-e5
 * provider); `fingerprint` is the deterministic id of the whole configuration.
 *
 * #599 `modelId` — the bare model NAME (the same value the indexer stamps into
 * `page_embeddings.model_name`). It is a COARSER key than the fingerprint: a
 * revision bump or a prefix toggle changes the fingerprint but NOT the model id.
 * That distinction is what lets a reader decide whether the old generation's rows
 * are still comparable with a query vector from the CURRENT model: same model =>
 * same embedding SPACE (a prefix/revision change only shifts it slightly), a
 * different model => a different space entirely, where cosine against the old rows
 * is noise. See EmbeddingGenerationService.generationForTarget.
 */
export interface ResolvedEmbeddingProvider {
  model: EmbeddingModel;
  /** Bare model name, mirrored per row in `page_embeddings.model_name` (#599). */
  modelId: string;
  queryPrefix: string;
  docPrefix: string;
  fingerprint: string;
}

/**
 * Deterministic embedding FINGERPRINT (#530). Encodes model id + revision +
 * prefix scheme + dimensions so that ANY of them changing (a revision bump, a
 * prefix toggle) yields a DIFFERENT fingerprint even when the bare model name and
 * dimension are unchanged. Deliberately NOT the bare model name: two rows from
 * the same model but a different revision/prefix must not be fused together.
 *
 * Exported as a pure function so it can be unit-tested in isolation and reused by
 * the indexer without a service instance.
 *
 * KNOWN GAP (#599 R8b, inherited from PR-1 — follow-up, NOT fixed here): the
 * fingerprint does NOT include the provider ENDPOINT (`embeddingBaseUrl` /
 * `EMBEDDING_ENDPOINT`) or the driver. Repoint a workspace at a DIFFERENT service
 * that happens to serve a SAME-NAMED model (a private fine-tune called
 * `bge-base-en`, a second TEI sidecar with different weights, a proxy that maps the
 * name elsewhere) and the fingerprint is IDENTICAL: no swap window opens, the
 * generation pointer never moves, `modelChanged` stays false — and the D2 guard,
 * whose whole premise is "a different embedding space always shows up as a
 * different model name", is bypassed. Search then serves a cross-space cosine
 * (query from the new weights vs rows from the old ones) and RRF promotes the
 * resulting noise. Mitigating it means folding the endpoint (and driver) into the
 * fingerprint, which forces a full reindex on any endpoint move — including benign
 * ones (a host rename, an HA re-address), so it is a deliberate follow-up decision,
 * not a drive-by change here. Until then: an operator who repoints the embedding
 * endpoint at different weights MUST click "Reindex now".
 */
export function computeEmbeddingFingerprint(parts: {
  modelId: string;
  revision: string;
  queryPrefix: string;
  docPrefix: string;
  dimensions: number | null;
}): string {
  // The two prefixes are SEPARATE keys (not a concatenated string): JSON.stringify
  // escapes each independently, so the prefix scheme ("a","") is distinct from
  // ("","a") with no separator/collision hazard even if a prefix contains spaces.
  const canonical = JSON.stringify({
    m: parts.modelId,
    r: parts.revision,
    q: parts.queryPrefix,
    d: parts.docPrefix,
    dim: parts.dimensions ?? 0,
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/**
 * Optional chat-model override carried by an agent role (`ai_agent_roles.
 * model_config`). `chatModel` swaps the model id; `driver` (optional) switches
 * the whole provider, in which case its creds come from `ai_provider_credentials`
 * for that driver. `roleName` is only used to produce a clear 503 message when
 * the chosen driver is not configured.
 */
export interface ChatModelOverride {
  driver?: AiDriver;
  chatModel?: string;
  roleName?: string;
}

/**
 * Builds AI SDK language models from per-workspace config and runs cheap
 * connectivity checks.
 *
 * The provider client is built PER WORKSPACE on demand — never cached globally —
 * and the decrypted API key is held only for the duration of the call and is
 * never logged (§6.2/§8).
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  // Provider HTTP fetch for the chat path, layered so each transport concern is
  // observed (#175). Inside-out: the streaming fetch (finite silence timeouts +
  // keep-alive recycling) → provider-HTTP instrumentation (logs every attempt) →
  // pre-response connection-reset retry as the OUTERMOST layer. Retry-outer means
  // a reset the retry recovers from is still logged with its idle-gap, instead of
  // collapsing into a clean "OK". Held for the service lifetime to reuse the
  // streaming dispatcher's connection pool.
  private readonly aiProviderFetch = withPreResponseRetry(
    createInstrumentedFetch('AiService:provider-http', createStreamingFetch()),
  );

  constructor(
    private readonly aiSettings: AiSettingsService,
    private readonly aiProviderCredentialsRepo: AiProviderCredentialsRepo,
    private readonly secretBox: SecretBoxService,
  ) {}

  /**
   * Resolve the workspace config and build the chat language model.
   * Throws AiNotConfiguredException (→ 503) when the config is incomplete.
   *
   * `override` optionally swaps the model id and/or the whole provider:
   *  - `override.chatModel` replaces the workspace chat model id;
   *  - `override.driver` (when it differs from the workspace driver) switches the
   *    provider, pulling that driver's creds from `ai_provider_credentials`. When
   *    those creds are missing the call throws a 503 naming the role's driver — a
   *    deliberate, explicit failure rather than a silent fallback. Resolved
   *    BEFORE the stream starts so the 503 surfaces as clean JSON.
   *
   * Two callers: an agent role's `model_config` (may set driver + model), and
   * the anonymous public-share assistant, which passes ONLY `chatModel` (the
   * cheap `publicShareChatModel`) so the driver/baseUrl/apiKey stay the
   * workspace's configured chat provider. A blank override falls back to the
   * workspace `chatModel`.
   */
  async getChatModel(
    workspaceId: string,
    override?: ChatModelOverride,
  ): Promise<LanguageModel> {
    const cfg = await this.aiSettings.resolve(workspaceId);
    if (!cfg?.driver) {
      throw new AiNotConfiguredException();
    }

    // Determine the effective driver + model + creds, applying the override.
    const overrideDriver = override?.driver;
    const driver: AiDriver = overrideDriver ?? cfg.driver;
    const chatModel = override?.chatModel?.trim() || cfg.chatModel;

    let apiKey = cfg.apiKey;
    let baseUrl = cfg.baseUrl;
    // Chat provider implementation, chosen EXPLICITLY by the admin (not inferred
    // from baseUrl). Unset → 'openai-compatible' so reasoning is surfaced by
    // default for this fork's openai+baseUrl setups.
    const chatApiStyle = cfg.chatApiStyle ?? 'openai-compatible';

    // A driver override that differs from the workspace driver needs that
    // driver's own creds (the workspace driver's key would be wrong/absent).
    if (overrideDriver && overrideDriver !== cfg.driver) {
      if (overrideDriver === 'ollama') {
        // Cross-driver override to ollama: the workspace driver is NOT ollama, so
        // there is no configured ollama endpoint. `cfg.baseUrl` belongs to the
        // workspace driver (e.g. an OpenAI/OpenRouter gateway) and pointing the
        // ollama client at it would silently send requests to the wrong server.
        // Fail explicitly (503) — a dedicated per-driver ollama endpoint is not
        // supported yet. The same-driver ollama case (handled outside this block)
        // legitimately reuses the workspace's ollama endpoint and is unaffected.
        const who = override?.roleName
          ? ` for role "${override.roleName}"`
          : '';
        throw new AiNotConfiguredException(
          `An ollama model override${who} requires a dedicated ollama endpoint, ` +
            `which is not supported when the workspace driver is "${cfg.driver}". ` +
            `Set the role's driver to "${cfg.driver}" or switch the workspace ` +
            `to ollama.`,
        );
      } else {
        const creds = await this.aiProviderCredentialsRepo.find(
          workspaceId,
          overrideDriver,
        );
        apiKey = creds?.apiKeyEnc
          ? this.secretBox.decryptSecret(creds.apiKeyEnc)
          : undefined;
        if (!apiKey) {
          // Explicit 503: the role chose a provider that is not set up. Name the
          // driver (and role, when known) so the admin can fix it — no silent
          // fallback to the workspace model (error-handling convention).
          const who = override?.roleName
            ? ` for role "${override.roleName}"`
            : '';
          throw new AiNotConfiguredException(
            `The model provider "${overrideDriver}"${who} is selected but not ` +
              `configured (no API key). Configure ${overrideDriver} in AI ` +
              `settings or change the role's model.`,
          );
        }
        // A cross-driver override does not carry the workspace baseUrl (that URL
        // belongs to the workspace driver); use the provider default for the
        // overridden driver.
        baseUrl = undefined;
      }
    }

    if (!chatModel || (driver !== 'ollama' && !apiKey)) {
      throw new AiNotConfiguredException();
    }

    switch (driver) {
      case 'openai': {
        // The provider implementation is chosen by the admin's `chatApiStyle`
        // (NOT inferred from baseUrl — a custom URL can front real OpenAI too).
        // Both branches hit Chat Completions (/chat/completions); the provider
        // fetch is the instrumented streaming fetch (finite-but-generous stream
        // timeouts, #175).
        //
        // 'openai-compatible' (default) maps the third-party provider's streamed
        // `reasoning_content` to reasoning parts (z.ai/GLM, DeepSeek, ...) — the
        // point of #175. It has no default endpoint, so it requires a baseURL;
        // when there is none (real OpenAI, or a role's cross-driver override that
        // cleared baseUrl) we fall back to the official provider.
        if (chatApiStyle === 'openai-compatible' && baseUrl) {
          return createOpenAICompatible({
            name: 'openai-compatible',
            apiKey,
            baseURL: baseUrl,
            // Keep streamed token usage (stream_options.include_usage): without
            // it @ai-sdk/openai-compatible omits usage, zeroing the live token
            // counter and reasoning-token metadata. The official provider always
            // sent it, so this preserves parity.
            includeUsage: true,
            fetch: this.aiProviderFetch,
          })(chatModel);
        }
        // Official @ai-sdk/openai: real-OpenAI reasoning-model request shaping;
        // `.chat()` targets Chat Completions (the default callable targets the
        // Responses API, which openai-compatible gateways 400 on multi-turn
        // history). In this fork baseUrl is normally set; undefined = real OpenAI.
        return createOpenAI({
          apiKey,
          baseURL: baseUrl,
          fetch: this.aiProviderFetch,
        }).chat(chatModel);
      }
      case 'gemini':
        // Route gemini through the same instrumented streaming fetch as openai
        // (finite silence timeouts + keep-alive recycling + pre-response
        // connection-reset retry). Without it the provider ran on the global
        // undici fetch — no keep-alive recycle, no reset retries, default
        // (unbounded silence) timeout — so incident classes #140/#175/#310 were
        // reproducible for gemini too.
        return createGoogleGenerativeAI({
          apiKey,
          fetch: this.aiProviderFetch,
        })(chatModel);
      case 'ollama':
        // Ollama needs no API key. Same transport hardening as above (#140/#175/#310).
        return createOllama({
          baseURL: baseUrl,
          fetch: this.aiProviderFetch,
        })(chatModel);
      default:
        throw new AiNotConfiguredException();
    }
  }

  /**
   * Resolve the workspace config and build the text-embedding model used by the
   * RAG indexer / semanticSearch (§6.7 stage D). Built PER WORKSPACE on demand,
   * same as getChatModel; the decrypted key is never logged.
   *
   * Uses the embedding-specific endpoint/key (`embeddingBaseUrl` /
   * `embeddingApiKey`), which fall back to the chat values when unset (resolved
   * by AiSettingsService.resolve).
   *
   * Throws AiEmbeddingNotConfiguredException (→ 503) when the driver,
   * embeddingModel or (for non-ollama) the embedding API key is missing, so RAG
   * callers can 503 or skip independently of chat being configured.
   */
  async getEmbeddingModel(workspaceId: string): Promise<EmbeddingModel> {
    const cfg = await this.aiSettings.resolve(workspaceId);
    if (
      !cfg?.driver ||
      !cfg?.embeddingModel ||
      (cfg.driver !== 'ollama' && !cfg.embeddingApiKey)
    ) {
      throw new AiEmbeddingNotConfiguredException();
    }

    switch (cfg.driver) {
      case 'openai':
        // embeddingBaseUrl (when set) covers openai-compatible endpoints.
        return createOpenAI({
          apiKey: cfg.embeddingApiKey,
          baseURL: cfg.embeddingBaseUrl,
        }).textEmbeddingModel(cfg.embeddingModel);
      case 'gemini':
        return createGoogleGenerativeAI({
          apiKey: cfg.embeddingApiKey,
        }).textEmbeddingModel(cfg.embeddingModel);
      case 'ollama':
        // Ollama needs no API key (e.g. nomic-embed-text).
        return createOllama({
          baseURL: cfg.embeddingBaseUrl,
        }).textEmbeddingModel(cfg.embeddingModel);
      default:
        throw new AiEmbeddingNotConfiguredException();
    }
  }

  /**
   * Transcribe audio with the workspace STT model. The request encoding is the
   * admin-chosen `sttApiStyle`: 'json' uses the JSON+base64 audio/transcriptions
   * API (OpenRouter); anything else (default 'multipart') uses the AI SDK
   * multipart path (OpenAI, speaches, faster-whisper-server, ...). `format` is
   * the audio container hint (webm / mp4 / wav / mp3 / ogg / m4a). Built PER
   * WORKSPACE; the key is never logged. Throws AiSttNotConfiguredException
   * (-> 503) when no STT model is configured.
   */
  async transcribe(
    workspaceId: string,
    audio: Uint8Array,
    format: string,
  ): Promise<string> {
    const cfg = await this.aiSettings.resolve(workspaceId);
    if (!cfg?.sttModel) throw new AiSttNotConfiguredException();
    const baseURL = cfg.sttBaseUrl || cfg.baseUrl;
    // Trimmed language hint; empty/unset = auto-detect (never forward an empty
    // string to the provider, which would override auto-detect).
    const sttLanguage = cfg.sttLanguage?.trim() || undefined;

    // Explicit, admin-chosen request encoding (no URL guessing). 'json' is the
    // OpenRouter style (JSON + base64 input_audio); everything else uses the
    // OpenAI-compatible multipart path via the AI SDK.
    if (cfg.sttApiStyle === 'json') {
      return this.transcribeJsonBase64(
        baseURL,
        cfg.sttApiKey,
        cfg.sttModel,
        audio,
        format,
        sttLanguage,
      );
    }

    // Standard OpenAI-compatible multipart path (AI SDK). apiKey may be unused for
    // keyless self-hosted whisper; pass a placeholder.
    const model = createOpenAI({
      apiKey: cfg.sttApiKey ?? 'unused',
      baseURL,
    }).transcription(cfg.sttModel);
    const { text } = await transcribe({
      model,
      audio,
      // Forward the language hint only when set; the OpenAI transcription model
      // reads it from providerOptions.openai.language.
      ...(sttLanguage
        ? { providerOptions: { openai: { language: sttLanguage } } }
        : {}),
    });
    return text.trim();
  }

  /**
   * JSON + base64 transcription body (OpenRouter-style). POSTs
   * { model, input_audio: { data, format } } to {baseURL}/audio/transcriptions
   * and returns { text }. The optional `language` ISO-639-1 hint is included as
   * a top-level body field only when set (empty/unset = auto-detect).
   */
  private async transcribeJsonBase64(
    baseURL: string | undefined,
    apiKey: string | undefined,
    model: string,
    audio: Uint8Array,
    format: string,
    language?: string,
  ): Promise<string> {
    if (!baseURL) {
      throw new BadRequestException(
        'STT base URL is not set (required for the JSON request format)',
      );
    }
    const url = `${baseURL.replace(/\/$/, '')}/audio/transcriptions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        ...(language ? { language } : {}),
        input_audio: {
          data: Buffer.from(audio).toString('base64'),
          format,
        },
      }),
    });
    if (!res.ok) {
      // Surface status + body so the real reason reaches the user; never log the key.
      const body = await res.text().catch(() => '');
      throw new Error(
        `JSON transcription request failed (${res.status}): ${body.slice(0, 500)}`,
      );
    }
    const json = (await res.json()) as { text?: string };
    return (json.text ?? '').trim();
  }

  /**
   * Embed a batch of texts with the workspace embedding model. Returns one
   * vector per input, in the same order. Thin wrapper over the AI SDK's
   * embedMany; never logs the key or the texts.
   */
  async embedTexts(workspaceId: string, texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const model = await this.getEmbeddingModel(workspaceId);
    return this.embedWithModel(model, workspaceId, texts);
  }

  /**
   * #530: resolve the embedding provider for a workspace. Prefers the workspace's
   * own configured embedding provider; falls back to the GLOBAL env provider (a
   * TEI sidecar via the OpenAI-compatible path) when the workspace has none.
   * Returns the model + the query/doc prefixes + the config fingerprint. Throws
   * AiEmbeddingNotConfiguredException when NEITHER resolves, so callers can drive
   * a `no-provider` degrade path.
   */
  async resolveEmbeddingProvider(
    workspaceId: string,
  ): Promise<ResolvedEmbeddingProvider> {
    // 1. Per-workspace provider (uses the workspace's own creds/endpoint). When
    //    it is not configured getEmbeddingModel throws the not-configured
    //    exception; we swallow ONLY that and fall through to the global provider.
    try {
      const model = await this.getEmbeddingModel(workspaceId);
      const modelId =
        typeof model === 'string' ? model : (model.modelId ?? 'unknown');
      // A per-workspace (typically non-e5) provider gets no e5-style prefixes.
      return {
        model,
        modelId,
        queryPrefix: '',
        docPrefix: '',
        fingerprint: computeEmbeddingFingerprint({
          modelId,
          revision: 'workspace',
          queryPrefix: '',
          docPrefix: '',
          dimensions: null,
        }),
      };
    } catch (err) {
      if (!(err instanceof AiEmbeddingNotConfiguredException)) throw err;
    }

    // 2. Global env provider (TEI sidecar). TEI is OpenAI-compatible, so reuse
    //    the existing openai path — no new SDK. A dummy key is fine for a
    //    keyless self-hosted sidecar.
    const endpoint = process.env.EMBEDDING_ENDPOINT?.trim();
    const globalModel = process.env.EMBEDDING_MODEL?.trim();
    if (endpoint && globalModel) {
      const model = createOpenAI({
        baseURL: endpoint,
        apiKey: process.env.EMBEDDING_API_KEY || 'unused',
      }).textEmbeddingModel(globalModel);
      const queryPrefix = process.env.EMBEDDING_QUERY_PREFIX ?? '';
      const docPrefix = process.env.EMBEDDING_DOC_PREFIX ?? '';
      const dimRaw = Number(process.env.EMBEDDING_DIMENSIONS);
      const dimensions = Number.isFinite(dimRaw) && dimRaw > 0 ? dimRaw : null;
      return {
        model,
        modelId: globalModel,
        queryPrefix,
        docPrefix,
        fingerprint: computeEmbeddingFingerprint({
          modelId: globalModel,
          revision: process.env.EMBEDDING_REVISION ?? '',
          queryPrefix,
          docPrefix,
          dimensions,
        }),
      };
    }

    // Neither resolved -> drives semantic.reason=no-provider.
    throw new AiEmbeddingNotConfiguredException();
  }

  /**
   * #530: embed a SEARCH QUERY. Resolves the provider, prepends its query prefix,
   * and embeds the single value under its OWN short timeout
   * (SEARCH_EMBED_TIMEOUT_MS, default 800ms) — NOT the long batch-indexing
   * timeout — so a slow/hung sidecar degrades search fast. Throws on
   * timeout/error (the caller degrades to the lexical-only path). Returns the
   * vector plus the fingerprint AND the model id of the provider that produced it
   * (#599: the model id is the key the reader compares against the ACTIVE
   * generation's model to decide whether the two live in the same embedding space
   * — see EmbeddingGenerationService.embedQueryForActiveGeneration).
   */
  async embedQuery(
    workspaceId: string,
    text: string,
  ): Promise<{ vector: number[]; fingerprint: string; modelId: string }> {
    const provider = await this.resolveEmbeddingProvider(workspaceId);
    const [vector] = await this.embedWithModel(
      provider.model,
      workspaceId,
      [provider.queryPrefix + text],
      AiService.searchEmbedTimeoutMs(),
    );
    return {
      vector,
      fingerprint: provider.fingerprint,
      modelId: provider.modelId,
    };
  }

  /**
   * Embed values with an EXPLICIT model, bounded by `timeoutMs` (default: the
   * batch-indexing timeout). Shared core of embedTexts / embedQuery: a slow/hung
   * embeddings endpoint must fail loudly instead of blocking forever. The single
   * signal caps the WHOLE call, including the SDK's internal retries/backoff
   * (embedMany defaults to maxRetries: 2).
   */
  async embedWithModel(
    model: EmbeddingModel,
    workspaceId: string,
    texts: string[],
    timeoutMs: number = AiService.embeddingTimeoutMs(),
  ): Promise<number[][]> {
    if (texts.length === 0) return [];
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const { embeddings } = await embedMany({
        model,
        values: texts,
        abortSignal: signal,
      });
      return embeddings;
    } catch (err) {
      // AbortSignal.timeout aborts with an opaque TimeoutError; surface a clear,
      // greppable message so a hung/slow embeddings endpoint is obvious in logs.
      // Classify by the error itself (name) AND the signal, not the flag alone:
      // a genuine provider error that loses a race with the timer would also see
      // `signal.aborted === true`, and must keep its real diagnostics.
      // Mirror the SDK's own isAbortError (@ai-sdk/provider-utils): it treats
      // TimeoutError, AbortError and ResponseAborted (Next.js) as aborts.
      const abortLike =
        err instanceof Error &&
        (err.name === 'TimeoutError' ||
          err.name === 'AbortError' ||
          err.name === 'ResponseAborted');
      if (signal.aborted && abortLike) {
        throw new Error(
          `Embedding request timed out after ${timeoutMs}ms ` +
            `(workspace ${workspaceId}, ${texts.length} value(s)). ` +
            `Increase the embedding timeout or check the embeddings endpoint.`,
        );
      }
      throw err;
    }
  }

  /**
   * Per-embedding-call timeout in ms. Configurable via AI_EMBEDDING_TIMEOUT_MS;
   * falls back to 120000 (2 min) when unset or invalid.
   */
  private static embeddingTimeoutMs(): number {
    const raw = Number(process.env.AI_EMBEDDING_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
  }

  /**
   * #530: per-call timeout for the interactive SEARCH query embed. Much shorter
   * than the batch-indexing timeout (a search request cannot wait 2 minutes on
   * the sidecar). Configurable via SEARCH_EMBED_TIMEOUT_MS; default 800ms.
   */
  private static searchEmbedTimeoutMs(): number {
    const raw = Number(process.env.SEARCH_EMBED_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 800;
  }

  // Build a tiny valid WAV (mono, 16-bit PCM, 16 kHz, ~1s of silence), used only
  // as a connectivity probe for the STT endpoint in testConnection.
  private static silentWavProbe(): Uint8Array {
    const sampleRate = 16000;
    const numSamples = sampleRate; // ~1 second
    const dataSize = numSamples * 2; // 16-bit mono
    const buf = Buffer.alloc(44 + dataSize);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16); // PCM fmt chunk size
    buf.writeUInt16LE(1, 20); // audio format = PCM
    buf.writeUInt16LE(1, 22); // channels = 1
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
    buf.writeUInt16LE(2, 32); // block align
    buf.writeUInt16LE(16, 34); // bits per sample
    buf.write('data', 36);
    buf.writeUInt32LE(dataSize, 40);
    // The PCM samples stay zero (silence).
    return buf;
  }

  /**
   * Cheap connectivity check for a single "Test endpoint" button. Probes ONLY
   * the requested capability so each card in the UI surfaces its own result:
   *  - `chat`: a one-word generation against the configured chat model;
   *  - `embeddings`: embedding a tiny string against the embedding model;
   *  - `stt`: transcribing a tiny silent WAV against the transcription model.
   *
   * A capability that is not configured returns a plain "… is not configured"
   * message; any real failure returns ok:false with the provider's own cause
   * (statusCode + truncated response body via describeProviderError). The
   * decrypted key is never logged or returned — AI SDK error fields do not carry
   * it, and the resolved config is never dumped.
   *
   * Probing embeddings here catches a misconfigured embeddings endpoint (e.g.
   * one returning non-JSON, which the background RAG indexer would otherwise hit
   * as an opaque "Invalid JSON response") at config time instead of silently
   * during indexing.
   */
  async testConnection(
    workspaceId: string,
    capability: 'chat' | 'embeddings' | 'stt' = 'chat',
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (capability === 'embeddings') {
      try {
        await this.embedTexts(workspaceId, ['ping']);
        return { ok: true };
      } catch (err) {
        if (err instanceof AiEmbeddingNotConfiguredException) {
          return { ok: false, error: 'Embeddings are not configured' };
        }
        this.logger.error('AI embedding test connection failed', err as Error);
        return { ok: false, error: describeProviderError(err) };
      }
    }

    if (capability === 'stt') {
      try {
        // Probe with a tiny silent WAV; a reachable, authorized endpoint returns
        // (usually empty) text, any failure surfaces via describeProviderError.
        await this.transcribe(workspaceId, AiService.silentWavProbe(), 'wav');
        return { ok: true };
      } catch (err) {
        if (err instanceof AiSttNotConfiguredException) {
          return { ok: false, error: 'STT is not configured' };
        }
        this.logger.error('AI STT test connection failed', err as Error);
        return { ok: false, error: describeProviderError(err) };
      }
    }

    // Default: chat probe.
    try {
      const model = await this.getChatModel(workspaceId);
      // maxOutputTokens keeps the probe cheap and avoids providers (e.g.
      // OpenRouter) reserving/charging for the model's full max-token budget,
      // which would 402 on a key with limited credit.
      await generateText({ model, prompt: 'ping', maxOutputTokens: 16 });
      return { ok: true };
    } catch (err) {
      if (err instanceof AiNotConfiguredException) {
        return { ok: false, error: 'Chat is not configured' };
      }
      this.logger.error('AI chat test connection failed', err as Error);
      return { ok: false, error: describeProviderError(err) };
    }
  }
}
