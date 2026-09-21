/**
 * Map a raw pathname to a BOUNDED route TEMPLATE (#355).
 *
 * Perf metrics must be labelled by route template only — never a raw path with
 * slugs/ids — so the server-side `route` column and any downstream aggregation
 * stay low-cardinality and carry NO page slugs/titles (privacy). Anything that
 * does not match a known pattern collapses to `other`.
 *
 * The template vocabulary mirrors the issue's example (`/s/:space/p/:slug`).
 */
const ROUTE_PATTERNS: { re: RegExp; template: string }[] = [
  // Share pages (public).
  { re: /^\/share\/[^/]+\/p\/[^/]+$/, template: '/share/:shareId/p/:slug' },
  { re: /^\/share\/p\/[^/]+$/, template: '/share/p/:slug' },
  { re: /^\/share\/[^/]+$/, template: '/share/:shareId' },
  // Page redirect.
  { re: /^\/p\/[^/]+$/, template: '/p/:slug' },
  // Space + page.
  { re: /^\/s\/[^/]+\/p\/[^/]+$/, template: '/s/:space/p/:slug' },
  { re: /^\/s\/[^/]+\/trash$/, template: '/s/:space/trash' },
  { re: /^\/s\/[^/]+$/, template: '/s/:space' },
  // Misc dynamic.
  { re: /^\/labels\/[^/]+$/, template: '/labels/:label' },
  { re: /^\/invites\/[^/]+$/, template: '/invites/:invitationId' },
  { re: /^\/settings\/groups\/[^/]+$/, template: '/settings/groups/:groupId' },
];

// Static routes we accept verbatim (finite set).
const STATIC_ROUTES = new Set<string>([
  '/home',
  '/spaces',
  '/favorites',
  '/login',
  '/forgot-password',
  '/password-reset',
  '/setup/register',
  '/settings/account/profile',
  '/settings/account/preferences',
  '/settings/account/api-keys',
  '/settings/workspace',
  '/settings/ai',
  '/settings/members',
  '/settings/groups',
  '/settings/spaces',
  '/settings/sharing',
]);

/**
 * The COMPLETE, finite vocabulary `templateRoute` can ever emit: the two
 * synthetic labels (`/` and `other`), the static routes, and the dynamic
 * templates. Exported so the public `/api/telemetry/vitals` endpoint can reject
 * any `route` outside this dictionary server-side (the endpoint is anonymous, so
 * an un-checked `route` is a free-text write surface). The server keeps a mirror
 * (`ALLOWED_ROUTE_TEMPLATES` in client-metrics.constants.ts) — this is the
 * canonical source; keep them in lockstep.
 */
export const KNOWN_ROUTE_TEMPLATES: ReadonlySet<string> = new Set<string>([
  '/',
  'other',
  ...STATIC_ROUTES,
  ...ROUTE_PATTERNS.map((p) => p.template),
]);

export function templateRoute(pathname: string): string {
  // Normalise a trailing slash (except root).
  const path =
    pathname.length > 1 && pathname.endsWith('/')
      ? pathname.slice(0, -1)
      : pathname;

  if (path === '' || path === '/') return '/';
  if (STATIC_ROUTES.has(path)) return path;

  for (const { re, template } of ROUTE_PATTERNS) {
    if (re.test(path)) return template;
  }
  return 'other';
}

/** Template for the current window location. */
export function currentRouteTemplate(): string {
  try {
    return templateRoute(window.location.pathname);
  } catch {
    return 'other';
  }
}
