export enum UserTokenType {
  FORGOT_PASSWORD = 'forgot-password',
  EMAIL_VERIFICATION = 'email-verification',
}

/**
 * The single source of truth for the credentials-mismatch error message.
 *
 * `AuthService.verifyUserCredentials`/`login` throw an UnauthorizedException
 * with EXACTLY this message for every credentials-failure case (unknown email,
 * disabled user, wrong password), so the surfaced 401 is uniform (anti-
 * enumeration) and callers can match on one shared constant instead of a
 * duplicated literal. This file is intentionally dependency-light so it loads
 * from core/auth without dragging the heavy auth graph.
 */
export const CREDENTIALS_MISMATCH_MESSAGE = 'Email or password does not match';
