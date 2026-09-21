/**
 * Server-side whitelist + limits for POST /api/telemetry/vitals (#355).
 *
 * The endpoint is PUBLIC (browsers post it, no auth) so it is a privacy and
 * abuse surface: everything not on these lists is silently DROPPED and the
 * request still returns 200 (never 400 — a 400 would make browsers retry).
 */

// The only metric names accepted. Anything else is dropped.
export const ALLOWED_METRIC_NAMES = new Set<string>([
  'INP',
  'LCP',
  'CLS',
  'TTFB',
  'editor_tx_ms',
  'page_open_ms',
  'longtask_ms',
  // #563 — page-meta boot-cache counters (hit / miss / evict-on-denied).
  'page_meta_hit',
  'page_meta_miss',
  'page_meta_evict',
  // #639 — offline-mode measurability. `page_open_body_ms` measures time to the
  // first frame REAL body content is painted; `body_paint_timeout` is the
  // survivorship-bias guard (body never painted within the timeout window). Both
  // MUST also be in the client allowlist + union type (vitals.ts) — a name
  // missing from EITHER side is silently dropped. `client_metrics.name` is plain
  // text (no CHECK/enum), so no migration is needed.
  'page_open_body_ms',
  'body_paint_timeout',
  // #683 — single client-perceived / compute operation metric. The specific
  // operation is carried in `attr` (a short op name like `comments_open`,
  // `diagram_mermaid`), which passes the CSS-selector-shaped `attr` charset
  // check below (lowercase letters + `_`). MUST also be in the client allowlist
  // + union type (vitals.ts) — a name missing from EITHER side is dropped.
  'operation_ms',
  // #681 — full keydown→paint editor latency via the Event Timing API (the same
  // source INP uses, but always-on and filtered to editor keydowns). It measures
  // what `editor_tx_ms` is structurally blind to: the React re-render / menu-
  // subscription / floating-ui work that runs AFTER the ProseMirror dispatch.
  // MUST also be in the client allowlist + reportClientMetric union type
  // (vitals.ts) — a name missing from EITHER side is silently dropped (#639).
  'editor_key_latency_ms',
]);

// The only rating values accepted (web-vitals). Anything else -> null.
export const ALLOWED_RATINGS = new Set<string>([
  'good',
  'needs-improvement',
  'poor',
]);

// The ONLY route labels accepted. The endpoint is anonymous, so an un-checked
// `route` is a free-text write surface (arbitrary high-cardinality strings /
// injected text into the metrics table). The client only ever sends a label from
// a finite template dictionary (`templateRoute`), so we drop anything not in it.
//
// PARITY: this MUST mirror `KNOWN_ROUTE_TEMPLATES` in the client's
// `apps/client/src/lib/telemetry/route-template.ts` (the canonical source). A
// drift means legit client routes get dropped — keep the two in lockstep; the
// client self-consistency test asserts `templateRoute` only emits these values.
export const ALLOWED_ROUTE_TEMPLATES = new Set<string>([
  '/',
  'other',
  // Static routes.
  '/home',
  '/spaces',
  '/favorites',
  '/login',
  '/forgot-password',
  '/password-reset',
  '/setup/register',
  '/settings/account/profile',
  '/settings/account/preferences',
  '/settings/workspace',
  '/settings/ai',
  '/settings/members',
  '/settings/groups',
  '/settings/spaces',
  '/settings/sharing',
  // Dynamic templates (slugs/ids are already collapsed to `:param`).
  '/share/:shareId/p/:slug',
  '/share/p/:slug',
  '/share/:shareId',
  '/p/:slug',
  '/s/:space/p/:slug',
  '/s/:space/trash',
  '/s/:space',
  '/labels/:label',
  '/invites/:invitationId',
  '/settings/groups/:groupId',
]);

