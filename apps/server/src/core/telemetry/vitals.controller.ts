import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle, Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { FastifyRequest } from 'fastify';
import { Public } from '../../common/decorators/public.decorator';
import {
  AI_CHAT_THROTTLER,
  AUTH_THROTTLER,
  PAGE_TEMPLATE_THROTTLER,
  PUBLIC_SHARE_AI_THROTTLER,
  VITALS_THROTTLER,
} from '../../integrations/throttle/throttler-names';
import { VitalsService } from './vitals.service';

/**
 * POST /api/telemetry/vitals (#355) — public client perf-metrics sink.
 *
 * PUBLIC (browsers post via sendBeacon, no session) but IP-throttled. Always
 * returns 200 with no body of interest: invalid/foreign/oversized payloads are
 * silently dropped by the service rather than 400'd, so browsers never retry.
 */
@Controller('telemetry')
export class VitalsController {
  constructor(private readonly vitalsService: VitalsService) {}

  @Public()
  @UseGuards(ThrottlerGuard)
  // The global ThrottlerGuard applies ALL named throttlers to every route, so
  // every OTHER bucket must be skipped here — otherwise the strictest of them
  // (public-share AI at 5/min) would override the intended vitals limit and cap
  // this route at 5/min instead of 120/min. Skip them all so ONLY the VITALS
  // bucket below applies.
  @SkipThrottle({
    [AUTH_THROTTLER]: true,
    [AI_CHAT_THROTTLER]: true,
    [PAGE_TEMPLATE_THROTTLER]: true,
    [PUBLIC_SHARE_AI_THROTTLER]: true,
  })
  @Throttle({ [VITALS_THROTTLER]: { limit: 120, ttl: 60_000 } })
  @Post('vitals')
  @HttpCode(200)
  async vitals(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<{ ok: true }> {
    // workspaceId is resolved by the workspace-host middleware onto req.raw when
    // the browser posts from a workspace host; null otherwise. No other PII.
    const workspaceId =
      ((req.raw as unknown as { workspaceId?: string })?.workspaceId ?? null) ||
      null;
    try {
      await this.vitalsService.ingest(body, workspaceId);
    } catch {
      // Never surface storage errors to the browser; telemetry is best-effort.
    }
    return { ok: true };
  }
}
