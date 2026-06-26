import { BadRequestException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import {
  computeEmailSignature,
  throwIfEmailNotVerified,
  validateSsoEnforcement,
  validateAllowedEmail,
} from './auth.util';

/**
 * Pure-function contract for auth.util.ts.
 *
 * computeEmailSignature is the cross-surface coupling between the verify-email
 * flow and the resend endpoint: the BadRequestException thrown on an unverified
 * cloud login carries this signature so the client can request a resend without
 * re-exposing the raw email. The signature must therefore be deterministic and
 * lowercase-stable. The tests re-derive the expected HMAC independently with
 * node:crypto so they fail if the input formatting drifts.
 */

const APP_SECRET = 'unit-test-secret';

// Independently recompute the expected signature the way the implementation
// documents it: HMAC-SHA256 over `email.toLowerCase():workspaceId`.
function expectedSignature(
  email: string,
  workspaceId: string,
  secret: string,
): string {
  return createHmac('sha256', secret)
    .update(`${email.toLowerCase()}:${workspaceId}`)
    .digest('hex');
}

describe('computeEmailSignature', () => {
  it('is deterministic: same inputs -> same hex', () => {
    const a = computeEmailSignature('user@x.com', 'ws-1', APP_SECRET);
    const b = computeEmailSignature('user@x.com', 'ws-1', APP_SECRET);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });

  it('matches an independently computed HMAC-SHA256 of email.toLowerCase():workspaceId', () => {
    const sig = computeEmailSignature('user@x.com', 'ws-1', APP_SECRET);
    expect(sig).toBe(expectedSignature('user@x.com', 'ws-1', APP_SECRET));
  });

  it('differs when the workspaceId differs', () => {
    const a = computeEmailSignature('user@x.com', 'ws-1', APP_SECRET);
    const b = computeEmailSignature('user@x.com', 'ws-2', APP_SECRET);
    expect(a).not.toBe(b);
  });

  it('is case-insensitive on the email (User@x.com === user@x.com)', () => {
    const upper = computeEmailSignature('User@x.com', 'ws-1', APP_SECRET);
    const lower = computeEmailSignature('user@x.com', 'ws-1', APP_SECRET);
    expect(upper).toBe(lower);
    // And it equals the signature computed off the lowercased form.
    expect(upper).toBe(expectedSignature('user@x.com', 'ws-1', APP_SECRET));
  });
});

describe('throwIfEmailNotVerified', () => {
  it('self-hosted (isCloud:false) -> never throws, even when unverified', () => {
    expect(() =>
      throwIfEmailNotVerified({
        isCloud: false,
        emailVerifiedAt: null,
        email: 'user@x.com',
        workspaceId: 'ws-1',
        appSecret: APP_SECRET,
      }),
    ).not.toThrow();
  });

  it('cloud + verified email -> never throws', () => {
    expect(() =>
      throwIfEmailNotVerified({
        isCloud: true,
        emailVerifiedAt: new Date(),
        email: 'user@x.com',
        workspaceId: 'ws-1',
        appSecret: APP_SECRET,
      }),
    ).not.toThrow();
  });

  it('cloud + unverified -> throws BadRequestException carrying the matching emailSignature', () => {
    let caught: unknown;
    try {
      throwIfEmailNotVerified({
        isCloud: true,
        emailVerifiedAt: null,
        email: 'user@x.com',
        workspaceId: 'ws-1',
        appSecret: APP_SECRET,
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(BadRequestException);
    const response = (caught as BadRequestException).getResponse() as {
      message: string;
      emailSignature: string;
    };
    expect(response.emailSignature).toBe(
      computeEmailSignature('user@x.com', 'ws-1', APP_SECRET),
    );
  });
});

describe('validateSsoEnforcement', () => {
  it('throws BadRequestException when SSO is enforced', () => {
    expect(() =>
      validateSsoEnforcement({ enforceSso: true } as never),
    ).toThrow(BadRequestException);
  });

  it('returns without throwing when SSO is not enforced', () => {
    expect(() =>
      validateSsoEnforcement({ enforceSso: false } as never),
    ).not.toThrow();
  });
});

describe('validateAllowedEmail', () => {
  it('passes when the workspace has no email-domain restriction (empty array)', () => {
    expect(() =>
      validateAllowedEmail('user@anywhere.com', { emailDomains: [] } as never),
    ).not.toThrow();
  });

  it('passes when emailDomains is undefined (no restriction)', () => {
    expect(() =>
      validateAllowedEmail('user@anywhere.com', {} as never),
    ).not.toThrow();
  });

  it('passes when the email domain is allowed (case-insensitive match)', () => {
    expect(() =>
      validateAllowedEmail('User@Example.COM', {
        emailDomains: ['example.com'],
      } as never),
    ).not.toThrow();
  });

  it('throws BadRequestException naming the domain when it is not allowed', () => {
    let caught: unknown;
    try {
      validateAllowedEmail('user@evil.com', {
        emailDomains: ['example.com'],
      } as never);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as BadRequestException).message).toContain('evil.com');
  });

  // Latent bug: validateAllowedEmail does `userEmail.split('@')[1].toLowerCase()`
  // with no guard, so an email without '@' throws a TypeError (cannot read
  // 'toLowerCase' of undefined) instead of a clean validation error. Flagged
  // rather than locked in as desired behaviour.
  it.todo(
    'validateAllowedEmail should reject a malformed email without @ gracefully (currently throws TypeError - needs a guard)',
  );
});
