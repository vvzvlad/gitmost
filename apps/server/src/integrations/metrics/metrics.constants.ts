/**
 * Perf-metrics contract (#355). These names/labels are FIXED by the already
 * deployed scrape+dashboard infra (VictoriaMetrics scraping docmost:9464,
 * Grafana dashboards, alerts). Do NOT rename them.
 *
 * #402 extends the #355 table with the collab-lifecycle + MCP-tool families
 * (grouped below). These are the fixed contract from #402; same "do not rename"
 * rule applies. Server-side families land in Pass 1; the MCP-tool histogram is
 * fed by the MCP callback in a later pass but its NAME is fixed here now.
 */
export const METRIC_HTTP_REQUEST_DURATION = 'http_request_duration_seconds';
export const METRIC_DB_QUERY_DURATION = 'db_query_duration_seconds';
export const METRIC_BULLMQ_QUEUE_DEPTH = 'bullmq_queue_depth';
export const METRIC_BULLMQ_JOB_DURATION = 'bullmq_job_duration_seconds';
export const METRIC_COLLAB_STORE_DURATION = 'collab_store_duration_seconds';

// #402 additions — collaboration lifecycle + MCP tool timing.
export const METRIC_COLLAB_LOAD_DURATION = 'collab_doc_load_duration_seconds';
export const METRIC_COLLAB_DOCS_OPEN = 'collab_docs_open';
export const METRIC_COLLAB_DOC_LOADS_TOTAL = 'collab_doc_loads_total';
export const METRIC_COLLAB_DOC_UNLOADS_TOTAL = 'collab_doc_unloads_total';
export const METRIC_COLLAB_CONNECT_DURATION = 'collab_connect_duration_seconds';
export const METRIC_COLLAB_CONNECT_TIMEOUTS_TOTAL =
  'collab_connect_timeouts_total';
export const METRIC_COLLAB_AUTH_DURATION = 'collab_auth_duration_seconds';
export const METRIC_MCP_TOOL_DURATION = 'mcp_tool_duration_seconds';

// #479 — getPage PM→Markdown conversion cache hit/miss counters. Emitted by the
// MCP package via its dependency-neutral onMetric sink and routed onto these two
// prom counters by the mcp.service onMetric callback; a >50% hit-rate is the
// success signal for the getPage perf work. Same "do not rename" contract.
export const METRIC_MCP_GETPAGE_CACHE_HITS_TOTAL =
  'mcp_getpage_cache_hits_total';
export const METRIC_MCP_GETPAGE_CACHE_MISSES_TOTAL =
  'mcp_getpage_cache_misses_total';

// #613 — downloadFile volume. The MCP package meters the BYTES it reads over the
// authenticated loopback for every successful downloadFile (its onMetric sink),
// and the mcp.service router adds them to this counter, labelled by the tool that
// read them. Access itself stays inside the service account's CASL scope, but the
// VOLUME an external agent pulls out is otherwise invisible to the operator; this
// is the signal a bulk export shows up in. The `tool` label is registration-derived
// (bounded cardinality). Same "do not rename" contract.
export const METRIC_MCP_DOWNLOAD_BYTES_TOTAL = 'mcp_download_bytes_total';

// #654 — MCP read-your-own-writes (RYOW) freshness signals emitted by the
// @docmost/mcp package's onMetric sink after a structural read that requested
// the live doc. live = got the live collab doc; dbrow = fell back to the
// (possibly stale) DB row, labelled by the bounded fallback reason; expired =
// the client's RYOW window had lapsed so no preferLive hint was even sent.
// routeMcpMetric routes each onto these counters so the freshness/degradation
// is visible on /metrics (a package metric with no branch is DISCARDED). Same
// "do not rename" contract.
export const METRIC_MCP_RYOW_LIVE_TOTAL = 'mcp_ryow_live_total';
export const METRIC_MCP_RYOW_DBROW_TOTAL = 'mcp_ryow_dbrow_total';
export const METRIC_MCP_RYOW_EXPIRED_TOTAL = 'mcp_ryow_expired_total';

// #558 — api-key auth denial observability. Every DEFINITE deny in
// ApiKeyService.validate (shared by REST jwt.strategy and the /mcp Bearer path)
// increments this counter, labelled by the BOUNDED deny reason. It replaces the
// visibility the deleted /mcp Basic brute-force limiter used to give: a
// revoked/dead key hammering /mcp is otherwise totally silent (validate throws a
// bare 401 with no log/metric). The `reason` label is a fixed, low-cardinality
// set (see ApiKeyDenyReason); the apiKeyId is NEVER a label (it goes only into
// the rate-limited WARN, after the JWT signature is verified). Same "do not
// rename" contract as the other families.
export const METRIC_API_KEY_AUTH_DENIED_TOTAL = 'api_key_auth_denied_total';

