export const CacheKey = {
  LICENSE_VALID: (workspaceId: string) => `license:valid:${workspaceId}`,
  SPACE_ROLES: (userId: string, spaceId: string) =>
    `perm:space-roles:${userId}:${spaceId}`,
  PAGE_CAN_EDIT: (userId: string, pageId: string) =>
    `perm:can-edit:${userId}:${pageId}`,
  // #348 — DomainMiddleware workspace resolution. Self-hosted resolves the single
  // workspace (constant key); cloud resolves by the request subdomain (lowercased
  // to match the case-insensitive `LOWER(hostname)` lookup). Every WorkspaceRepo
  // mutator busts these, so staleness is bounded by both explicit invalidation and
  // the short TTL below.
  WORKSPACE_SELF_HOSTED: 'workspace:self-hosted',
  WORKSPACE_BY_HOST: (subdomain: string) =>
    `workspace:byhost:${subdomain.toLowerCase()}`,
};

// Permission caches dedupe repeated checks within and across short request bursts.
// 5s keeps staleness on revocations bounded.
export const PERMISSION_CACHE_TTL_MS = 5_000;

// #348 — workspace row changes rarely; a short TTL bounds staleness of
// security-relevant fields (enforceSso/enforceMfa/status) even if an explicit
// bust is ever missed, while still removing the per-request workspace query.
export const WORKSPACE_CACHE_TTL_MS = 15_000;
