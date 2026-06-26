import { updateAttachmentAttr } from './share.util';

// Pins updateAttachmentAttr — the per-attachment URL rewriter used when serving
// shared page content. Internal attachment paths (/files… and /api/files…) must
// be rewritten to the public form with a scoped jwt appended; anything else
// (external URLs, null) must be left untouched so a public viewer's signed token
// is never attached to a foreign origin. The function only reads/writes
// node.attrs[attr], so a plain object stands in for the real ProseMirror Node.

function fakeNode(attrs: Record<string, any>) {
  return { attrs } as any;
}

const JWT = 'TOK';

describe('updateAttachmentAttr', () => {
  it('rewrites a /files path to /files/public/ with ?jwt=', () => {
    const node = fakeNode({ src: '/files/x.png' });
    updateAttachmentAttr(node, 'src', JWT);
    expect(node.attrs.src).toBe(`/files/public/x.png?jwt=${JWT}`);
  });

  it('rewrites an /api/files path (keeps the /api prefix, inserts public)', () => {
    const node = fakeNode({ src: '/api/files/y.png' });
    updateAttachmentAttr(node, 'src', JWT);
    expect(node.attrs.src).toBe(`/api/files/public/y.png?jwt=${JWT}`);
  });

  it('uses &jwt= when the src already carries a query string', () => {
    const node = fakeNode({ src: '/files/x.png?w=100' });
    updateAttachmentAttr(node, 'src', JWT);
    expect(node.attrs.src).toBe(`/files/public/x.png?w=100&jwt=${JWT}`);
  });

  it('leaves an external https URL untouched (no token leak to a foreign origin)', () => {
    const external = 'https://example.com/x.png';
    const node = fakeNode({ src: external });
    updateAttachmentAttr(node, 'src', JWT);
    expect(node.attrs.src).toBe(external);
  });

  it('leaves a null src untouched', () => {
    const node = fakeNode({ src: null });
    updateAttachmentAttr(node, 'src', JWT);
    expect(node.attrs.src).toBeNull();
  });

  it('rewrites the `url` attr variant the same way', () => {
    const node = fakeNode({ url: '/files/doc.pdf' });
    updateAttachmentAttr(node, 'url', JWT);
    expect(node.attrs.url).toBe(`/files/public/doc.pdf?jwt=${JWT}`);
  });

  it('only touches the requested attr, leaving the other attr alone', () => {
    const external = 'https://cdn.example.com/a.png';
    const node = fakeNode({ src: '/files/a.png', url: external });
    updateAttachmentAttr(node, 'src', JWT);
    expect(node.attrs.src).toBe(`/files/public/a.png?jwt=${JWT}`);
    // `url` was not requested, so it is unchanged.
    expect(node.attrs.url).toBe(external);
  });
});
