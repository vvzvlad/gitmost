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

  it('formats statusCode + message', () => {
    expect(
      describeProviderError({ statusCode: 401, message: 'Unauthorized' }),
    ).toBe('401: Unauthorized');
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
