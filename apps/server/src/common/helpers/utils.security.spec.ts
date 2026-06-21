import { FastifyRequest } from 'fastify';
import {
  redactSensitiveUrl,
  extractBearerTokenFromHeader,
  parseRedisUrl,
  normalizePostgresUrl,
  diffAuditTrackedFields,
  isUserDisabled,
} from './utils';

/**
 * Build a minimal FastifyRequest-shaped object carrying just the authorization
 * header, which is all extractBearerTokenFromHeader reads.
 */
function reqWithAuth(authorization?: string): FastifyRequest {
  return { headers: { authorization } } as unknown as FastifyRequest;
}

describe('redactSensitiveUrl', () => {
  it('strips the query string from a sensitive (SSO) URL', () => {
    expect(
      redactSensitiveUrl('/api/sso/google/callback?code=secret&state=pii'),
    ).toBe('/api/sso/google/callback');
  });

  it('returns a sensitive URL unchanged when it has no query string', () => {
    expect(redactSensitiveUrl('/api/sso/google/callback')).toBe(
      '/api/sso/google/callback',
    );
  });

  it('does NOT strip the query string from a non-sensitive URL', () => {
    // A mutation that redacts everything would break legitimate logging here.
    expect(redactSensitiveUrl('/api/pages/list?page=2&token=abc')).toBe(
      '/api/pages/list?page=2&token=abc',
    );
  });

  it('handles empty string without throwing and returns it unchanged', () => {
    expect(redactSensitiveUrl('')).toBe('');
  });

  it('handles undefined input without throwing', () => {
    expect(
      redactSensitiveUrl(undefined as unknown as string),
    ).toBeUndefined();
  });
});

describe('extractBearerTokenFromHeader', () => {
  it('extracts the token from a Bearer scheme', () => {
    expect(extractBearerTokenFromHeader(reqWithAuth('Bearer xyz'))).toBe('xyz');
  });

  it('is case-insensitive on the scheme', () => {
    // Impl lowercases the scheme before comparing, so lowercase "bearer" works.
    expect(extractBearerTokenFromHeader(reqWithAuth('bearer xyz'))).toBe('xyz');
    expect(extractBearerTokenFromHeader(reqWithAuth('BEARER xyz'))).toBe('xyz');
  });

  it('rejects a non-Bearer scheme (auth bypass guard)', () => {
    expect(
      extractBearerTokenFromHeader(reqWithAuth('Basic xyz')),
    ).toBeUndefined();
  });

  it('returns undefined when the header is missing', () => {
    expect(extractBearerTokenFromHeader(reqWithAuth(undefined))).toBeUndefined();
  });

  it('returns undefined for an empty header', () => {
    expect(extractBearerTokenFromHeader(reqWithAuth(''))).toBeUndefined();
  });

  it('returns undefined when the scheme has no token', () => {
    expect(
      extractBearerTokenFromHeader(reqWithAuth('Bearer')),
    ).toBeUndefined();
  });
});

describe('parseRedisUrl', () => {
  it('parses a full URL into host/port/password/db/family', () => {
    expect(parseRedisUrl('redis://user:pass@host:6379/3?family=6')).toEqual({
      host: 'host',
      port: 6379,
      password: 'pass',
      db: 3,
      family: 6,
    });
  });

  it('defaults db to 0 when there is no /db path segment', () => {
    const cfg = parseRedisUrl('redis://localhost:6379');
    expect(cfg.db).toBe(0);
    expect(cfg.host).toBe('localhost');
    expect(cfg.port).toBe(6379);
    // No family query → undefined (not parsed).
    expect(cfg.family).toBeUndefined();
  });

  it('falls back to db 0 for a non-numeric db segment', () => {
    expect(parseRedisUrl('redis://localhost:6379/abc').db).toBe(0);
  });

  it('returns an empty-string password when the URL has no credentials', () => {
    // Quirk: WHATWG URL exposes a missing password as '' (empty string),
    // not undefined, so the helper propagates ''.
    const cfg = parseRedisUrl('redis://localhost:6379/1');
    expect(cfg.password).toBe('');
    expect(cfg.db).toBe(1);
  });
});

