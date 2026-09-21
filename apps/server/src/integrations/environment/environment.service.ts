import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import ms, { StringValue } from 'ms';

@Injectable()
export class EnvironmentService {
  private readonly logger = new Logger(EnvironmentService.name);
  // Env keys already warned about for an invalid value (one-shot per key, so a
  // bad SANDBOX_* value is not logged on every blob put). Mirrors the original
  // sandboxTtlWarned guard, generalized across the TTL + the three byte caps.
  private readonly invalidPositiveIntWarned = new Set<string>();

  constructor(private configService: ConfigService) {}

  getNodeEnv(): string {
    return this.configService.get<string>('NODE_ENV', 'development');
  }

  isDevelopment(): boolean {
    return this.getNodeEnv() === 'development';
  }

  getAppUrl(): string {
    const rawUrl =
      this.configService.get<string>('APP_URL') ||
      `http://localhost:${this.getPort()}`;

    const { origin } = new URL(rawUrl);
    return origin;
  }

  isHttps(): boolean {
    const appUrl = this.configService.get<string>('APP_URL');
    try {
      const url = new URL(appUrl);
      return url.protocol === 'https:';
    } catch (error) {
      return false;
    }
  }

  getSubdomainHost(): string {
    return this.configService.get<string>('SUBDOMAIN_HOST');
  }

  getPort(): number {
    return parseInt(this.configService.get<string>('PORT', '3000'));
  }

  getAppSecret(): string {
    return this.configService.get<string>('APP_SECRET');
  }

  getDatabaseURL(): string {
    return this.configService.get<string>('DATABASE_URL');
  }

  getDatabaseMaxPool(): number {
    return parseInt(this.configService.get<string>('DATABASE_MAX_POOL', '10'));
  }

  getRedisUrl(): string {
    return this.configService.get<string>(
      'REDIS_URL',
      'redis://localhost:6379',
    );
  }

  getJwtTokenExpiresIn(): string {
    return this.configService.get<string>('JWT_TOKEN_EXPIRES_IN', '90d');
  }

  getCookieExpiresIn(): Date {
    const expiresInStr = this.getJwtTokenExpiresIn();
    let msUntilExpiry: number;
    try {
      msUntilExpiry = ms(expiresInStr as StringValue);
    } catch (err) {
      msUntilExpiry = ms('90d');
    }
    return new Date(Date.now() + msUntilExpiry);
  }

  getGotenbergUrl(): string | undefined {
    return this.configService.get<string>('GOTENBERG_URL');
  }

  getStorageDriver(): string {
    return this.configService.get<string>('STORAGE_DRIVER', 'local');
  }

  getFileUploadSizeLimit(): string {
    return this.configService.get<string>('FILE_UPLOAD_SIZE_LIMIT', '50mb');
  }

  getFileImportSizeLimit(): string {
    return this.configService.get<string>('FILE_IMPORT_SIZE_LIMIT', '200mb');
  }

  getAwsS3AccessKeyId(): string {
    return this.configService.get<string>('AWS_S3_ACCESS_KEY_ID');
  }

  getAwsS3SecretAccessKey(): string {
    return this.configService.get<string>('AWS_S3_SECRET_ACCESS_KEY');
  }

  getAwsS3Region(): string {
    return this.configService.get<string>('AWS_S3_REGION');
  }

  getAwsS3Bucket(): string {
    return this.configService.get<string>('AWS_S3_BUCKET');
  }

  getAwsS3Endpoint(): string {
    return this.configService.get<string>('AWS_S3_ENDPOINT');
  }

  getAwsS3ForcePathStyle(): boolean {
    const forcePathStyle = this.configService
      .get<string>('AWS_S3_FORCE_PATH_STYLE', 'false')
      .toLowerCase();
    return forcePathStyle === 'true';
  }

  getAwsS3Url(): string {
    return this.configService.get<string>('AWS_S3_URL');
  }

  getAzureStorageAccountName(): string {
    return this.configService.get<string>('AZURE_STORAGE_ACCOUNT_NAME');
  }

  getAzureStorageContainer(): string {
    return this.configService.get<string>('AZURE_STORAGE_CONTAINER');
  }

