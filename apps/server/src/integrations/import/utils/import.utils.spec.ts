import {
  stripNotionID,
  extractNotionPartialId,
  resolveRelativeAttachmentPath,
} from './import.utils';

/**
 * Unit tests for the pure helpers in import.utils.ts:
 *  - stripNotionID / extractNotionPartialId: filename suffix parsing.
 *  - resolveRelativeAttachmentPath: maps an HTML-relative attachment href onto
 *    a key that exists in the extracted-archive candidate map.
 */

describe('stripNotionID', () => {
  it('strips a 32-hex suffix preceded by a space separator', () => {
    // 32 hex chars with a leading space.
    const id = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    expect(stripNotionID(`My Page ${id}`)).toBe('My Page');
  });

  it('strips a 32-hex suffix preceded by a dash separator', () => {
    const id = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    expect(stripNotionID(`My-Page-${id}`)).toBe('My-Page');
  });

  it('strips a 32-hex suffix with no separator', () => {
    const id = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    expect(stripNotionID(`MyPage${id}`)).toBe('MyPage');
  });

  it('strips a partial UUID suffix "{4}-{4}"', () => {
    expect(stripNotionID('Cool 324d-35ab')).toBe('Cool');
  });

  it('leaves a name without an ID unchanged', () => {
    expect(stripNotionID('Just A Title')).toBe('Just A Title');
  });
});

describe('extractNotionPartialId', () => {
  it('returns prefix/suffix (lowercased) for a partial UUID folder name', () => {
    expect(extractNotionPartialId('Cool 324D-35AB')).toEqual({
      prefix: '324d',
      suffix: '35ab',
    });
  });

  it('returns null when there is no partial UUID suffix', () => {
    expect(extractNotionPartialId('No Id Here')).toBeNull();
  });

  it('returns null when the suffix lacks the leading space', () => {
    // The regex requires a leading space before "{4}-{4}".
    expect(extractNotionPartialId('Name324d-35ab')).toBeNull();
  });
});

describe('resolveRelativeAttachmentPath', () => {
  it('returns the direct candidate when it exists', () => {
    const candidates = new Map<string, string>([
      ['attachments/file.png', '/abs/attachments/file.png'],
    ]);
    expect(
      resolveRelativeAttachmentPath(
        './attachments/file.png',
        'pages',
        candidates,
      ),
    ).toBe('attachments/file.png');
  });

  it('strips the Confluence "download/attachments/" prefix to match the archive layout', () => {
    const candidates = new Map<string, string>([
      ['attachments/123/diagram.png', '/abs/attachments/123/diagram.png'],
    ]);
    expect(
      resolveRelativeAttachmentPath(
        'download/attachments/123/diagram.png',
        'pages',
        candidates,
      ),
    ).toBe('attachments/123/diagram.png');
  });

  it('decodes a percent-encoded name before matching', () => {
    const candidates = new Map<string, string>([
      ['attachments/my file.png', '/abs/attachments/my file.png'],
    ]);
    expect(
      resolveRelativeAttachmentPath(
        'attachments/my%20file.png',
        'pages',
        candidates,
      ),
    ).toBe('attachments/my file.png');
  });

  it('falls back to the raw (still-encoded) value on a malformed escape without throwing', () => {
    // "%E0%A4" is an incomplete UTF-8 sequence; decodeURIComponent throws and
    // the helper keeps the raw string, which then matches the candidate key.
    const candidates = new Map<string, string>([
      ['attachments/%E0%A4.png', '/abs/attachments/%E0%A4.png'],
    ]);
    let result: string | null = null;
    expect(() => {
      result = resolveRelativeAttachmentPath(
        'attachments/%E0%A4.png',
        'pages',
        candidates,
      );
    }).not.toThrow();
    expect(result).toBe('attachments/%E0%A4.png');
  });

  it('returns null when nothing matches', () => {
    const candidates = new Map<string, string>([
      ['attachments/other.png', '/abs/attachments/other.png'],
    ]);
    expect(
      resolveRelativeAttachmentPath(
        './attachments/missing.png',
        'pages',
        candidates,
      ),
    ).toBeNull();
  });

  it('matches via the pageDir-joined fallback path', () => {
    // raw resolves under pageDir when neither the direct nor confluence key hit.
    const candidates = new Map<string, string>([
      ['pages/sub/img.png', '/abs/pages/sub/img.png'],
    ]);
    expect(
      resolveRelativeAttachmentPath('sub/img.png', 'pages', candidates),
    ).toBe('pages/sub/img.png');
  });
});