describe('normalizePostgresUrl', () => {
  it('removes sslmode=no-verify but keeps other sslmode values', () => {
    expect(
      normalizePostgresUrl(
        'postgres://u:p@host:5432/db?sslmode=no-verify',
      ),
    ).toBe('postgres://u:p@host:5432/db');

    expect(
      normalizePostgresUrl('postgres://u:p@host:5432/db?sslmode=require'),
    ).toBe('postgres://u:p@host:5432/db?sslmode=require');
  });

  it('removes the schema param while preserving unrelated params', () => {
    expect(
      normalizePostgresUrl(
        'postgres://u:p@host:5432/db?schema=public&application_name=app',
      ),
    ).toBe('postgres://u:p@host:5432/db?application_name=app');
  });

  it('returns a URL with no query string untouched', () => {
    expect(normalizePostgresUrl('postgres://u:p@host:5432/db')).toBe(
      'postgres://u:p@host:5432/db',
    );
  });
});

describe('diffAuditTrackedFields', () => {
  const fields = ['name', 'email', 'settings'] as const;

  it('returns a before/after entry for a changed tracked field', () => {
    expect(
      diffAuditTrackedFields(
        fields,
        { name: 'new' },
        { name: 'old' },
        { name: 'new' },
      ),
    ).toEqual({ before: { name: 'old' }, after: { name: 'new' } });
  });

  it('skips a field whose value is unchanged', () => {
    expect(
      diffAuditTrackedFields(
        fields,
        { name: 'same' },
        { name: 'same' },
        { name: 'same' },
      ),
    ).toBeNull();
  });

  it('skips a field that is absent from the dto (undefined guard)', () => {
    // before/after differ, but the dto does not carry this field → not tracked.
    expect(
      diffAuditTrackedFields(
        fields,
        {},
        { name: 'old' },
        { name: 'new' },
      ),
    ).toBeNull();
  });

  it('returns null when nothing changed across all fields', () => {
    expect(
      diffAuditTrackedFields(
        fields,
        { name: 'a', email: 'b@x' },
        { name: 'a', email: 'b@x' },
        { name: 'a', email: 'b@x' },
      ),
    ).toBeNull();
  });

  it('treats null and undefined as equal (no false diff)', () => {
    // before has explicit null, after omits the key (undefined) → both ?? null.
    expect(
      diffAuditTrackedFields(
        fields,
        { email: 'present' },
        { email: null },
        {},
      ),
    ).toBeNull();
  });

  it('compares object-valued fields structurally via JSON.stringify', () => {
    // Distinct object references with equal contents must NOT register a diff.
    expect(
      diffAuditTrackedFields(
        fields,
        { settings: { theme: 'dark' } },
        { settings: { theme: 'dark' } },
        { settings: { theme: 'dark' } },
      ),
    ).toBeNull();

    expect(
      diffAuditTrackedFields(
        fields,
        { settings: { theme: 'dark' } },
        { settings: { theme: 'light' } },
        { settings: { theme: 'dark' } },
      ),
    ).toEqual({
      before: { settings: { theme: 'light' } },
      after: { settings: { theme: 'dark' } },
    });
  });
});

describe('isUserDisabled', () => {
  it('returns false for an active user', () => {
    expect(isUserDisabled({ deactivatedAt: null, deletedAt: null })).toBe(false);
    expect(isUserDisabled({})).toBe(false);
  });

  it('returns true for a deactivated user', () => {
    expect(
      isUserDisabled({ deactivatedAt: new Date('2026-01-01'), deletedAt: null }),
    ).toBe(true);
  });

  it('returns true for a deleted user', () => {
    expect(
      isUserDisabled({ deactivatedAt: null, deletedAt: new Date('2026-01-01') }),
    ).toBe(true);
  });
});