  getAzureStorageAccountKey(): string {
    return this.configService.get<string>('AZURE_STORAGE_ACCOUNT_KEY');
  }

  getAzureStorageEndpoint(): string {
    return this.configService.get<string>('AZURE_STORAGE_ENDPOINT');
  }

  getAzureStorageUrl(): string {
    return this.configService.get<string>('AZURE_STORAGE_URL');
  }

  getMailDriver(): string {
    return this.configService.get<string>('MAIL_DRIVER', 'log');
  }

  getMailFromAddress(): string {
    return this.configService.get<string>('MAIL_FROM_ADDRESS');
  }

  getMailFromName(): string {
    return this.configService.get<string>('MAIL_FROM_NAME', 'Docmost');
  }

  getMailBlockedRecipientDomains(): string[] {
    const raw = this.configService.get<string>(
      'MAIL_BLOCKED_RECIPIENT_DOMAINS',
      '',
    );
    return raw
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
  }

  getSmtpHost(): string {
    return this.configService.get<string>('SMTP_HOST');
  }

  getSmtpPort(): number {
    return parseInt(this.configService.get<string>('SMTP_PORT'));
  }

  getSmtpSecure(): boolean {
    const secure = this.configService
      .get<string>('SMTP_SECURE', 'false')
      .toLowerCase();
    return secure === 'true';
  }

  getSmtpIgnoreTLS(): boolean {
    const ignoretls = this.configService
      .get<string>('SMTP_IGNORETLS', 'false')
      .toLowerCase();
    return ignoretls === 'true';
  }

  getSmtpUsername(): string {
    return this.configService.get<string>('SMTP_USERNAME');
  }

  getSmtpPassword(): string {
    return this.configService.get<string>('SMTP_PASSWORD');
  }

  getPostmarkToken(): string {
    return this.configService.get<string>('POSTMARK_TOKEN');
  }

  getDrawioUrl(): string {
    return this.configService.get<string>('DRAWIO_URL');
  }

  isCloud(): boolean {
    const cloudConfig = this.configService
      .get<string>('CLOUD', 'false')
      .toLowerCase();
    return cloudConfig === 'true';
  }

  isSelfHosted(): boolean {
    return !this.isCloud();
  }

  isCompactPageTreeEnabled(): boolean {
    const compactTree = this.configService
      .get<string>('COMPACT_PAGE_TREE', 'true')
      .toLowerCase();
    return compactTree === 'true';
  }

  /**
   * Operator toggle for the public client-telemetry sink (#355). DEFAULT OFF:
   * the unauthenticated POST /api/telemetry/vitals endpoint + client vitals
   * collection are only wired when this is explicitly true. Kept SEPARATE from
   * METRICS_PORT (the server Prometheus half) because Grafana reads the
   * `client_metrics` table directly, independent of the scrape port — and
   * because `client_metrics` has no app-side retention, so an operator must opt
   * in and run an external pruner.
   */
  isClientTelemetryEnabled(): boolean {
    const enabled = this.configService
      .get<string>('CLIENT_TELEMETRY_ENABLED', 'false')
      .toLowerCase();
    return enabled === 'true';
  }

  /**
   * Operator toggle for the local-first page boot cache (#563). DEFAULT OFF:
   * mirrored into window.CONFIG so the client only persists/restores the
   * localStorage page-meta cache when the operator opts in. Off => the client
   * keeps today's behavior (skeleton until the page query resolves).
   */
  isLocalFirstEnabled(): boolean {
    const enabled = this.configService
      .get<string>('LOCAL_FIRST_ENABLED', 'false')
      .toLowerCase();
    return enabled === 'true';
  }

  /**
   * #640 — network-independent session boundary. Mirrored into window.CONFIG so
   * the client refuses to draw ANY local content (chrome, tree, ydoc body) once
   * more than this has elapsed since the last successful `/me`, even offline.
   * Defaults to JWT_TOKEN_EXPIRES_IN (the server treats the session dead after
   * that anyway), overridable via OFFLINE_GRACE. Returned as the raw duration
   * string (e.g. "30d"); the client parses it.
   */
  getOfflineGrace(): string {
    return this.configService.get<string>(
      'OFFLINE_GRACE',
      this.getJwtTokenExpiresIn(),
    );
  }

