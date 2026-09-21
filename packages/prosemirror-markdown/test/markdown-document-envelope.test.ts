import { describe, expect, it } from 'vitest';
// Import DIRECTLY from src (NOT the docmost-client barrel, which pulls in
// collaboration.ts and mutates global DOM at import time).
import {
  serializeDocmostMarkdown,
  parseDocmostMarkdown,
  serializeDocmostMarkdownBody,
  type DocmostMdMeta,
} from '../src/lib/markdown-document.js';

const meta: DocmostMdMeta = {
  version: 1,
  pageId: 'p1',
  slugId: 's1',
  title: 'Hello',
  spaceId: 'sp1',
  parentPageId: null,
};

describe('serializeDocmostMarkdown / parseDocmostMarkdown', () => {
  // ---------------------------------------------------------------------------
  describe('round-trip', () => {
    it('round-trips meta, body, and comments', () => {
      const body = '# Title\n\nSome **body** text.';
      const comments = [{ id: 'c1', text: 'a note' }];
      const full = serializeDocmostMarkdown(meta, body, comments);
      const parsed = parseDocmostMarkdown(full);
      expect(parsed.meta).toEqual(meta);
      expect(parsed.body).toBe(body);
      expect(parsed.comments).toEqual(comments);
    });

    it('emits a comments block with [] even when there are no comments', () => {
      const full = serializeDocmostMarkdown(meta, 'body', []);
      expect(full).toContain('<!-- docmost:comments\n[]\n-->');
      const parsed = parseDocmostMarkdown(full);
      expect(parsed.comments).toEqual([]);
      expect(parsed.body).toBe('body');
    });

    it('non-array comments arg is normalized to [] in the serialized output', () => {
      const full = serializeDocmostMarkdown(meta, 'body', null as any);
      expect(full).toContain('<!-- docmost:comments\n[]\n-->');
    });

    it('trims surrounding whitespace from the body on serialize', () => {
      const full = serializeDocmostMarkdown(meta, '\n\n  body  \n\n', []);
      const parsed = parseDocmostMarkdown(full);
      expect(parsed.body).toBe('body');
    });
  });

  // ---------------------------------------------------------------------------
  describe('missing blocks (tolerant parsing)', () => {
    it('missing meta block yields meta:null', () => {
      const input = 'Just a body.\n\n<!-- docmost:comments\n[]\n-->\n';
      const parsed = parseDocmostMarkdown(input);
      expect(parsed.meta).toBeNull();
      expect(parsed.body).toBe('Just a body.');
      expect(parsed.comments).toEqual([]);
    });

    it('missing comments block yields comments:null and treats all as body', () => {
      const input =
        '<!-- docmost:meta\n' + JSON.stringify(meta) + '\n-->\n\nbody only';
      const parsed = parseDocmostMarkdown(input);
      expect(parsed.meta).toEqual(meta);
      expect(parsed.comments).toBeNull();
      expect(parsed.body).toBe('body only');
    });

    it('plain markdown with neither block: meta and comments null, whole input is body', () => {
      const input = '# Plain\n\nNo envelope here.';
      const parsed = parseDocmostMarkdown(input);
      expect(parsed.meta).toBeNull();
      expect(parsed.comments).toBeNull();
      expect(parsed.body).toBe(input);
    });
  });

  // ---------------------------------------------------------------------------
  describe('CRLF normalization', () => {
    it('parses a CRLF-encoded document the same as LF', () => {
      const lf = serializeDocmostMarkdown(meta, 'line one\nline two', [
        { id: 'c1' },
      ]);
      const crlf = lf.replace(/\n/g, '\r\n');
      const parsed = parseDocmostMarkdown(crlf);
      expect(parsed.meta).toEqual(meta);
      expect(parsed.body).toBe('line one\nline two');
      expect(parsed.comments).toEqual([{ id: 'c1' }]);
    });
  });

  // ---------------------------------------------------------------------------
  describe('only the final document-ending comments block is captured', () => {
    it('an earlier literal docmost:comments opener inside the body stays in the body', () => {
      // The body documents the format and contains a literal opener that does
      // NOT end the document. Only the trailing block is treated as metadata.
      const bodyWithLiteral =
        'Here is how the format looks:\n\n<!-- docmost:comments\n[{"fake":true}]\n-->\n\nand more prose after it.';
      const full = serializeDocmostMarkdown(meta, bodyWithLiteral, [
        { id: 'real' },
      ]);
      const parsed = parseDocmostMarkdown(full);
      // The real (final) block parses into the comments...
      expect(parsed.comments).toEqual([{ id: 'real' }]);
      // ...and the earlier literal opener is preserved verbatim in the body.
      expect(parsed.body).toContain(
        '<!-- docmost:comments\n[{"fake":true}]\n-->',
      );
      expect(parsed.body).toContain('and more prose after it.');
    });

    it('a literal opener whose closer does NOT end the doc is left entirely in the body', () => {
      // No real trailing block: the opener is not document-ending, so comments
      // stays null and nothing is stripped.
      const input =
        '<!-- docmost:meta\n' +
        JSON.stringify(meta) +
        '\n-->\n\nbody start\n\n<!-- docmost:comments\n[]\n-->\n\ntrailing text not ending the doc';
      const parsed = parseDocmostMarkdown(input);
      expect(parsed.comments).toBeNull();
      expect(parsed.body).toContain('<!-- docmost:comments');
      expect(parsed.body).toContain('trailing text not ending the doc');
    });
  });

  // ---------------------------------------------------------------------------
  describe('end-anchored comments closer tolerates CRLF + trailing whitespace', () => {
    it('captures the final comments block when its "-->" closer has CRLF and trailing spaces', () => {
      // The closer regex is /\r?\n-->[ \t]*\r?\n?\s*$/. Build a document whose
      // trailing comments block uses CRLF line endings AND has trailing spaces
      // after the "-->" closer, then assert it is still recognised as the
      // document-ending block (and the body is not polluted by it).
      const metaLine = JSON.stringify(meta);
      const crlfDoc =
        `<!-- docmost:meta\r\n${metaLine}\r\n-->\r\n\r\n` +
        `the body line\r\n\r\n` +
        `<!-- docmost:comments\r\n[{"id":"c-crlf"}]\r\n-->  \r\n`;
      const parsed = parseDocmostMarkdown(crlfDoc);
      expect(parsed.meta).toEqual(meta);
      expect(parsed.body).toBe('the body line');
      expect(parsed.comments).toEqual([{ id: 'c-crlf' }]);
    });
  });

  // ---------------------------------------------------------------------------
  describe('malformed JSON throws a clear error', () => {
    it('throws on malformed meta JSON', () => {
      const input = '<!-- docmost:meta\n{not valid json}\n-->\n\nbody';
      expect(() => parseDocmostMarkdown(input)).toThrow(/docmost:meta JSON/);
    });

    it('throws on malformed comments JSON', () => {
      const input = 'body\n\n<!-- docmost:comments\n[not, valid]\n-->\n';
      expect(() => parseDocmostMarkdown(input)).toThrow(/docmost:comments JSON/);
    });
  });
});

