import { buildShareMetaHtml } from './share-seo.util';

// Pins the SEO meta-HTML builder for public share pages (extracted verbatim from
// ShareSeoController.getShare). The shared page title is attacker-influenceable,
// so the security-critical invariant is that it is htmlEscape'd before being
// interpolated into BOTH the <title> element and the content="..." attributes of
// the og:/twitter: meta tags. The XSS tests below MUST fail if the htmlEscape
// step is ever removed.

// A minimal index.html shell carrying the two placeholders the builder rewrites:
// the <title> element and the <!--meta-tags--> marker.
const INDEX =
  '<html><head><title>App</title>\n    <!--meta-tags--></head><body>x</body></html>';

describe('buildShareMetaHtml', () => {
  describe('XSS: title escaping', () => {
    it('fully htmlEscapes a </title><script> breakout in BOTH <title> and og:/twitter: meta', () => {
      const out = buildShareMetaHtml(INDEX, {
        title: '</title><script>alert(1)</script>',
        searchIndexing: true,
      });

      // The raw script tag must NEVER appear anywhere in the output — it would
      // execute in the share origin. This assertion fails if htmlEscape is removed.
      expect(out).not.toContain('<script>');
      expect(out).not.toContain('</title><script>');
      // The dangerous chars are escaped to entities instead.
      expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      // og:title and twitter:title both carry the escaped (not raw) value.
      expect(out).toContain(
        '<meta property="og:title" content="&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;" />',
      );
      expect(out).toContain(
        '<meta property="twitter:title" content="&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;" />',
      );
    });

    it('escapes a double quote to &quot; so the content="..." attribute cannot be broken', () => {
      const out = buildShareMetaHtml(INDEX, {
        title: 'a"onmouseover="alert(1)',
        searchIndexing: true,
      });

      // A raw `"` would close the content attribute and inject a new attribute.
      expect(out).not.toContain('content="a"onmouseover=');
      expect(out).toContain('&quot;');
      expect(out).toContain(
        '<meta property="og:title" content="a&quot;onmouseover=&quot;alert(1)" />',
      );
    });
  });

  describe('title truncation (limit 80, applied AFTER escaping)', () => {
    it('leaves a title of exactly 80 chars untouched (no ellipsis)', () => {
      const title = 'a'.repeat(80);
      const out = buildShareMetaHtml(INDEX, { title, searchIndexing: true });
      expect(out).toContain(`<title>${title}</title>`);
      expect(out).not.toContain('…');
    });

    it('truncates a >80 char title to 77 chars + an ellipsis (78 total)', () => {
      const title = 'b'.repeat(100);
      const out = buildShareMetaHtml(INDEX, { title, searchIndexing: true });
      const expected = `${'b'.repeat(77)}…`;
      expect(out).toContain(`<title>${expected}</title>`);
      // 77 visible chars + the single ellipsis glyph.
      expect(expected.length).toBe(78);
      expect(out).toContain(
        `<meta property="og:title" content="${expected}" />`,
      );
    });

    it('truncation acts on the ESCAPED string: each < becomes &lt; first, then slice(0,77)', () => {
      // 100 "<" chars escape to 100 * "&lt;" = 400 chars, then truncate to 77 + …
      const title = '<'.repeat(100);
      const out = buildShareMetaHtml(INDEX, { title, searchIndexing: true });
      const escaped = '&lt;'.repeat(100);
      const expected = `${escaped.slice(0, 77)}…`;
      expect(out).toContain(`<title>${expected}</title>`);
      // No raw "<" from the title leaks through.
      expect(out).not.toContain('<<');
    });
  });

  describe('robots noindex meta', () => {
    it('searchIndexing=false emits <meta name="robots" content="noindex">', () => {
      const out = buildShareMetaHtml(INDEX, {
        title: 'page',
        searchIndexing: false,
      });
      expect(out).toContain('<meta name="robots" content="noindex" />');
    });

    it('searchIndexing=true emits NO robots tag', () => {
      const out = buildShareMetaHtml(INDEX, {
        title: 'page',
        searchIndexing: true,
      });
      expect(out).not.toContain('robots');
      expect(out).not.toContain('noindex');
    });
  });

  describe('null / missing title fallback', () => {
    it('falls back to "untitled" when title is null', () => {
      const out = buildShareMetaHtml(INDEX, {
        title: null as unknown as string,
        searchIndexing: true,
      });
      expect(out).toContain('<title>untitled</title>');
      expect(out).toContain('<meta property="og:title" content="untitled" />');
    });
  });

  describe('placeholder replacement', () => {
    it('replaces the original <title> and the <!--meta-tags--> marker', () => {
      const out = buildShareMetaHtml(INDEX, {
        title: 'Hello',
        searchIndexing: true,
      });
      expect(out).not.toContain('<!--meta-tags-->');
      expect(out).not.toContain('<title>App</title>');
      expect(out).toContain('<title>Hello</title>');
    });
  });
});
