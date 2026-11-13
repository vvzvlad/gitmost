export const AUTH_THROTTLER = 'auth';
export const AI_CHAT_THROTTLER = 'ai-chat';
export const PAGE_TEMPLATE_THROTTLER = 'page-template';
// IP-keyed throttler for the anonymous public-share AI assistant. There is no
// authenticated user on that route, so it is keyed by client IP (the default
// ThrottlerGuard tracker) to bound anonymous abuse — the workspace owner pays
// for the tokens.
export const PUBLIC_SHARE_AI_THROTTLER = 'public-share-ai';
// IP-keyed throttler for the anonymous client perf-telemetry sink
// (POST /api/telemetry/vitals). Browsers batch metrics, so the limit is
// generous; it only exists to bound abuse of the public, unauthenticated route.
export const VITALS_THROTTLER = 'vitals';

// Every named throttler of the app with its default limit. ThrottlerGuard
// applies ALL of them to every guarded route, so a route limited by one bucket
// uses ThrottleOnly (throttle-only.decorator.ts), which skips the others.
export const THROTTLERS = [
  { name: AUTH_THROTTLER, ttl: 60_000, limit: 10 },
  { name: AI_CHAT_THROTTLER, ttl: 60_000, limit: 25 },
  // Whole-page template lookup returns full ProseMirror docs for up to 50 ids
  // per call and the embed depth cap is client-side only, so a scripted client
  // could drive heavy content fan-out. 30 req/min per user is plenty for
  // legitimate render-time batched lookups.
  { name: PAGE_TEMPLATE_THROTTLER, ttl: 60_000, limit: 30 },
  // Anonymous public-share assistant: ~5 req/min per IP.
  { name: PUBLIC_SHARE_AI_THROTTLER, ttl: 60_000, limit: 5 },
  // Anonymous client perf-telemetry sink: 120 batched posts/min per IP.
  { name: VITALS_THROTTLER, ttl: 60_000, limit: 120 },
];
