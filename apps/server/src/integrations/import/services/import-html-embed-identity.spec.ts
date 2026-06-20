import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  canAuthorHtmlEmbed,
  hasHtmlEmbedNode,
  stripHtmlEmbedNodes,
} from '../../../common/helpers/prosemirror/html-embed.util';

// FAIL-CLOSED IDENTITY for the import write paths.
//
// import.service / file-import-task.service cannot be unit-LOADED under the
// server's jest config (a transitive ESM dep, @sindresorhus/slugify, is not in
// transformIgnorePatterns). So we cover the two load-bearing properties at the
// strongest feasible layer:
//
//  (1) BEHAVIOR — using the REAL html-embed helpers, replay the exact gate
//      predicate each entrypoint runs against the role resolved from
//      userRepo.findById(...): a MISSING user (findById -> undefined) must fail
//      closed (strip), and only 'admin'/'owner' keep the embed.
//
//  (2) IDENTITY — source-pin which identity governs the gate so a refactor that
//      swaps the lookup to the wrong user (e.g. the queue worker's caller) is
//      caught: zip import resolves the role from `fileTask.creatorId`; single
//      import from the request `userId`. NOT some ambient caller.
//
// If a guard is deleted/misplaced or the identity field changes, these break.

const docWithEmbed = () => ({
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'imported body' }] },
    { type: 'htmlEmbed', attrs: { source: '<script>x</script>' } },
  ],
});

// The real predicate both import entrypoints apply (see the SECURITY blocks in
// import.service.ts and file-import-task.service.ts): resolve the importer via
// userRepo.findById, then `!canAuthorHtmlEmbed(role) && hasHtmlEmbedNode(json)`.
function applyImportGate(json: any, importingUser: { role?: string } | undefined) {
  if (!canAuthorHtmlEmbed(importingUser?.role) && hasHtmlEmbedNode(json)) {
    return stripHtmlEmbedNodes(json);
  }
  return json;
}

describe('import gate fail-closed by resolved-user role (real helpers)', () => {
  it('missing user (userRepo.findById -> undefined) strips the embed', () => {
    // findById returns undefined when the user/workspace pair does not resolve;
    // undefined?.role is undefined -> canAuthorHtmlEmbed(undefined) === false.
    const importingUser = undefined;
    const result = applyImportGate(docWithEmbed(), importingUser);
    expect(hasHtmlEmbedNode(result)).toBe(false);
  });

  it("resolved role 'member' strips", () => {
    expect(
      hasHtmlEmbedNode(applyImportGate(docWithEmbed(), { role: 'member' })),
    ).toBe(false);
  });

  it("resolved role 'admin' keeps the embed", () => {
    expect(
      hasHtmlEmbedNode(applyImportGate(docWithEmbed(), { role: 'admin' })),
    ).toBe(true);
  });

  it("resolved role 'owner' keeps the embed", () => {
    expect(
      hasHtmlEmbedNode(applyImportGate(docWithEmbed(), { role: 'owner' })),
    ).toBe(true);
  });
});

// Source-pin the identity each entrypoint feeds to userRepo.findById. These are
// the lines that decide WHOSE role governs the gate; pinning them means a
// refactor that points the lookup at the wrong user trips the test.
const SRC_DIR = join(__dirname);

describe('import gate identity is pinned to the importer (source contract)', () => {
  it('single import resolves the role from the request userId', () => {
    const src = readFileSync(join(SRC_DIR, 'import.service.ts'), 'utf-8');
    // The role lookup must key on the request `userId`, then gate on the role.
    expect(src).toMatch(
      /this\.userRepo\.findById\(\s*userId\s*,\s*workspaceId\s*\)/,
    );
    expect(src).toMatch(/canAuthorHtmlEmbed\(\s*importingUser\?\.role\s*\)/);
    // And the gate uses the real strip helper.
    expect(src).toContain('stripHtmlEmbedNodes(prosemirrorJson)');
  });

  it('zip import resolves the role from fileTask.creatorId (NOT the queue caller)', () => {
    const src = readFileSync(
      join(SRC_DIR, 'file-import-task.service.ts'),
      'utf-8',
    );
    expect(src).toMatch(
      /this\.userRepo\.findById\(\s*fileTask\.creatorId\s*,\s*fileTask\.workspaceId\s*,?\s*\)/,
    );
    expect(src).toMatch(
      /importerCanAuthorHtmlEmbed\s*=\s*canAuthorHtmlEmbed\(\s*importingUser\?\.role\s*\)/,
    );
    expect(src).toContain('stripHtmlEmbedNodes(prosemirrorJson)');
  });
});
