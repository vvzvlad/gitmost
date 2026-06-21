import { resolveFrameHeader } from './security-headers';

describe('resolveFrameHeader', () => {
  describe('iframe embedding disabled (clickjacking protection)', () => {
    it('returns X-Frame-Options SAMEORIGIN and ignores origins', () => {
      expect(resolveFrameHeader(false, [])).toEqual({
        name: 'X-Frame-Options',
        value: 'SAMEORIGIN',
      });
    });

    it('still returns X-Frame-Options even when origins are configured', () => {
      // A wrong branch could leak a permissive CSP here; origins must be ignored
      // when embedding is disabled so clickjacking protection stays intact.
      const result = resolveFrameHeader(false, [
        'https://a.com',
        'https://b.com',
      ]);
      expect(result).toEqual({
        name: 'X-Frame-Options',
        value: 'SAMEORIGIN',
      });
      expect(result?.name).not.toBe('Content-Security-Policy');
    });
  });

  describe('iframe embedding allowed', () => {
    it('returns null when there are no allowed origins', () => {
      expect(resolveFrameHeader(true, [])).toBeNull();
    });

    it('builds a frame-ancestors CSP for a single origin', () => {
      expect(resolveFrameHeader(true, ['https://a.com'])).toEqual({
        name: 'Content-Security-Policy',
        value: "frame-ancestors 'self' https://a.com",
      });
    });

    it('space-joins multiple origins after self', () => {
      expect(
        resolveFrameHeader(true, [
          'https://a.com',
          'https://b.com',
          'https://c.com',
        ]),
      ).toEqual({
        name: 'Content-Security-Policy',
        value: "frame-ancestors 'self' https://a.com https://b.com https://c.com",
      });
    });
  });
});
