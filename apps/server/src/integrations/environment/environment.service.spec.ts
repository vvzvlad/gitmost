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
});
