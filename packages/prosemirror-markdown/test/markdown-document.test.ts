import { describe, expect, it } from 'vitest';
import {
  serializeDocmostMarkdownBody,
  parseDocmostMarkdown,
  type DocmostMdMeta,
} from 'docmost-client';

describe('serializeDocmostMarkdownBody round-trip (SPEC §3)', () => {
  it('serialize -> parse preserves meta and the trimmed body, with no comments block', () => {
    const meta: DocmostMdMeta = {
      version: 1,
      pageId: 'page-123',
      slugId: 'slug-abc',
      title: 'My Page',
      spaceId: 'space-1',
      parentPageId: 'parent-9',
    };
    const body = 'Hello\n\nWorld';

    const file = serializeDocmostMarkdownBody(meta, body);
    const parsed = parseDocmostMarkdown(file);

    expect(parsed.meta).toEqual(meta);
    expect(parsed.body).toBe(body);
    // No trailing docmost:comments block was emitted (SPEC §3).
    expect(parsed.comments).toBeNull();
  });

  it('preserves a null parentPageId for a root page', () => {
    const meta: DocmostMdMeta = {
      version: 1,
      pageId: 'root-1',
      slugId: 'root-slug',
      title: 'Root',
      spaceId: 'space-1',
      parentPageId: null,
    };
    const file = serializeDocmostMarkdownBody(meta, 'body text');
    const parsed = parseDocmostMarkdown(file);
    expect(parsed.meta).toEqual(meta);
    expect(parsed.comments).toBeNull();
  });

  it('produces a parseable file for an empty/missing body', () => {
    const meta: DocmostMdMeta = { version: 1, pageId: 'p-empty' };

    // Empty string body.
    const emptyFile = serializeDocmostMarkdownBody(meta, '');
    expect(() => parseDocmostMarkdown(emptyFile)).not.toThrow();
    const parsedEmpty = parseDocmostMarkdown(emptyFile);
    expect(parsedEmpty.meta).toEqual(meta);
    expect(parsedEmpty.body).toBe('');
    expect(parsedEmpty.comments).toBeNull();

    // Missing body (undefined) — serializer coalesces to "".
    const missingFile = serializeDocmostMarkdownBody(
      meta,
      undefined as unknown as string,
    );
    expect(() => parseDocmostMarkdown(missingFile)).not.toThrow();
    const parsedMissing = parseDocmostMarkdown(missingFile);
    expect(parsedMissing.meta).toEqual(meta);
    expect(parsedMissing.body).toBe('');
    expect(parsedMissing.comments).toBeNull();
  });
});
