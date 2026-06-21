import { describeProviderError } from './ai-error.util';

/**
 * Unit tests for describeProviderError: the shared formatter used both for the
 * server log line and for the error text streamed back to the client. This
 * pins the behaviour, including the one behaviour change introduced when the
 * two inline formatters were unified: a truncated, single-line snippet of the
 * provider `responseBody`/`text` is appended (so a misconfigured endpoint's
 * HTML error page is diagnosable). The util guarantees the API key is never in
 * the response body, so this is safe to surface.
 */
describe('describeProviderError', () => {
  it('uses the fallback for a null/empty/undefined error', () => {
    expect(describeProviderError(null, 'AI stream error')).toBe(
      'AI stream error',
    );
    expect(describeProviderError('', 'AI stream error')).toBe('AI stream error');
    expect(describeProviderError(undefined)).toBe('Unknown error');
  });

  it('returns a non-empty plain string error as-is', () => {
    expect(describeProviderError('boom')).toBe('boom');
  });

  it('formats statusCode + message (non-classified status)', () => {
    // 500 is not in the well-known status map, so no label is prepended and the
    // plain "<status>: <message>" path is exercised.
    expect(
      describeProviderError({ statusCode: 500, message: 'Server error' }),
    ).toBe('500: Server error');
  });

  it('prepends an auth label for 401 (the real cause behind "User not found.")', () => {
    const out = describeProviderError({
      statusCode: 401,
      message: 'User not found.',
    });
    expect(out).toBe(
      'AI provider authentication failed (invalid or missing API key) — 401: User not found.',
    );
    // The provider status is still present after the label.
    expect(out).toContain('401:');
    // With a response body, the snippet is appended AFTER the label/detail.
    const withBody = describeProviderError({
      statusCode: 401,
      message: 'User not found.',
      responseBody: '{"error":{"message":"User not found.","code":401}}',
    });
    expect(
      withBody.startsWith(
        'AI provider authentication failed (invalid or missing API key) — 401: User not found. | response body: ',
      ),
    ).toBe(true);
    expect(withBody).toContain('| response body:');
  });

  it('prepends the same auth label for 403', () => {
    expect(
      describeProviderError({ statusCode: 403, message: 'Forbidden' }),
    ).toBe(
      'AI provider authentication failed (invalid or missing API key) — 403: Forbidden',
    );
  });

  it('prepends a billing label for 402', () => {
    expect(
      describeProviderError({ statusCode: 402, message: 'Payment Required' }),
    ).toBe(
      'AI provider rejected the request: insufficient credits or quota — 402: Payment Required',
    );
  });

  it('prepends a rate-limit label for 429', () => {
    expect(
      describeProviderError({ statusCode: 429, message: 'Too Many Requests' }),
    ).toBe('AI provider rate limit exceeded — 429: Too Many Requests');
  });

  it('falls back to message when there is no statusCode', () => {
    expect(describeProviderError({ message: 'nope' })).toBe('nope');
  });

  it('appends a whitespace-collapsed response body snippet', () => {
    const out = describeProviderError({
      statusCode: 502,
      message: 'Bad Gateway',
      responseBody: '<html>\n  <body>upstream   error</body>\n</html>',
    });
    expect(out.startsWith('502: Bad Gateway | response body: ')).toBe(true);
    // Newlines and runs of spaces are collapsed to single spaces.
    expect(out).toContain('<html> <body>upstream error</body> </html>');
  });

  it('reads `text` when responseBody is absent', () => {
    expect(describeProviderError({ message: 'e', text: 'body-text' })).toBe(
      'e | response body: body-text',
    );
  });

  it('truncates a long body to 300 chars + ellipsis', () => {
    const out = describeProviderError({
      message: 'e',
      responseBody: 'x'.repeat(500),
    });
    expect(out).toContain('…');
    // 'e | response body: ' + 300 chars + '…'
    expect(out.length).toBeLessThan('e | response body: '.length + 305);
  });

  it('uses the fallback for a numeric or boolean (non-object, non-string) error', () => {
    // typeof number / boolean is neither 'object' nor a non-empty 'string', so
    // the early branch returns the fallback verbatim.
    expect(describeProviderError(500, 'AI stream error')).toBe('AI stream error');
    expect(describeProviderError(0, 'AI stream error')).toBe('AI stream error');
    expect(describeProviderError(true)).toBe('Unknown error');
    expect(describeProviderError(false, 'fb')).toBe('fb');
  });

  it('statusCode present but message undefined => "<code>:" with no trailing space', () => {
    // `${code}: ${undefined ?? ''}`.trim() collapses to just "<code>:".
    expect(describeProviderError({ statusCode: 503 })).toBe('503:');
    // The trailing space after the colon is trimmed away.
    expect(describeProviderError({ statusCode: 503 }).endsWith(': ')).toBe(false);
  });

  it('object with neither message nor statusCode nor body => fallback', () => {
    expect(describeProviderError({}, 'AI stream error')).toBe('AI stream error');
    // An object carrying only unrelated keys is still treated as message-less.
    expect(describeProviderError({ foo: 'bar' } as never)).toBe('Unknown error');
  });
});
