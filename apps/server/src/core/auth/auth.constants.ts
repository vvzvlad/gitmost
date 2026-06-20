export enum UserTokenType {
  FORGOT_PASSWORD = 'forgot-password',
  EMAIL_VERIFICATION = 'email-verification',
}

/**
 * The single source of truth for the credentials-mismatch error message.
 *
 * `AuthService.verifyUserCredentials`/`login` throw an UnauthorizedException
 * with EXACTLY this message for every credentials-failure case (unknown email,
 * disabled user, wrong password). The /mcp Basic brute-force limiter relies on
 * recognising that exact failure via `isCredentialsFailure` (mcp-auth.helpers),
 * which matches against this same constant. Keeping a single shared constant
 * means a reworded auth error cannot silently stop counting toward the limiter
 * (which would turn /mcp Basic into an unthrottled password-guessing oracle).
 * This file is intentionally dependency-light so it loads from both core/auth
 * and the framework-free integrations/mcp helpers without dragging the heavy
 * auth graph.
 */
export const CREDENTIALS_MISMATCH_MESSAGE = 'Email or password does not match';
