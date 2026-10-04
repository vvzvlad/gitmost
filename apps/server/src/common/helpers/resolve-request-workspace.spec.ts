import { resolveRequestWorkspace } from './resolve-request-workspace';

// Unit tests for the shared self-hosted/cloud workspace resolver deduplicated out
// of DomainMiddleware + GitHttpService (architecture #11). They must behave
// identically, so this pins the single source of truth.

type AnyMock = jest.Mock;

function build(opts: {
  selfHosted: boolean;
  first?: { id: string } | null;
  byHostname?: { id: string } | null;
}) {
  const env = {
    isSelfHosted: jest.fn(() => opts.selfHosted),
    isCloud: jest.fn(() => !opts.selfHosted),
  };
  const repo = {
    findFirst: jest.fn(async () => opts.first ?? null) as AnyMock,
    findByHostname: jest.fn(async () => opts.byHostname ?? null) as AnyMock,
  };
  return { env, repo };
}

describe('resolveRequestWorkspace', () => {
  it('self-hosted: returns the first/default workspace, ignoring the host', async () => {
    const { env, repo } = build({ selfHosted: true, first: { id: 'ws-1' } });
    const ws = await resolveRequestWorkspace(
      env as any,
      repo as any,
      'anything.example.com',
    );
    expect(ws).toEqual({ id: 'ws-1' });
    expect(repo.findFirst).toHaveBeenCalledTimes(1);
    expect(repo.findByHostname).not.toHaveBeenCalled();
  });

  it('self-hosted: returns null when no workspace is configured', async () => {
    const { env, repo } = build({ selfHosted: true, first: null });
    expect(await resolveRequestWorkspace(env as any, repo as any, 'h')).toBeNull();
  });

  it('cloud: resolves by the host-header subdomain', async () => {
    const { env, repo } = build({
      selfHosted: false,
      byHostname: { id: 'ws-acme' },
    });
    const ws = await resolveRequestWorkspace(
      env as any,
      repo as any,
      'acme.example.com',
    );
    expect(ws).toEqual({ id: 'ws-acme' });
    expect(repo.findByHostname).toHaveBeenCalledWith('acme');
    expect(repo.findFirst).not.toHaveBeenCalled();
  });

  it('cloud: returns null for a blank/missing host (no throw)', async () => {
    const { env, repo } = build({ selfHosted: false, byHostname: { id: 'x' } });
    expect(await resolveRequestWorkspace(env as any, repo as any, undefined)).toBeNull();
    expect(await resolveRequestWorkspace(env as any, repo as any, '')).toBeNull();
    expect(repo.findByHostname).not.toHaveBeenCalled();
  });

  it('cloud: returns null when the subdomain matches no workspace', async () => {
    const { env, repo } = build({ selfHosted: false, byHostname: null });
    expect(
      await resolveRequestWorkspace(env as any, repo as any, 'ghost.example.com'),
    ).toBeNull();
  });
});