  /**
   * #629 — mirrored into window.CONFIG so the draw.io editor only embeds a PNG
   * raster into the saved .drawio.svg when the operator opts in. Off (default)
   * => today's behavior (svg-only save), so the file-size cost of the embedded
   * raster is instantly reversible. Gates GENERATION only; consumption of an
   * already-embedded raster is unconditional.
   */
  isDrawioRasterEnabled(): boolean {
    const enabled = this.configService
      .get<string>('DRAWIO_RASTER_ENABLED', 'false')
      .toLowerCase();
    return enabled === 'true';
  }

  /**
   * #632 — mirrored into window.CONFIG so the Excalidraw editor only embeds a PNG
   * raster into the saved .excalidraw.svg when the operator opts in (symmetric to
   * isDrawioRasterEnabled). Off (default) => today's svg-only save (byte-
   * identical), so the file-size cost is instantly reversible. Gates GENERATION
   * only; consumption of an already-embedded raster is unconditional.
   */
  isExcalidrawRasterEnabled(): boolean {
    const enabled = this.configService
      .get<string>('EXCALIDRAW_RASTER_ENABLED', 'false')
      .toLowerCase();
    return enabled === 'true';
  }

  getStripePublishableKey(): string {
    return this.configService.get<string>('STRIPE_PUBLISHABLE_KEY');
  }

  getStripeSecretKey(): string {
    return this.configService.get<string>('STRIPE_SECRET_KEY');
  }

  getStripeWebhookSecret(): string {
    return this.configService.get<string>('STRIPE_WEBHOOK_SECRET');
  }

  getBillingTrialDays(): number {
    return parseInt(this.configService.get<string>('BILLING_TRIAL_DAYS', '14'));
  }

  getCollabUrl(): string {
    return this.configService.get<string>('COLLAB_URL');
  }

  isCollabDisableRedis(): boolean {
    const isStandalone = this.configService
      .get<string>('COLLAB_DISABLE_REDIS', 'false')
      .toLowerCase();
    return isStandalone === 'true';
  }

  isDisableTelemetry(): boolean {
    const disable = this.configService
      .get<string>('DISABLE_TELEMETRY', 'false')
      .toLowerCase();
    return disable === 'true';
  }

  /**
   * Deferred tool loading for the in-app AI chat (#332). When enabled, the agent
   * sees a compact <tool_catalog> and only CORE tools + the loadTools meta-tool
   * are active each step; deferred tools (the fat/rare ones + all external MCP
   * tools) load on demand. Defaults to ENABLED — the issue treats deferred
   * loading as the new behavior; set AI_CHAT_DEFERRED_TOOLS=false to restore the
   * old "all tools always active" behavior.
   */
  isAiChatDeferredToolsEnabled(): boolean {
    const enabled = this.configService
      .get<string>('AI_CHAT_DEFERRED_TOOLS', 'true')
      .toLowerCase();
    return enabled === 'true';
  }

  /**
   * Final-step lockdown for the in-app agent loop (#444). When ON (legacy), the
   * LAST allowed step forces a text-only answer: tools are stripped
   * (toolChoice:'none') and a synthesis instruction is appended. Defaults to OFF:
   * stripping the tools mid-work triggered a token-loop degeneration incident
   * (the model, robbed of its tools on the final step, emitted a 255KB block
   * repeating a single token). With the toggle OFF the last step keeps its tools
   * and gets only a SOFT nudge to finish with a text summary; the universal
   * anti-babble guard is the token-degeneration detector instead. Enable this
   * only for a model that does NOT reliably end its turns with a text answer.
   */
  isAiChatFinalStepLockdownEnabled(): boolean {
    const enabled = this.configService
      .get<string>('AI_CHAT_FINAL_STEP_LOCKDOWN', 'false')
      .toLowerCase();
    return enabled === 'true';
  }

