// Pure, framework-free helpers for the /git smart-HTTP host. They carry no Nest
// / DI / concrete-service imports so the request parsing and the auth/authz
// gating DECISION can be unit-tested in isolation, and nothing here ever logs a
// password or the Authorization header.

/** The git operation a request maps to: a read (fetch/clone) or a write (push). */
export type GitHttpServiceKind = 'read' | 'write';

/** A parsed `/git/<spaceId>.git/<subpath>` URL. */
export interface ParsedGitPath {
  spaceId: string;
  /** The subpath after `<spaceId>.git/` (no leading slash), e.g. `info/refs`. */
  subpath: string;
}

/**
 * Parse the `<rest>` of a `/git/<rest>` URL path (no query string) into the
 * space id and the repo-relative subpath. The space id is the first path
 * segment with its trailing `.git` stripped. Returns null when the shape does
 * not match (missing `.git`, empty space id, traversal attempt).
 *
 * `rest` MUST already be URL-path-decoded of its query string by the caller
 * (pass the pathname only). We reject `..` segments defensively even though
 * http-backend resolves PATH_INFO against GIT_PROJECT_ROOT.
 */
export function parseGitPath(rest: string): ParsedGitPath | null {
  // Strip a leading slash, then take the first segment as `<spaceId>.git`.
  const clean = rest.replace(/^\/+/, '');
  const slash = clean.indexOf('/');
  const first = slash === -1 ? clean : clean.slice(0, slash);
  const subpath = slash === -1 ? '' : clean.slice(slash + 1);

  if (!first.endsWith('.git')) return null;
  const spaceId = first.slice(0, -'.git'.length);
  if (!spaceId) return null;

  // Reject path traversal / degenerate ids in either component.
  if (
    spaceId === '.' ||
    spaceId.includes('..') ||
    spaceId.includes('/') ||
    subpath.split('/').some((seg) => seg === '..')
  ) {
    return null;
  }

  // Defense-in-depth: reject percent-encoded dot/slash traversal (`%2e`, `%2f`,
  // case-insensitive) in the subpath BEFORE it is used to build PATH_INFO — a
  // decoder downstream could otherwise turn `%2e%2e%2f` back into `../`.
  if (/%2e|%2f/i.test(subpath)) {
    return null;
  }

  return { spaceId, subpath };
}

/**
 * Map a parsed git request (method + subpath + query) to the required operation
 * kind. The smart-HTTP shapes:
 *   - GET  info/refs?service=git-upload-pack   -> read (fetch)
 *   - GET  info/refs?service=git-receive-pack  -> write (push)
 *   - POST git-upload-pack                      -> read (fetch)
 *   - POST git-receive-pack                     -> write (push)
 *   - any other dumb-protocol GET (HEAD, objects/…) -> read
 * Returns null for an unsupported shape (e.g. a POST that is neither pack
 * endpoint) so the caller can 403/404 rather than guess.
 */
export function resolveServiceKind(input: {
  method: string;
  subpath: string;
  service?: string;
}): GitHttpServiceKind | null {
  const method = input.method.toUpperCase();
  const subpath = input.subpath;

  if (method === 'GET') {
    if (subpath === 'info/refs') {
      if (input.service === 'git-receive-pack') return 'write';
      if (input.service === 'git-upload-pack') return 'read';
      // info/refs without a known service: dumb-protocol discovery — read.
      return 'read';
    }
    // Dumb-protocol object/ref fetches (HEAD, objects/…) are reads.
    return 'read';
  }

  if (method === 'POST') {
    if (subpath === 'git-receive-pack') return 'write';
    if (subpath === 'git-upload-pack') return 'read';
    return null; // unknown POST endpoint
  }

  return null; // unsupported method
}

/** The outcome of the gating/auth decision the request handler must enforce. */
export type GitHttpGateDecision =
  | { kind: 'unauthorized' } // 401 + WWW-Authenticate (missing/invalid creds)
  | { kind: 'not-found' } // 404 (space hidden / sync or http disabled)
  | { kind: 'forbidden' } // 403 (authenticated but lacks the permission)
  | { kind: 'bad-request' } // 400 (unparseable git request shape)
  | { kind: 'proceed' }; // run http-backend

/**
 * Pure gating decision, mirroring the handler precedence so it can be unit
 * tested without the DB / CASL graph. Inputs are the already-resolved booleans
 * the handler computes from EnvironmentService / SpaceRepo / SpaceAbilityFactory.
 *
 * Precedence (matches the spec):
 *   1. no/invalid Basic credentials               -> 401 (regardless of space).
 *   2. credentials present but invalid             -> 401.
 *   3. unparseable git request shape               -> 400.
 *   4. git-sync globally disabled, or git-http disabled, or the space is missing
 *      / not git-sync-enabled, OR the authenticated user is NOT a member of the
 *      space (has no role at all)                   -> 404 (never reveal existence).
 *   5. a MEMBER of the space who lacks the required perm (e.g. a reader trying to
 *      push)                                        -> 403.
 *   6. otherwise                                    -> proceed.
 *
 * Note (4) is checked AFTER (1)/(2): an anonymous probe always gets 401 first;
 * an authenticated user hitting a hidden/disabled space — OR a space they are not
 * a member of — gets 404 (not 403). Folding non-membership into the 404 branch is
 * a SECURITY requirement: if a non-member got 403 here (as a "permission denied")
 * while a non-existent / sync-disabled space got 404, the 403↔404 difference would
 * let any authenticated workspace user brute-force slugs to discover which spaces
 * exist and which have git-sync enabled — including spaces they cannot see. 403 is
 * therefore reserved for the one case where existence is ALREADY known to the
 * caller because they ARE a member (so it leaks nothing new): a member without the
 * required role. `userIsSpaceMember` is the resolved "the user has SOME role in
 * this space" boolean (false when SpaceAbilityFactory.createForUser throws
 * NotFound / the user has no role).
 */
export function decideGitHttpGate(input: {
  hasCredentials: boolean;
  credentialsValid: boolean;
  serviceKind: GitHttpServiceKind | null;
  gitSyncEnabled: boolean;
  gitHttpEnabled: boolean;
  spaceExists: boolean;
  spaceGitSyncEnabled: boolean;
  /** The user has SOME role in the space (false = non-member -> 404, not 403). */
  userIsSpaceMember: boolean;
  permissionGranted: boolean;
}): GitHttpGateDecision {
  if (!input.hasCredentials) return { kind: 'unauthorized' };
  if (!input.credentialsValid) return { kind: 'unauthorized' };
  if (input.serviceKind === null) return { kind: 'bad-request' };

  if (
    !input.gitSyncEnabled ||
    !input.gitHttpEnabled ||
    !input.spaceExists ||
    !input.spaceGitSyncEnabled ||
    // A non-member must be indistinguishable from a missing/disabled space: 404,
    // never 403 (otherwise the 403↔404 split leaks space existence — see above).
    !input.userIsSpaceMember
  ) {
    return { kind: 'not-found' };
  }

  if (!input.permissionGranted) return { kind: 'forbidden' };

  return { kind: 'proceed' };
}
