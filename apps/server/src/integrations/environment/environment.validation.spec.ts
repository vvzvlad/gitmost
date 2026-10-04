import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { EnvironmentVariables } from './environment.validation';

/**
 * Validation-layer coverage for the git-sync env contract (test-strategy Module
 * 4 / item #4). We drive the decorated class with `validateSync` directly — the
 * exported `validate()` helper calls `process.exit(1)` on failure and so cannot
 * be asserted in-process. We only assert the git-sync rules, providing the
 * minimal always-required fields so unrelated validators do not add noise.
 */
describe('EnvironmentVariables — git-sync validation', () => {
  // A baseline config that satisfies the unconditionally-required fields
  // (DATABASE_URL, REDIS_URL, APP_SECRET) so the only errors we ever see come
  // from the git-sync rules under test.
  const baseConfig = {
    DATABASE_URL: 'postgres://user:pass@localhost:5432/docmost',
    REDIS_URL: 'redis://localhost:6379',
    APP_SECRET: 'x'.repeat(32),
  };

  const validate = (extra: Record<string, unknown>) => {
    const instance = plainToInstance(EnvironmentVariables, {
      ...baseConfig,
      ...extra,
    });
    return validateSync(instance);
  };

  const errorFor = (errors: ReturnType<typeof validateSync>, property: string) =>
    errors.find((e) => e.property === property);

  it('flags GIT_SYNC_SERVICE_USER_ID when GIT_SYNC_ENABLED="true" and the id is absent', () => {
    const errors = validate({ GIT_SYNC_ENABLED: 'true' });

    const err = errorFor(errors, 'GIT_SYNC_SERVICE_USER_ID');
    expect(err).toBeDefined();
    // @IsNotEmpty is the failing constraint (sync is on but no attributable
    // author was configured).
    expect(err?.constraints).toHaveProperty('isNotEmpty');
  });

  it('accepts GIT_SYNC_ENABLED="true" once GIT_SYNC_SERVICE_USER_ID is present', () => {
    const errors = validate({
      GIT_SYNC_ENABLED: 'true',
      GIT_SYNC_SERVICE_USER_ID: 'service-user-1',
    });

    expect(errorFor(errors, 'GIT_SYNC_SERVICE_USER_ID')).toBeUndefined();
  });

  it('does not require the service user id when git-sync is disabled (unset)', () => {
    const errors = validate({});

    // The @ValidateIf gate (GIT_SYNC_ENABLED === "true") is not met, so the
    // required-if-enabled rule is skipped entirely.
    expect(errorFor(errors, 'GIT_SYNC_SERVICE_USER_ID')).toBeUndefined();
  });

  it('does not require the service user id when git-sync is explicitly "false"', () => {
    const errors = validate({ GIT_SYNC_ENABLED: 'false' });

    expect(errorFor(errors, 'GIT_SYNC_SERVICE_USER_ID')).toBeUndefined();
    expect(errorFor(errors, 'GIT_SYNC_ENABLED')).toBeUndefined();
  });

  it('rejects a GIT_SYNC_ENABLED value outside the {true,false} set via @IsIn', () => {
    const errors = validate({ GIT_SYNC_ENABLED: 'maybe' });

    const err = errorFor(errors, 'GIT_SYNC_ENABLED');
    expect(err).toBeDefined();
    expect(err?.constraints).toHaveProperty('isIn');
  });
});
