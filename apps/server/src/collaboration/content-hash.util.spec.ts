import { canonicalStringify, pageContentHash } from './content-hash.util';

/**
 * #647 §A / R3 / R7 — the ONE content-hash util. These pin the canonical policy:
 * object key order MUST NOT change the hash, array order MUST, and equal PM docs
 * hash equal while different ones differ (the whole point of the CAS base hash).
 */
describe('pageContentHash / canonicalStringify (#647 §A)', () => {
  const doc = (text: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });

  it('is a 64-char sha256 hex string', () => {
    expect(pageContentHash(doc('hello'))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is INDEPENDENT of object key order (canonical: keys sorted)', () => {
    const a = { type: 'doc', content: [], attrs: { b: 1, a: 2 } };
    const b = { attrs: { a: 2, b: 1 }, content: [], type: 'doc' };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
    expect(pageContentHash(a)).toBe(pageContentHash(b));
  });

  it('DEPENDS on array order (order is meaningful in a PM doc)', () => {
    const one = {
      type: 'doc',
      content: [doc('a').content[0], doc('b').content[0]],
    };
    const two = {
      type: 'doc',
      content: [doc('b').content[0], doc('a').content[0]],
    };
    expect(pageContentHash(one)).not.toBe(pageContentHash(two));
  });

  it('equal docs hash equal; a changed text hashes differently', () => {
    expect(pageContentHash(doc('same'))).toBe(pageContentHash(doc('same')));
    expect(pageContentHash(doc('one'))).not.toBe(pageContentHash(doc('two')));
  });

  it('drops undefined object properties (JSON.stringify parity)', () => {
    expect(canonicalStringify({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(pageContentHash({ a: 1, b: undefined })).toBe(
      pageContentHash({ a: 1 }),
    );
  });

  it('emits no insignificant whitespace', () => {
    expect(canonicalStringify(doc('x'))).not.toMatch(/\s/);
  });

  it('handles primitives and null', () => {
    expect(canonicalStringify(null)).toBe('null');
    expect(canonicalStringify(42)).toBe('42');
    expect(canonicalStringify('s')).toBe('"s"');
  });
});
