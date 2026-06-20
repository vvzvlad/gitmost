import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  hasHtmlEmbedNode,
  htmlEmbedAllowed,
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

// The real predicate both paths apply (see SECURITY blocks in page.service.ts):
// toggle AND admin.
function applyGate(
  json: any,
  featureEnabled: boolean,
  role: string | null | undefined,
) {
  if (!htmlEmbedAllowed(featureEnabled, role) && hasHtmlEmbedNode(json)) {
    return stripHtmlEmbedNodes(json);
  }
  return json;
}

describe('page create/duplicate gate decision (real helpers)', () => {
  it('toggle ON + non-admin (member) strips', () => {
    const result = applyGate(docWithEmbed(), true, 'member');
    expect(hasHtmlEmbedNode(result)).toBe(false);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].content[0].text).toBe('body');
  });

  it('toggle ON + unknown/empty role fails closed (strips)', () => {
    for (const role of [null, undefined, 'viewer'] as const) {
      expect(hasHtmlEmbedNode(applyGate(docWithEmbed(), true, role))).toBe(
        false,
      );
    }
  });

  it('toggle ON + admin/owner keep', () => {
    expect(hasHtmlEmbedNode(applyGate(docWithEmbed(), true, 'admin'))).toBe(
      true,
    );
    expect(hasHtmlEmbedNode(applyGate(docWithEmbed(), true, 'owner'))).toBe(
      true,
    );
  });

  it('toggle OFF strips for everyone (admin/owner/member)', () => {
    for (const role of ['admin', 'owner', 'member'] as const) {
      expect(hasHtmlEmbedNode(applyGate(docWithEmbed(), false, role))).toBe(
        false,
      );
    }
  });
});

const SRC = readFileSync(join(__dirname, 'page.service.ts'), 'utf-8');

describe('page create/duplicate gate identity is pinned (source contract)', () => {
  it('create() gates on toggle AND the caller role param before deriving content/ydoc', () => {
    // create() receives the caller's workspace role as `callerRole` and gates on
    // the combined toggle-AND-admin predicate; the embed must be stripped BEFORE
    // insertPage.
    expect(SRC).toMatch(
      /!htmlEmbedAllowed\(\s*htmlEmbedEnabled\s*,\s*callerRole\s*\)\s*&&\s*hasHtmlEmbedNode\(\s*prosemirrorJson\s*\)/,
    );
    expect(SRC).toContain('prosemirrorJson = stripHtmlEmbedNodes(prosemirrorJson)');
  });

  it('duplicatePage() gates on toggle AND the duplicating user role (authUser.role)', () => {
    expect(SRC).toMatch(
      /!htmlEmbedAllowed\(\s*htmlEmbedEnabled\s*,\s*authUser\.role\s*\)\s*&&\s*hasHtmlEmbedNode\(\s*prosemirrorJson\s*\)/,
    );
  });

  it('both paths resolve the toggle from the workspace settings', () => {
    expect(SRC).toContain('isHtmlEmbedFeatureEnabled(');
    expect(SRC).toContain('this.workspaceRepo.findById(');
  });
});