describe('serializeDocmostMarkdownBody', () => {
  it('emits NO comments block', () => {
    const out = serializeDocmostMarkdownBody(meta, 'just the body');
    expect(out).not.toContain('docmost:comments');
    expect(out).toContain('<!-- docmost:meta');
  });

  it('serialize -> parse preserves meta and the trimmed body, comments null (SPEC §3)', () => {
    const fullMeta: DocmostMdMeta = {
      version: 1,
      pageId: 'page-123',
      slugId: 'slug-abc',
      title: 'My Page',
      spaceId: 'space-1',
      parentPageId: 'parent-9',
    };
    const body = 'Hello\n\nWorld';
    const out = serializeDocmostMarkdownBody(fullMeta, body);
    const parsed = parseDocmostMarkdown(out);
    expect(parsed.meta).toEqual(fullMeta);
    expect(parsed.body).toBe(body);
    expect(parsed.comments).toBeNull();
  });

  it('preserves a null parentPageId for a root page', () => {
    const out = serializeDocmostMarkdownBody(meta, 'body text');
    const parsed = parseDocmostMarkdown(out);
    expect(parsed.meta).toEqual(meta);
    expect(parsed.comments).toBeNull();
  });

  it('produces a parseable file for an empty or missing body', () => {
    const minimal: DocmostMdMeta = { version: 1, pageId: 'p-empty' };

    const emptyFile = serializeDocmostMarkdownBody(minimal, '');
    const parsedEmpty = parseDocmostMarkdown(emptyFile);
    expect(parsedEmpty.meta).toEqual(minimal);
    expect(parsedEmpty.body).toBe('');
    expect(parsedEmpty.comments).toBeNull();

    // Missing body (undefined) — serializer coalesces to "".
    const missingFile = serializeDocmostMarkdownBody(
      minimal,
      undefined as unknown as string,
    );
    const parsedMissing = parseDocmostMarkdown(missingFile);
    expect(parsedMissing.meta).toEqual(minimal);
    expect(parsedMissing.body).toBe('');
    expect(parsedMissing.comments).toBeNull();
  });

  it('trims the body', () => {
    const out = serializeDocmostMarkdownBody(meta, '\n\n  hi  \n');
    const parsed = parseDocmostMarkdown(out);
    expect(parsed.body).toBe('hi');
  });
});
