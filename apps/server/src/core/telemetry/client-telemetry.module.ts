import { DynamicModule, Module } from '@nestjs/common';
import { VitalsController } from './vitals.controller';
import { VitalsService } from './vitals.service';

/**
 * Client perf-telemetry (#355): the public /api/telemetry/vitals sink that
 * persists web-vitals + custom client metrics into `client_metrics`.
 * Named ClientTelemetryModule to avoid confusion with the unrelated
 * integrations/telemetry (product usage ping) module.
 *
 * GATED OFF BY DEFAULT (maintainer decision E1=B). The public, unauthenticated
 * endpoint is only registered when CLIENT_TELEMETRY_ENABLED=true — otherwise the
 * route does NOT exist at all (no anonymous disk-fill surface, and no unbounded
 * `client_metrics` growth on a self-host deploy without an external pruner). The
 * client is told the same flag via window.CONFIG and skips sending when off.
 */
@Module({})
export class ClientTelemetryModule {
  static register(): DynamicModule {
    // Read process.env directly (not EnvironmentService) so the toggle is
    // resolved at module-registration time, identical to how the metrics
    // subsystem reads METRICS_PORT. Absent/anything-but-"true" => OFF.
    const enabled =
      (process.env.CLIENT_TELEMETRY_ENABLED ?? '').toLowerCase() === 'true';

    return {
      module: ClientTelemetryModule,
      controllers: enabled ? [VitalsController] : [],
      providers: enabled ? [VitalsService] : [],
    };
  }
}
