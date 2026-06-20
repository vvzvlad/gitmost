export const AUTH_THROTTLER = 'auth';
export const AI_CHAT_THROTTLER = 'ai-chat';
// IP-keyed throttler for the anonymous public-share AI assistant. There is no
// authenticated user on that route, so it is keyed by client IP (the default
// ThrottlerGuard tracker) to bound anonymous abuse — the workspace owner pays
// for the tokens.
export const PUBLIC_SHARE_AI_THROTTLER = 'public-share-ai';
