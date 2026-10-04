// Unit tests for the pure /git smart-HTTP helpers: URL parsing, service->kind
// mapping (read vs write), and the gating/auth decision precedence.
import {
  decideGitHttpGate,
  parseGitPath,
  resolveServiceKind,
} from './git-http.helpers';

describe('parseGitPath', () => {
  it('parses spaceId + subpath, stripping the trailing .git', () => {
    expect(parseGitPath('abc123.git/info/refs')).toEqual({
      spaceId: 'abc123',
      subpath: 'info/refs',
    });
  });

  it('tolerates a leading slash', () => {
    expect(parseGitPath('/abc.git/git-receive-pack')).toEqual({
      spaceId: 'abc',
      subpath: 'git-receive-pack',
    });
  });

  it('returns an empty subpath for the bare repo root', () => {
    expect(parseGitPath('abc.git')).toEqual({ spaceId: 'abc', subpath: '' });
  });

  it('returns null when the first segment lacks .git', () => {
    expect(parseGitPath('abc/info/refs')).toBeNull();
  });

  it('returns null on an empty space id', () => {
    expect(parseGitPath('.git/info/refs')).toBeNull();
  });

  it('rejects path traversal', () => {
    expect(parseGitPath('abc.git/../../etc/passwd')).toBeNull();
    expect(parseGitPath('..git/x')).toBeNull();
  });

  it('rejects percent-encoded dot/slash traversal in the subpath (case-insensitive)', () => {
    expect(parseGitPath('abc.git/%2e%2e%2fetc/passwd')).toBeNull();
    expect(parseGitPath('abc.git/%2E%2E/secret')).toBeNull();
    expect(parseGitPath('abc.git/objects/%2fabsolute')).toBeNull();
  });
});

describe('resolveServiceKind', () => {
  it('GET info/refs?service=git-upload-pack -> read', () => {
    expect(
      resolveServiceKind({
        method: 'GET',
        subpath: 'info/refs',
        service: 'git-upload-pack',
      }),
    ).toBe('read');
  });

  it('GET info/refs?service=git-receive-pack -> write', () => {
    expect(
      resolveServiceKind({
        method: 'GET',
        subpath: 'info/refs',
        service: 'git-receive-pack',
      }),
    ).toBe('write');
  });

  it('POST git-upload-pack -> read', () => {
    expect(
      resolveServiceKind({ method: 'POST', subpath: 'git-upload-pack' }),
    ).toBe('read');
  });

  it('POST git-receive-pack -> write', () => {
    expect(
      resolveServiceKind({ method: 'POST', subpath: 'git-receive-pack' }),
    ).toBe('write');
  });

  it('a dumb-protocol GET (HEAD / objects) -> read', () => {
    expect(resolveServiceKind({ method: 'GET', subpath: 'HEAD' })).toBe('read');
    expect(
      resolveServiceKind({ method: 'GET', subpath: 'objects/12/abcdef' }),
    ).toBe('read');
  });

  it('info/refs with no/unknown service -> read (dumb discovery)', () => {
    expect(resolveServiceKind({ method: 'GET', subpath: 'info/refs' })).toBe(
      'read',
    );
  });

  it('an unknown POST endpoint -> null', () => {
    expect(resolveServiceKind({ method: 'POST', subpath: 'whatever' })).toBeNull();
  });

  it('an unsupported method -> null', () => {
    expect(
      resolveServiceKind({ method: 'DELETE', subpath: 'git-receive-pack' }),
    ).toBeNull();
  });
});

describe('decideGitHttpGate', () => {
  const base = {
    hasCredentials: true,
    credentialsValid: true,
    serviceKind: 'read' as const,
    gitSyncEnabled: true,
    gitHttpEnabled: true,
    spaceExists: true,
    spaceGitSyncEnabled: true,
    userIsSpaceMember: true,
    permissionGranted: true,
  };

  it('proceeds on the happy path', () => {
    expect(decideGitHttpGate(base)).toEqual({ kind: 'proceed' });
  });

  it('401 when credentials are missing (even for a valid space)', () => {
    expect(
      decideGitHttpGate({ ...base, hasCredentials: false }),
    ).toEqual({ kind: 'unauthorized' });
  });

  it('401 when credentials are present but invalid', () => {
    expect(
      decideGitHttpGate({ ...base, credentialsValid: false }),
    ).toEqual({ kind: 'unauthorized' });
  });

  it('400 on an unparseable service kind', () => {
    expect(decideGitHttpGate({ ...base, serviceKind: null })).toEqual({
      kind: 'bad-request',
    });
  });

  it('404 when the space is not git-sync-enabled (never reveals existence)', () => {
    expect(
      decideGitHttpGate({ ...base, spaceGitSyncEnabled: false }),
    ).toEqual({ kind: 'not-found' });
  });

  it('404 when the space does not exist', () => {
    expect(decideGitHttpGate({ ...base, spaceExists: false })).toEqual({
      kind: 'not-found',
    });
  });

  it('404 when git-sync is globally disabled', () => {
    expect(decideGitHttpGate({ ...base, gitSyncEnabled: false })).toEqual({
      kind: 'not-found',
    });
  });

  it('404 when the git-http host is disabled', () => {
    expect(decideGitHttpGate({ ...base, gitHttpEnabled: false })).toEqual({
      kind: 'not-found',
    });
  });

  it('403 when a MEMBER lacks the required permission (reader on write)', () => {
    // A member of the space (existence already known to them) who lacks the role:
    // 403 leaks nothing new.
    expect(
      decideGitHttpGate({
        ...base,
        serviceKind: 'write',
        userIsSpaceMember: true,
        permissionGranted: false,
      }),
    ).toEqual({ kind: 'forbidden' });
  });

  it('404 (NOT 403) when an authenticated NON-member hits a git-sync space', () => {
    // SECURITY: a non-member must be indistinguishable from a missing/disabled
    // space. If this returned 403, the 403↔404 difference would let any
    // authenticated workspace user brute-force slugs to discover which spaces
    // exist and which have git-sync enabled.
    expect(
      decideGitHttpGate({
        ...base,
        serviceKind: 'write',
        userIsSpaceMember: false,
        permissionGranted: false,
      }),
    ).toEqual({ kind: 'not-found' });
    // Same for a read by a non-member.
    expect(
      decideGitHttpGate({
        ...base,
        serviceKind: 'read',
        userIsSpaceMember: false,
        permissionGranted: false,
      }),
    ).toEqual({ kind: 'not-found' });
  });

  it('still 401 (not 404) for missing creds against a disabled space', () => {
    // Anonymous probe must always get 401 first, regardless of space state.
    expect(
      decideGitHttpGate({
        ...base,
        hasCredentials: false,
        spaceGitSyncEnabled: false,
      }),
    ).toEqual({ kind: 'unauthorized' });
  });
});
