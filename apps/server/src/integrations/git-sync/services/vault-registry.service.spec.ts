// Unit tests for the per-space vault path resolver + lazy VaultGit cache
// `mkdir` and the git-sync loader are mocked so construction is cheap and
// no real filesystem / git work happens. We assert the path normalization
// (trailing slash) and the one-VaultGit-per-space caching contract.
//
// The service loads `VaultGit` (and `vaultGitEnv`) at runtime via the
// `loadGitSync()` bridge (the ESM `@docmost/git-sync` package cannot be
// `require()`d under jest), so we mock that loader rather than the package.
import { mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { loadGitSync } from '../git-sync.loader';

jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(async () => undefined),
}));

// ensureServable shells out via `promisify(execFile)`; mock execFile with a
// callback-style fn so promisify resolves. Each `git config <key> <value>` call
// is recorded so the config writes (incl. the security-critical
// receive.denyNonFastForwards=true and core.symlinks=false) can be asserted.
// By default a `git config --local --get` read returns '' (value differs).
jest.mock('node:child_process', () => ({
  execFile: jest.fn((_cmd: string, _args: string[], _opts: any, cb: any) =>
    cb(null, { stdout: '', stderr: '' }),
  ),
}));

// Cheap VaultGit stub: records the path it was constructed with; no shell-out.
// `ensureRepo` is a resolved jest.fn so ensureServable can call it. Declared with
// a `mock`-prefixed name so jest allows referencing it inside the hoisted
// `jest.mock` factory below.
const mockVaultGit = jest
  .fn()
  .mockImplementation((path: string) => ({
    path,
    ensureRepo: jest.fn().mockResolvedValue(undefined),
  }));

jest.mock('../git-sync.loader', () => ({
  loadGitSync: jest.fn(async () => ({
    VaultGit: mockVaultGit,
    vaultGitEnv: jest.fn(() => ({})),
  })),
}));

import { VaultRegistryService } from './vault-registry.service';

type AnyMock = jest.Mock;

const mkdirMock = mkdir as unknown as AnyMock;
const execFileMock = execFile as unknown as AnyMock;
const VaultGitMock = mockVaultGit;
void loadGitSync;

/** The `git config <key> <value>` writes (reads via `--local --get` excluded). */
function configWrites(): string[][] {
  return execFileMock.mock.calls
    .filter(
      ([cmd, args]) => cmd === 'git' && args[0] === 'config' && args[1] !== '--local',
    )
    .map(([, args]) => [args[1], args[2]]);
}

const SERVABLE_CONFIG: Record<string, string> = {
  'receive.denyCurrentBranch': 'updateInstead',
  'receive.denyNonFastForwards': 'true',
  'http.receivepack': 'true',
  'http.uploadpack': 'true',
  'core.symlinks': 'false',
};

function build(dataDir: string): { service: VaultRegistryService } {
  const env = {
    getGitSyncDataDir: jest.fn(() => dataDir),
    getGitSyncBackendTimeoutMs: jest.fn(() => 120000),
  };
  const service = new VaultRegistryService(env as any);
  return { service };
}

beforeEach(() => {
  jest.clearAllMocks();
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) =>
    cb(null, { stdout: '', stderr: '' }),
  );
});

