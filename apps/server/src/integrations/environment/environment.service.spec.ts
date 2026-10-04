import { EnvironmentService } from './environment.service';

// Direct instantiation with a stub ConfigService, mirroring the rest of these
// unit specs.
describe('EnvironmentService', () => {
  let service: EnvironmentService;

  beforeEach(() => {
    service = new EnvironmentService(
      {} as any, // configService
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getGitSyncPollIntervalMs', () => {
    const withEnv = (value?: string) =>
      new EnvironmentService({
        get: (_key: string, fallback?: string) => value ?? fallback,
      } as any);

    it('defaults to 15000 when unset', () => {
      expect(withEnv().getGitSyncPollIntervalMs()).toBe(15000);
    });

    it('parses a valid positive int', () => {
      expect(withEnv('30000').getGitSyncPollIntervalMs()).toBe(30000);
    });

    it('falls back to 15000 for non-positive or unparseable values', () => {
      expect(withEnv('0').getGitSyncPollIntervalMs()).toBe(15000);
      expect(withEnv('-100').getGitSyncPollIntervalMs()).toBe(15000);
      expect(withEnv('not-a-number').getGitSyncPollIntervalMs()).toBe(15000);
    });
  });

  describe('getGitSyncDebounceMs', () => {
    const withEnv = (value?: string) =>
      new EnvironmentService({
        get: (_key: string, fallback?: string) => value ?? fallback,
      } as any);

    it('defaults to 2000 when unset', () => {
      expect(withEnv().getGitSyncDebounceMs()).toBe(2000);
    });

    it('parses a valid positive int', () => {
      expect(withEnv('500').getGitSyncDebounceMs()).toBe(500);
    });

    it('falls back to 2000 for non-positive or unparseable values', () => {
      expect(withEnv('0').getGitSyncDebounceMs()).toBe(2000);
      expect(withEnv('-5').getGitSyncDebounceMs()).toBe(2000);
      expect(withEnv('not-a-number').getGitSyncDebounceMs()).toBe(2000);
    });
  });

  // getGitSyncDataDir reads two distinct keys (GIT_SYNC_DATA_DIR and DATA_DIR),
  // so this builder maps each key to a supplied value (and honours the fallback
  // the getter passes for DATA_DIR's `|| './data'`).
  describe('getGitSyncDataDir', () => {
    const withEnv = (values: Record<string, string | undefined>) =>
      new EnvironmentService({
        get: (key: string, fallback?: string) => values[key] ?? fallback,
      } as any);

    it("defaults to './data/git-sync' when neither key is set", () => {
      expect(withEnv({}).getGitSyncDataDir()).toBe('./data/git-sync');
    });

    it('derives from DATA_DIR with the /git-sync suffix', () => {
      expect(
        withEnv({ DATA_DIR: '/var/lib/docmost' }).getGitSyncDataDir(),
      ).toBe('/var/lib/docmost/git-sync');
    });

    it('strips trailing slashes from DATA_DIR before appending', () => {
      expect(
        withEnv({ DATA_DIR: '/var/lib/docmost///' }).getGitSyncDataDir(),
      ).toBe('/var/lib/docmost/git-sync');
    });

    it('lets an explicit GIT_SYNC_DATA_DIR override the DATA_DIR derivation', () => {
      expect(
        withEnv({
          GIT_SYNC_DATA_DIR: '/custom/vault',
          DATA_DIR: '/var/lib/docmost',
        }).getGitSyncDataDir(),
      ).toBe('/custom/vault');
    });

    it('returns the explicit override verbatim (no /git-sync suffix, no slash strip)', () => {
      expect(
        withEnv({ GIT_SYNC_DATA_DIR: '/custom/vault/' }).getGitSyncDataDir(),
      ).toBe('/custom/vault/');
    });
  });

  // isGitSyncEnabled is the `.toLowerCase() === 'true'` contract: only a
  // case-insensitive "true" enables it; everything else (unset, "false",
  // garbage) is false.
  describe('isGitSyncEnabled', () => {
    const withEnv = (value?: string) =>
      new EnvironmentService({
        get: (_key: string, fallback?: string) => value ?? fallback,
      } as any);

    it('is true for "true" and "TRUE" (case-insensitive)', () => {
      expect(withEnv('true').isGitSyncEnabled()).toBe(true);
      expect(withEnv('TRUE').isGitSyncEnabled()).toBe(true);
    });

    it('is false when unset (defaults to "false")', () => {
      expect(withEnv().isGitSyncEnabled()).toBe(false);
    });

    it('is false for "false" and garbage values', () => {
      expect(withEnv('false').isGitSyncEnabled()).toBe(false);
      expect(withEnv('maybe').isGitSyncEnabled()).toBe(false);
      expect(withEnv('1').isGitSyncEnabled()).toBe(false);
    });
  });

  // isGitSyncHttpEnabled is the master gate of the /git smart-HTTP trust boundary.
  // When GIT_SYNC_HTTP_ENABLED is UNSET it FALLS BACK to isGitSyncEnabled(); when
  // set it is honored verbatim ('true' -> on, anything else -> off). The fallback
  // (default) branch is what these tests pin.
  describe('isGitSyncHttpEnabled', () => {
    const withEnv = (values: Record<string, string | undefined>) =>
      new EnvironmentService({
        get: (key: string, fallback?: string) => values[key] ?? fallback,
      } as any);

    it('DEFAULT branch: unset -> falls back to isGitSyncEnabled() === true', () => {
      expect(
        withEnv({ GIT_SYNC_ENABLED: 'true' }).isGitSyncHttpEnabled(),
      ).toBe(true);
    });

    it('DEFAULT branch: unset -> falls back to isGitSyncEnabled() === false', () => {
      // Neither key set: the fallback resolves to isGitSyncEnabled() which is
      // false by default.
      expect(withEnv({}).isGitSyncHttpEnabled()).toBe(false);
      expect(
        withEnv({ GIT_SYNC_ENABLED: 'false' }).isGitSyncHttpEnabled(),
      ).toBe(false);
    });

    it('explicit "true" enables the host regardless of GIT_SYNC_ENABLED', () => {
      expect(
        withEnv({
          GIT_SYNC_HTTP_ENABLED: 'true',
          GIT_SYNC_ENABLED: 'false',
        }).isGitSyncHttpEnabled(),
      ).toBe(true);
    });

    it('explicit non-"true" disables the host even when sync is enabled', () => {
      expect(
        withEnv({
          GIT_SYNC_HTTP_ENABLED: 'false',
          GIT_SYNC_ENABLED: 'true',
        }).isGitSyncHttpEnabled(),
      ).toBe(false);
      expect(
        withEnv({
          GIT_SYNC_HTTP_ENABLED: 'maybe',
          GIT_SYNC_ENABLED: 'true',
        }).isGitSyncHttpEnabled(),
      ).toBe(false);
    });
  });

  describe('getSandboxTtlMs', () => {
    // ConfigService stub: get(key, def) returns the configured value for the key
    // (falling back to def), matching the @nestjs/config contract the service
    // calls with (key, default).
    const build = (sandboxTtl?: string) =>
      new EnvironmentService({
        get: (key: string, def?: string) =>
          key === 'SANDBOX_TTL_MS' ? (sandboxTtl ?? def) : def,
      } as any);

    it.each(['0', '-5', 'abc'])(
      'falls back to the 3600000 default for invalid value %s',
      (value) => {
        expect(build(value).getSandboxTtlMs()).toBe(3_600_000);
      },
    );

    it('returns the parsed value for a valid positive integer', () => {
      expect(build('120000').getSandboxTtlMs()).toBe(120_000);
    });

    it('uses the 3600000 default when SANDBOX_TTL_MS is unset', () => {
      expect(build(undefined).getSandboxTtlMs()).toBe(3_600_000);
    });
  });

  // The three byte caps share the same getPositiveIntEnv() helper as the TTL,
  // so a non-integer / non-positive value ('0'/'-5'/'abc') falls back to the
  // documented default and a valid positive integer is returned parsed. Note
  // parseInt truncates '1.5' -> 1 (a valid positive integer), so that value is
  // accepted, not rejected — same as the pre-existing TTL getter.
  describe.each([
    {
      name: 'getSandboxMaxBytes',
      key: 'SANDBOX_MAX_BYTES',
      def: 8_388_608,
      getter: (s: EnvironmentService) => s.getSandboxMaxBytes(),
    },
    {
      name: 'getSandboxMaxImageBytes',
      key: 'SANDBOX_MAX_IMAGE_BYTES',
      def: 20_971_520,
      getter: (s: EnvironmentService) => s.getSandboxMaxImageBytes(),
    },
    {
      name: 'getSandboxMaxTotalBytes',
      key: 'SANDBOX_MAX_TOTAL_BYTES',
      def: 134_217_728,
      getter: (s: EnvironmentService) => s.getSandboxMaxTotalBytes(),
    },
  ])('$name', ({ key, def, getter }) => {
    // ConfigService stub: get(k, d) returns the configured value for THIS cap's
    // key (falling back to d), and the default for every other key.
    const build = (value?: string) =>
      new EnvironmentService({
        get: (k: string, d?: string) =>
          k === key ? (value ?? d) : d,
      } as any);

    it.each(['0', '-5', 'abc'])(
      `falls back to the ${def} default for invalid value %s`,
      (value) => {
        expect(getter(build(value))).toBe(def);
      },
    );

    it('returns the parsed value for a valid positive integer', () => {
      expect(getter(build('4096'))).toBe(4096);
    });

    it('truncates a non-integer like "1.5" to 1 via parseInt (not rejected)', () => {
      expect(getter(build('1.5'))).toBe(1);
    });

    it(`uses the ${def} default when the env is unset`, () => {
      expect(getter(build(undefined))).toBe(def);
    });
  });

  // getPositiveIntEnv keeps a one-shot `invalidPositiveIntWarned` set so a bad
  // value is logged ONCE per key (not on every getter call, which the sandbox
  // hits per-put). These tests pin that dedup so a regression to per-call logging
  // would fail loudly.
  describe('invalid-value warn dedup', () => {
    it('warns only once per key across repeated getter calls', () => {
      const service = new EnvironmentService({
        get: (k: string, d?: string) =>
          k === 'SANDBOX_MAX_TOTAL_BYTES' ? '-5' : d,
      } as any);
      const warnSpy = jest
        .spyOn((service as any).logger, 'warn')
        .mockImplementation(() => undefined);

      service.getSandboxMaxTotalBytes();
      service.getSandboxMaxTotalBytes();

      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('warns independently per key (dedup is per-key, not global)', () => {
      // Two DIFFERENT SANDBOX_* keys are both invalid -> each warns once, so two
      // warns total. This proves the dedup set is keyed, not a single global flag.
      const service = new EnvironmentService({
        get: (k: string, d?: string) =>
          k === 'SANDBOX_MAX_BYTES' || k === 'SANDBOX_MAX_TOTAL_BYTES'
            ? '-5'
            : d,
      } as any);
      const warnSpy = jest
        .spyOn((service as any).logger, 'warn')
        .mockImplementation(() => undefined);

      service.getSandboxMaxBytes();
      service.getSandboxMaxTotalBytes();

      expect(warnSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('getSandboxPublicUrl', () => {
    // Stub that resolves BOTH keys the public-url logic consults.
    const build = (vals: { sandboxUrl?: string; appUrl?: string }) =>
      new EnvironmentService({
        get: (key: string, def?: string) =>
          key === 'SANDBOX_PUBLIC_URL'
            ? (vals.sandboxUrl ?? def)
            : key === 'APP_URL'
              ? (vals.appUrl ?? def)
              : def,
      } as any);

    it('uses SANDBOX_PUBLIC_URL and trims a trailing slash', () => {
      expect(
        build({ sandboxUrl: 'https://docs.example.com/' }).getSandboxPublicUrl(),
      ).toBe('https://docs.example.com');
    });

    it('falls back to APP_URL (origin) when SANDBOX_PUBLIC_URL is unset', () => {
      expect(
        build({ appUrl: 'https://app.example.com' }).getSandboxPublicUrl(),
      ).toBe('https://app.example.com');
    });
  });

  describe('isAiChatFinalStepLockdownEnabled (#444)', () => {
    const build = (val?: string) =>
      new EnvironmentService({
        get: (key: string, def?: string) =>
          key === 'AI_CHAT_FINAL_STEP_LOCKDOWN' ? (val ?? def) : def,
      } as any);

    it('defaults to OFF (false) when unset — the new anti-degeneration default', () => {
      expect(build(undefined).isAiChatFinalStepLockdownEnabled()).toBe(false);
    });

    it('is true only for the exact opt-in "true" (case-insensitive)', () => {
      expect(build('true').isAiChatFinalStepLockdownEnabled()).toBe(true);
      expect(build('TRUE').isAiChatFinalStepLockdownEnabled()).toBe(true);
    });

    it('stays OFF for any other value', () => {
      expect(build('false').isAiChatFinalStepLockdownEnabled()).toBe(false);
      expect(build('1').isAiChatFinalStepLockdownEnabled()).toBe(false);
      expect(build('yes').isAiChatFinalStepLockdownEnabled()).toBe(false);
    });
  });
});
