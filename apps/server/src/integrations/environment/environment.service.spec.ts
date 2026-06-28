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
