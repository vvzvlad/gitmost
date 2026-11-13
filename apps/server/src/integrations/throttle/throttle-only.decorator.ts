import { applyDecorators } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { THROTTLERS } from './throttler-names';

/**
 * Limits a route (or a whole controller) by ONE named throttler. ThrottlerGuard
 * applies every named throttler of the app to every guarded route, so a bare
 * @Throttle({ [name]: … }) only sets that bucket while the strictest other one
 * (public-share-ai, 5/min) still caps the route. This skips all the others and
 * explicitly un-skips `name`, so a class-level skip cannot disable it.
 */
export function ThrottleOnly(
  name: string,
  options: { limit: number; ttl: number },
) {
  const skipOthers = Object.fromEntries(
    THROTTLERS.map((t) => [t.name, t.name !== name]),
  );
  return applyDecorators(
    SkipThrottle(skipOthers),
    Throttle({ [name]: options }),
  );
}
