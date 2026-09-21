import { INTERNAL_LINK_REGEX } from './utils';
import { isInternalPagePath } from '@docmost/prosemirror-markdown';

/**
 * Cross-package DRIFT GUARD for the internal-link subset invariant (#522).
 *
 * The client-side `isInternalPagePath`
 * (`packages/prosemirror-markdown/src/lib/internal-links.ts`) promotes a markdown
 * link to `internal: true` on import. Every link it marks internal MUST be one
 * the server would backlink and export-rewrite — i.e. the client matcher MUST be
 * a STRICT SUBSET of the server's canonical `INTERNAL_LINK_REGEX`
 * (`./utils.ts`). If the client ever accepts a path the server rejects, that link
 * is stored internal but silently dropped from the backlink graph and broken on
 * export — the exact bug #522 fixed.
 *
 * This spec is the load-bearing guard: it imports the LIVE server regex AND the
 * LIVE `isInternalPagePath` (no hand-copied regex on either side). A narrowing of
 * EITHER — most dangerously the server regex — reddens here. The in-package
 * accept/reject test documents the client's behaviour but cannot see the server
 * regex; this top-layer spec is what makes the subset relation mechanical
 * (AGENTS.md rule #7: a CI test that fails on drift of the source of truth).
 */
describe('internal-link subset parity (client isInternalPagePath ⊆ server INTERNAL_LINK_REGEX)', () => {
  // Every path the CLIENT accepts. Kept deliberately broad across the risky
  // dimensions — the slug charset (digits, hyphens, mixed case, leading/trailing
  // hyphen), the space charset, and the optional trailing slash — so a narrowing
  // of the server regex on any of them reddens the subset assertion below.
  const CLIENT_ACCEPTS = [
    '/s/eng/p/abc123',
    '/s/eng/p/abc123/', // trailing slash
    '/s/My-Space/p/A-b-C-9', // hyphens + mixed case in both segments
    '/s/x/p/z', // shortest
    '/s/eng/p/my-page-abc123', // slug with hyphens (extractPageSlugId shape)
    '/s/eng/p/-lead', // leading hyphen in slug
    '/s/eng/p/trail-', // trailing hyphen in slug
    '/s/eng/p/0123456789', // all-digit slug
    '/s/a.b/p/abc', // dot in the SPACE segment (space charset is [^/]+)
    '/s/space with space/p/abc', // space char in the SPACE segment
  ];

  it('every corpus path is actually client-accepted (guards the corpus itself)', () => {
    // If a path here stopped being client-accepted the subset test would pass
    // vacuously; assert acceptance up front so the corpus stays meaningful. The
    // filter-to-empty form names the offending paths on failure.
    const notAccepted = CLIENT_ACCEPTS.filter((h) => !isInternalPagePath(h));
    expect(notAccepted).toEqual([]);
  });

  it('every client-accepted path also matches the LIVE server regex (subset)', () => {
    // The mechanical drift guard: narrow the server INTERNAL_LINK_REGEX and at
    // least one hyphen/charset/structure case appears here.
    const notInServer = CLIENT_ACCEPTS.filter((h) => !INTERNAL_LINK_REGEX.test(h));
    expect(notInServer).toEqual([]);
  });

  it('the client rejects forbidden-slug-char paths the server also rejects', () => {
    // Documents the subset BOUNDARY: correct shape, forbidden slug char. The
    // client and the LIVE server regex must agree on rejection.
    const forbidden = [
      '/s/eng/p/abc.def',
      '/s/eng/p/abc_def',
      '/s/eng/p/abc%20',
      '/s/eng/p/abc~x',
    ];
    const clientAccepts = forbidden.filter((h) => isInternalPagePath(h));
    const serverAccepts = forbidden.filter((h) => INTERNAL_LINK_REGEX.test(h));
    expect(clientAccepts).toEqual([]);
    expect(serverAccepts).toEqual([]);
  });
});