  /**
   * In-app AI-chat `viewImage` vision tool (#588, Phase B of #585). When enabled,
   * the agent gains a read-only `viewImage({pageId, node})` tool that delivers a
   * node's image to the model AS VISION on any provider: raster images
   * (png/jpeg/webp/gif) pass through as-is, SVG / draw.io diagrams are rasterized
   * to PNG (Phase A #586). Defaults to OFF (fail-closed): with the flag off the
   * tool is not registered and the per-step image injection never runs, so the
   * agent surface is byte-identical to before. Set AI_CHAT_VIEW_IMAGE=true to
   * enable. The public-share chat toolset (`forShare`) never gets this tool.
   */
  isAiChatViewImageEnabled(): boolean {
    const enabled = this.configService
      .get<string>('AI_CHAT_VIEW_IMAGE', 'false')
      .toLowerCase();
    return enabled === 'true';
  }

  /**
   * Kill-switch for personal external MCP servers (#686). When enabled (the
   * default), members may attach their OWN external MCP servers via
   * `account/mcp-servers`, and the agent's toolset unions the workspace-admin
   * servers with the calling user's personal ones. Defaults to ENABLED — the
   * feature ships on. This is a SANCTIONED kill-switch, NOT a rollout fork:
   * flip MCP_PERSONAL_SERVERS_ENABLED=false to disable the personal CRUD API
   * (the account endpoints answer 403) and drop personal rows from the agent
   * union, without a code revert. Kept as an explicit ENABLED flag rather than
   * a MAX=0 because getMcpPersonalServersMax discards <=0 (so a 0 cap cannot
   * disable the feature).
   */
  isMcpPersonalServersEnabled(): boolean {
    const enabled = this.configService
      .get<string>('MCP_PERSONAL_SERVERS_ENABLED', 'true')
      .toLowerCase();
    return enabled === 'true';
  }

  /**
   * Per-user cap on personal external MCP servers (#686). A member may create
   * at most this many personal servers in a workspace; the personal-create path
   * takes a row lock, counts the user's existing rows, and rejects at the cap.
   * Defaults to 10. A non-integer or <= 0 value falls back to the default (see
   * getPositiveIntEnv), so the cap can never be disabled to 0 here — use
   * MCP_PERSONAL_SERVERS_ENABLED=false to turn the feature off entirely.
   */
  getMcpPersonalServersMax(): number {
    return this.getPositiveIntEnv('MCP_PERSONAL_SERVERS_MAX', 10);
  }

  /**
   * Resumable SSE transport for durable agent runs (#184 phase 1.5). When
   * enabled, a run tees its SSE frames into the in-memory run-stream registry so
   * a late/reloaded tab can attach (replay + live tail) via
   * `GET /ai-chat/runs/:chatId/stream`. Defaults to DISABLED: PR 1 ships the
   * server code dormant — with the flag off, `open`/`bind`/`generateMessageId`
   * are never called and attach always answers 204, so the legacy and #184
   * phase-1 wire paths stay byte-for-byte identical. Set
   * AI_CHAT_RESUMABLE_STREAM=true to activate it (paired with the PR 2 client).
   */
  isAiChatResumableStreamEnabled(): boolean {
    const enabled = this.configService
      .get<string>('AI_CHAT_RESUMABLE_STREAM', 'false')
      .toLowerCase();
    return enabled === 'true';
  }

  getPostHogHost(): string {
    return this.configService.get<string>('POSTHOG_HOST');
  }

  getPostHogKey(): string {
    return this.configService.get<string>('POSTHOG_KEY');
  }

  getSearchDriver(): string {
    return this.configService
      .get<string>('SEARCH_DRIVER', 'database')
      .toLowerCase();
  }

  getTypesenseUrl(): string {
    return this.configService
      .get<string>('TYPESENSE_URL', 'http://localhost:8108')
      .toLowerCase();
  }

  getTypesenseApiKey(): string {
    return this.configService.get<string>('TYPESENSE_API_KEY');
  }

  getTypesenseLocale(): string {
    return this.configService
      .get<string>('TYPESENSE_LOCALE', 'en')
      .toLowerCase();
  }

  // NOTE: AI_*/OPENAI_*/GEMINI_*/OLLAMA_* env getters were removed (D8/§14[M3]):
  // provider/model/key config now lives solely in workspace settings +
  // ai_provider_credentials, with no env fallback. APP_SECRET stays (getAppSecret).