// `attr` is a web-vitals attribution TARGET: a CSS-selector-ish string (an
// element path like `html>body>div#app>button.cta`), never free prose. Constrain
// it to a conservative CSS-selector charset so the anonymous endpoint cannot be
// used to write arbitrary text / PII / markup into the metrics table. A value
// containing anything outside this set is DROPPED (-> null); the event is kept.
export const ATTR_ALLOWED_CHARSET = /^[A-Za-z0-9#.\-_> :()[\]="'*+~,]+$/;

// Max events accepted per batch; the rest are ignored.
export const MAX_EVENTS_PER_BATCH = 50;

// Defence-in-depth body cap (~16KB). Fastify's global bodyLimit is far larger,
// so we re-check the parsed payload size here and drop oversized batches.
export const MAX_BODY_BYTES = 16 * 1024;

// attr is truncated to this many characters (attribution target only, no PII).
export const MAX_ATTR_LENGTH = 120;

// route label sanity cap (client sends a template like /s/:space/p/:slug).
export const MAX_ROUTE_LENGTH = 200;

// `client_metrics.doc_size` is a Postgres `int` (int4). A garbage/huge docSize
// on a single event would overflow int4 and make Postgres reject the WHOLE
// batch INSERT, losing every event in it. Values outside this range are DROPPED
// to null (the event is still kept) so one bad field never loses the batch.
export const DOC_SIZE_MAX = 2147483647; // 2^31 - 1 (int4 max)

export interface ClientMetricRow {
  name: string;
  value: number;
  rating: string | null;
  route: string | null;
  attr: string | null;
  docSize: number | null;
  workspaceId: string | null;
}

/**
 * Validate + normalise a single incoming event into a DB row, or return null to
 * DROP it. Pure so it is directly unit-testable. Enforces the name whitelist,
 * numeric value, rating whitelist, attr truncation and doc_size (int) coercion.
 */
export function sanitizeVitalEvent(
  raw: unknown,
  workspaceId: string | null,
): ClientMetricRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;

  const name = e.name;
  if (typeof name !== 'string' || !ALLOWED_METRIC_NAMES.has(name)) return null;

  const value =
    typeof e.value === 'number' && Number.isFinite(e.value) ? e.value : null;
  if (value === null) return null;

  const rating =
    typeof e.rating === 'string' && ALLOWED_RATINGS.has(e.rating)
      ? e.rating
      : null;

  // route: accept ONLY a known template label (dictionary check), else drop to
  // null. The length cap stays as a cheap pre-guard before the Set lookup.
  let route: string | null = null;
  if (typeof e.route === 'string' && e.route.length > 0) {
    const candidate = e.route.slice(0, MAX_ROUTE_LENGTH);
    route = ALLOWED_ROUTE_TEMPLATES.has(candidate) ? candidate : null;
  }

  // attr: truncate, then accept ONLY if it is a CSS-selector-shaped string
  // (charset whitelist); anything with characters outside the set is dropped.
  let attr: string | null = null;
  if (typeof e.attr === 'string' && e.attr.length > 0) {
    const candidate = e.attr.slice(0, MAX_ATTR_LENGTH);
    attr = ATTR_ALLOWED_CHARSET.test(candidate) ? candidate : null;
  }

  let docSize: number | null = null;
  if (typeof e.docSize === 'number' && Number.isFinite(e.docSize)) {
    docSize = Math.trunc(e.docSize);
  } else if (typeof e.doc_size === 'number' && Number.isFinite(e.doc_size)) {
    // Accept snake_case too, in case a client sends the raw column name.
    docSize = Math.trunc(e.doc_size as number);
  }
  // Guard the int4 column: an out-of-range docSize would overflow int4 and make
  // Postgres reject the whole batch INSERT. Drop the field (keep the event)
  // rather than lose every other event in the batch.
  if (docSize !== null && (docSize < 0 || docSize > DOC_SIZE_MAX)) {
    docSize = null;
  }

  return { name, value, rating, route, attr, docSize, workspaceId };
}
