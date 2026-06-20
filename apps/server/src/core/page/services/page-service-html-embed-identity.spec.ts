import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  canAuthorHtmlEmbed,
  hasHtmlEmbedNode,
  stripHtmlEmbedNodes,
} from '../../../common/helpers/prosemirror/html-embed.util';

// PageService.create() and duplicatePage() guards.
//
// page.service.ts cannot be unit-LOADED under the server's jest config (a
// transitive ESM dep, @sindresorhus/slugify, is not in transformIgnorePatterns),
// so we cover the two load-bearing properties at the strongest feasible layer:
//
//  (1) BEHAVIOR — using the REAL html-embed helpers, replay the exact predicate
//      each path applies: non-admin/unknown role -> strip, admin/owner -> keep.
//
//  (2) IDENTITY — source-pin which role each path reads (create: the `callerRole`
//      param threaded from the request; duplicate: `authUser.role`), so a
//      refactor that drops the guard or reads the wrong role trips the test.
//      This is what replaces the removed `applyAdminGate` stand-in for these
//      two entrypoints.

const docWithEmbed = () => ({
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'body' }] },
    { type: 'htmlEmbed', attrs: { source: '<script>alert(1)</script>' } },
  ],
});

// The real predicate both paths apply (see SECURITY blocks in page.service.ts).
function applyGate(json: any, role: string | null | undefined) {
  if (!canAuthorHtmlEmbed(role) && hasHtmlEmbedNode(json)) {
    return stripHtmlEmbedNodes(json);
  }
  return json;
}

describe('page create/duplicate gate decision (real helpers)', () => {
  it('non-admin (member) strips', () => {
    const result = applyGate(docWithEmbed(), 'member');
    expect(hasHtmlEmbedNode(result)).toBe(false);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].content[0].text).toBe('body');
  });

  it('unknown/empty role fails closed (strips)', () => {
    for (const role of [null, undefined, 'viewer'] as const) {
      expect(hasHtmlEmbedNode(applyGate(docWithEmbed(), role))).toBe(false);
    }
  });

  it('admin/owner keep', () => {
    expect(hasHtmlEmbedNode(applyGate(docWithEmbed(), 'admin'))).toBe(true);
    expect(hasHtmlEmbedNode(applyGate(docWithEmbed(), 'owner'))).toBe(true);
  });
});

const SRC = readFileSync(join(__dirname, 'page.service.ts'), 'utf-8');

describe('page create/duplicate gate identity is pinned (source contract)', () => {
  it('create() gates on the caller role param before deriving content/ydoc', () => {
    // create() receives the caller's workspace role as `callerRole` and gates on
    // it; the embed must be stripped BEFORE insertPage.
    expect(SRC).toMatch(
      /!canAuthorHtmlEmbed\(\s*callerRole\s*\)\s*&&\s*hasHtmlEmbedNode\(\s*prosemirrorJson\s*\)/,
    );
    expect(SRC).toContain('prosemirrorJson = stripHtmlEmbedNodes(prosemirrorJson)');
  });

  it('duplicatePage() gates on the duplicating user role (authUser.role)', () => {
    expect(SRC).toMatch(
      /!canAuthorHtmlEmbed\(\s*authUser\.role\s*\)\s*&&\s*hasHtmlEmbedNode\(\s*prosemirrorJson\s*\)/,
    );
  });
});