  getAiAgentRolesCatalogSource(): string {
    // Catalog location: an http(s):// base URL the catalog is fetched from.
    // The image ships a per-branch default for this baked in at build time
    // (Dockerfile ARG AI_AGENT_ROLES_CATALOG_URL, set per-branch in CI), but it
    // is overridable at runtime via the env var (this getter returns that
    // runtime value). Local-filesystem sources are no longer supported.
    // Empty/unset => the catalog is unavailable (the provider returns 502).
    // This is INFRA config (where the catalog lives), not provider/model
    // config, so an env var is appropriate.
    return this.configService.get<string>('AI_AGENT_ROLES_CATALOG_URL', '');
  }

  getEventStoreDriver(): string {
    return this.configService
      .get<string>('EVENT_STORE_DRIVER', 'postgres')
      .toLowerCase();
  }

  getClickHouseUrl(): string {
    return this.configService.get<string>('CLICKHOUSE_URL');
  }

  getSamlDisableRequestedAuthnContext(): boolean {
    const disabled = this.configService
      .get<string>('SAML_DISABLE_REQUESTED_AUTHN_CONTEXT', 'false')
      .toLowerCase();
    return disabled === 'true';
  }

  isIframeEmbedAllowed(): boolean {
    const allowed = this.configService
      .get<string>('IFRAME_EMBED_ALLOWED', 'false')
      .toLowerCase();
    return allowed === 'true';
  }

  getIframeAllowedOrigins(): string[] {
    const raw = this.configService.get<string>('IFRAME_ALLOWED_ORIGINS', '');
    return raw
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
  }

  // --- Blob sandbox (in-RAM ephemeral blob transfer; see SandboxModule) ---

  // Base URL the sandbox `uri` is built from. It MUST be reachable over the
  // network by the external consumer that fetches the blobs (not a loopback
  // address if that consumer is remote). Falls back to APP_URL when unset so a
  // single-host deployment works out of the box; set it explicitly when the
  // consumer lives on another host.
  getSandboxPublicUrl(): string {
    const raw =
      this.configService.get<string>('SANDBOX_PUBLIC_URL') || this.getAppUrl();
    // Drop any trailing slash so `${base}/api/sb/${id}` never doubles up.
    return raw.replace(/\/+$/, '');
  }

  // Parse a REQUIRED positive-integer env (TTL in ms or a byte cap). A
  // non-integer or <= 0 value would break the sandbox silently (instant expiry,
  // or every put failing against a 0-byte cap), so warn once and fall back to
  // the default instead. Blob bodies are never logged.
  private getPositiveIntEnv(key: string, def: number): number {
    const parsed = parseInt(
      this.configService.get<string>(key, String(def)),
      10,
    );
    if (!Number.isInteger(parsed) || parsed <= 0) {
      if (!this.invalidPositiveIntWarned.has(key)) {
        this.invalidPositiveIntWarned.add(key);
        this.logger.warn(
          `Invalid ${key} (must be a positive integer); falling back to the ${def} default`,
        );
      }
      return def;
    }
    return parsed;
  }

  // Blob time-to-live. Default 1h. The unguessable UUID + this short TTL + TLS
  // are the whole capability model (no tokens). A non-positive or non-integer
  // value would make every blob expire instantly (silent 404s), so reject it and
  // fall back to the 1h default (warned about once to avoid per-put log spam).
  getSandboxTtlMs(): number {
    return this.getPositiveIntEnv('SANDBOX_TTL_MS', 3_600_000);
  }

  // Per-blob cap for non-image blobs (the serialized document). Default 8 MiB.
  getSandboxMaxBytes(): number {
    return this.getPositiveIntEnv('SANDBOX_MAX_BYTES', 8_388_608);
  }

  // Per-blob cap for mirrored image blobs. Default 20 MiB.
  getSandboxMaxImageBytes(): number {
    return this.getPositiveIntEnv('SANDBOX_MAX_IMAGE_BYTES', 20_971_520);
  }

  // RAM guard: total bytes the whole store may hold. Default 128 MiB. On
  // overflow the store evicts oldest entries to make room.
  getSandboxMaxTotalBytes(): number {
    return this.getPositiveIntEnv('SANDBOX_MAX_TOTAL_BYTES', 134_217_728);
  }
}
