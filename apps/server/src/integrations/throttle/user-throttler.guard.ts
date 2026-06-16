import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

// JwtStrategy.validate() returns `{ user, workspace }`, so Passport sets
// `req.user = { user, workspace }` (the `@AuthUser()` decorator reads
// `request.user.user`). Reading `req.user?.id` therefore never matches and the
// limiter silently degrades to per-IP; read `req.user?.user?.id` instead.
type AuthedRequest = { user?: { id?: string; user?: { id?: string } } };

@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: AuthedRequest): Promise<string> {
    const userId = req.user?.user?.id ?? req.user?.id;
    if (userId) return `user:${userId}`;
    // Unauthenticated request: fall back to the default IP-based tracker.
    return super.getTracker(req as Parameters<ThrottlerGuard['getTracker']>[0]);
  }
}