// #665 — page->chat binding-skip observability. Almost every "did not write the
// binding" outcome is a 200 (page unresolved, chat not owned, chat deleted, or a
// best-effort birth-bind failure), indistinguishable from success in the HTTP
// histogram. Each such skip increments this counter, labelled by its BOUNDED
// reason (see the AiChatBindSkipReason set) — never free-form input — so the label
// cardinality stays bounded. Paired with a WARN, which is the PRIMARY channel
// because this counter is a no-op unless METRICS_PORT is set. Same "do not rename"
// contract as the other families.
export const METRIC_AI_CHAT_BIND_SKIPPED_TOTAL = 'ai_chat_bind_skipped_total';

// #686 — external-MCP connect-failure observability. Every enabled external MCP
// server that FAILS to connect (or whose auth headers are unreadable) during an
// agent turn's toolset build increments this counter, labelled by the OWNERSHIP
// LEVEL of the failing server: `admin` (a workspace-managed row, user_id IS NULL)
// or `personal` (a member-owned row). The `level` label is a fixed 2-value set —
// never free-form input — so cardinality stays bounded. This is the operator's
// signal that a whole class of external tools (e.g. every user's personal Tavily,
// or the admin web-search server) has silently gone dark. Same "do not rename"
// contract as the other families.
export const METRIC_AI_EXTERNAL_MCP_CONNECT_FAILURES_TOTAL =
  'ai_external_mcp_connect_failures_total';

// Histogram buckets (seconds). Chosen to give useful p50/p95/p99 resolution
// for typical web/DB latencies without exploding series cardinality.
export const HTTP_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];
export const DB_BUCKETS = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5,
];
export const COLLAB_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5,
];
export const JOB_BUCKETS = [
  0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120,
];
// #402 — MCP tool-call latency. Same shape as COLLAB_BUCKETS but stretched to
// 10s at the top: an MCP tool round-trip (LLM-driven doc ops) can be slower
// than a single collab store, so keep resolution out to 10s.
export const MCP_TOOL_BUCKETS = [
  0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

/**
 * Extract the first SQL token (select/insert/update/delete/...) from a query,
 * lower-cased, to use as a BOUNDED label for db_query_duration_seconds. Using
 * the full query text would blow up label cardinality; the leading keyword is a
 * finite set. Unknown/empty queries collapse to `other`.
 */
// The bounded set of SQL leading keywords used as db_query_duration_seconds
// labels. Module-const so it is built ONCE, not per query (this runs on every DB
// query when metrics are enabled).
const KNOWN_SQL_TOKENS = new Set([
  'select',
  'insert',
  'update',
  'delete',
  'with',
  'begin',
  'commit',
  'rollback',
  'alter',
  'create',
  'drop',
  'truncate',
  'explain',
]);

export function firstSqlToken(sql: string | undefined): string {
  if (!sql) return 'other';
  // Skip leading whitespace / comments and grab the first word.
  const match = /^[\s(]*([a-zA-Z]+)/.exec(sql);
  if (!match) return 'other';
  const token = match[1].toLowerCase();
  return KNOWN_SQL_TOKENS.has(token) ? token : 'other';
}

/**
 * #402 — bucket a document byte size into ONE of four fixed labels for the
 * collab load/store histograms' `size_bucket` label. Using the raw byte count
 * would be a continuous, unbounded label; four coarse buckets keep series
 * cardinality bounded (each of collab_doc_load / collab_store gets ×4 series).
 *
 * The SAME function is shared by both the load and store paths so their buckets
 * can never drift apart. Non-finite / negative sizes collapse to the smallest
 * bucket ('lt64k') as a safe default (they can't be legitimately huge and we
 * must never throw here — this runs on every store/load when metrics are on).
 */
// Module-const thresholds, built once (not per observe).
const SIZE_THRESHOLDS = { lt64k: 65536, lt256k: 262144, lt1m: 1048576 } as const;

export function sizeBucket(
  bytes: number | undefined | null,
): 'lt64k' | 'lt256k' | 'lt1m' | 'ge1m' {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return 'lt64k';
  if (bytes < SIZE_THRESHOLDS.lt64k) return 'lt64k';
  if (bytes < SIZE_THRESHOLDS.lt256k) return 'lt256k';
  if (bytes < SIZE_THRESHOLDS.lt1m) return 'lt1m';
  return 'ge1m';
}

/**
 * Whether an HTTP response must be EXCLUDED from http_request_duration_seconds.
 *
 * SSE/streaming responses (the AI-chat `text/event-stream`) keep the connection
 * open for the whole conversation, so Fastify's onResponse fires only when the
 * client disconnects — recording the connection lifetime, not a response time,
 * which would poison p95/p99. We skip by content-type (authoritative) with a
 * route-suffix fallback for the two known stream endpoints.
 */
export function isStreamingResponse(
  contentType: unknown,
  route: string | undefined,
): boolean {
  if (
    typeof contentType === 'string' &&
    contentType.toLowerCase().includes('text/event-stream')
  ) {
    return true;
  }
  // Fallback: the AI-chat stream routes (/api/ai-chat/stream,
  // /api/shares/ai/stream) both end in `/stream`.
  if (route && route.endsWith('/stream')) return true;
  return false;
}