describe('VaultRegistryService', () => {
  describe('vaultPath', () => {
    it('normalizes a trailing slash in the data dir (no double slash)', () => {
      const { service } = build('/vaults/');
      expect(service.vaultPath('space-1')).toBe('/vaults/space-1');
    });

    it('works without a trailing slash too', () => {
      const { service } = build('/vaults');
      expect(service.vaultPath('space-1')).toBe('/vaults/space-1');
    });
  });

  describe('getVault lazy cache', () => {
    it('returns the SAME instance on a second call (one VaultGit per space)', async () => {
      const { service } = build('/vaults');

      const first = await service.getVault('space-1');
      const second = await service.getVault('space-1');

      // Same cached instance, constructed exactly once.
      expect(second).toBe(first);
      expect(VaultGitMock).toHaveBeenCalledTimes(1);
      expect(VaultGitMock).toHaveBeenCalledWith('/vaults/space-1');
      // mkdir is only run on the first (cache-miss) construction.
      expect(mkdirMock).toHaveBeenCalledTimes(1);
      expect(mkdirMock).toHaveBeenCalledWith('/vaults/space-1', {
        recursive: true,
      });
    });
  });

  describe('ensureServable', () => {
    it('ensures the repo then writes the force-push-protection + symlink-guard git configs', async () => {
      const { service } = build('/vaults');

      const path = await service.ensureServable('space-1');
      expect(path).toBe('/vaults/space-1');

      // ensureRepo ran first on the cached vault.
      const vault = await service.getVault('space-1');
      expect((vault as any).ensureRepo).toHaveBeenCalledTimes(1);

      // Collect every `git config <key> <value>` write.
      expect(configWrites()).toEqual([
        ['receive.denyCurrentBranch', 'updateInstead'],
        // Security-critical: blocks force-push / history rewrites on main.
        ['receive.denyNonFastForwards', 'true'],
        ['http.receivepack', 'true'],
        ['http.uploadpack', 'true'],
        // Security-critical (PR #119 review): a pushed symlink is checked out as
        // a plain file, never a real link, so it cannot be followed to leak/
        // overwrite a file outside the vault.
        ['core.symlinks', 'false'],
      ]);

      // Every config write targets THIS vault's cwd and is time-bounded so a
      // wedged git cannot hang the request path.
      for (const [cmd, args, opts] of execFileMock.mock.calls) {
        if (cmd === 'git' && args[0] === 'config') {
          expect(opts.cwd).toBe('/vaults/space-1');
          expect(opts.timeout).toBe(120000);
        }
      }
    });

    it('rejects (and writes no git config) when ensureRepo rejects', async () => {
      const { service } = build('/vaults');
      const vault = await service.getVault('space-1');
      (vault as any).ensureRepo.mockRejectedValueOnce(new Error('init failed'));

      await expect(service.ensureServable('space-1')).rejects.toThrow(
        'init failed',
      );

      expect(configWrites()).toHaveLength(0);
    });

    it('parallel calls for one space share one run and write nothing when values already match', async () => {
      const { service } = build('/vaults');
      const vault = await service.getVault('space-1');
      // The vault already carries every servable value.
      execFileMock.mockImplementation(
        (_cmd: string, args: string[], _opts: any, cb: any) =>
          cb(null, {
            stdout: args[1] === '--local' ? `${SERVABLE_CONFIG[args[3]]}\n` : '',
            stderr: '',
          }),
      );
      let active = 0;
      let maxActive = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      (vault as any).ensureRepo.mockImplementation(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await gate;
        active--;
      });

      const calls = [1, 2, 3].map(() => service.ensureServable('space-1'));
      release();
      const paths = await Promise.all(calls);

      expect(paths).toEqual(Array(3).fill('/vaults/space-1'));
      expect((vault as any).ensureRepo).toHaveBeenCalledTimes(1);
      expect(maxActive).toBe(1);
      expect(configWrites()).toEqual([]);

      // Settled runs are not cached: a later request verifies again.
      await service.ensureServable('space-1');
      expect((vault as any).ensureRepo).toHaveBeenCalledTimes(2);
      expect(configWrites()).toEqual([]);
    });

    it('a rejected run is dropped: the next call retries', async () => {
      const { service } = build('/vaults');
      const vault = await service.getVault('space-1');
      (vault as any).ensureRepo.mockRejectedValueOnce(new Error('init failed'));

      await expect(service.ensureServable('space-1')).rejects.toThrow(
        'init failed',
      );
      await expect(service.ensureServable('space-1')).resolves.toBe(
        '/vaults/space-1',
      );
      expect((vault as any).ensureRepo).toHaveBeenCalledTimes(2);
    });

    it('fails loudly when reading a config key fails for a reason other than "unset"', async () => {
      const { service } = build('/vaults');
      execFileMock.mockImplementation(
        (_cmd: string, args: string[], _opts: any, cb: any) => {
          if (args[1] === '--local') {
            const err: any = new Error('fatal: bad config file');
            err.code = 128;
            return cb(err);
          }
          return cb(null, { stdout: '', stderr: '' });
        },
      );

      await expect(service.ensureServable('space-1')).rejects.toThrow(
        'bad config file',
      );
      expect(configWrites()).toEqual([]);
    });
  });
});
