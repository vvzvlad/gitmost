import { ClientTelemetryModule } from './client-telemetry.module';
import { VitalsController } from './vitals.controller';
import { VitalsService } from './vitals.service';

// The register() gate is the CORE of the maintainer's E1=B decision: the public,
// unauthenticated /api/telemetry/vitals endpoint must be OFF by default, so a
// self-host deploy has no anonymous disk-fill surface into `client_metrics`. A
// regression that inverts the flag (or a truthiness bug where "" / "false"
// registers the route) would silently reopen that surface — pin it here.
describe('ClientTelemetryModule.register (E1=B gate)', () => {
  const original = process.env.CLIENT_TELEMETRY_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.CLIENT_TELEMETRY_ENABLED;
    else process.env.CLIENT_TELEMETRY_ENABLED = original;
  });

  it('OFF by default (flag unset) — no controller, no provider (endpoint absent)', () => {
    delete process.env.CLIENT_TELEMETRY_ENABLED;
    const mod = ClientTelemetryModule.register();
    expect(mod.controllers).toEqual([]);
    expect(mod.providers).toEqual([]);
  });

  it.each(['false', 'False', '0', '', 'yes', '1'])(
    'stays OFF for non-"true" value %p (no route)',
    (val) => {
      process.env.CLIENT_TELEMETRY_ENABLED = val;
      const mod = ClientTelemetryModule.register();
      expect(mod.controllers).toEqual([]);
      expect(mod.providers).toEqual([]);
    },
  );

  it('ON only for "true" — registers VitalsController + VitalsService', () => {
    process.env.CLIENT_TELEMETRY_ENABLED = 'true';
    const mod = ClientTelemetryModule.register();
    expect(mod.controllers).toContain(VitalsController);
    expect(mod.providers).toContain(VitalsService);
  });

  it('ON is case-insensitive ("TRUE")', () => {
    process.env.CLIENT_TELEMETRY_ENABLED = 'TRUE';
    const mod = ClientTelemetryModule.register();
    expect(mod.controllers).toContain(VitalsController);
    expect(mod.providers).toContain(VitalsService);
  });
});
