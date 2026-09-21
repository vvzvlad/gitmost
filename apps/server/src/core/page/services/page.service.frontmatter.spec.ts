// #555 (review of #514): the REST full-body content-write path
// (`parseProsemirrorContent`, used by createPage / updatePageContent) must be
// SYMMETRIC with the MCP agent-write path — it must NOT strip a leading
// `---…---` as YAML front-matter. A page that opens with a horizontalRule and
// contains a later `---` serializes to a `---…---`-shaped body; stripping it as
// front-matter silently deletes the page's leading content (the same class of
// data loss the agent-write path already guards against, see
// prosemirror-markdown/test/foreign-markdown.test.ts). This mirrors that
// agent-write assertion, but through the server's REST parse entry point.
//
// The genuine FILE-import boundary (import.service.ts / file-import-task.service.ts)
// keeps `normalizeForeignMarkdown` and still strips real Obsidian/Hugo YAML —
// those paths do NOT go through `parseProsemirrorContent`, so they are unaffected.

import { PageService } from './page.service';

describe('PageService REST full-body write — front-matter is NOT stripped (#555)', () => {
  function makeService(): PageService {
    // parseProsemirrorContent is a pure parse (markdownToProseMirror + schema
    // validation); it touches none of the injected collaborators, so bare stubs
    // suffice — matching page.service.spec.ts's direct-instantiation pattern.
    return new PageService(
      {} as any, // pageRepo
      {} as any, // pagePermissionRepo
      {} as any, // attachmentRepo
      {} as any, // db
      {} as any, // storageService
      {} as any, // attachmentQueue
      {} as any, // aiQueue
      {} as any, // generalQueue
      {} as any, // eventEmitter
      {} as any, // collaborationGateway
      {} as any, // watcherService
      {} as any, // transclusionService
    );
  }

  // Same fixture as the agent-write reference test: [hr, para, para, hr, para]
  // serialized. The leading `---` must survive as a horizontalRule, not be eaten
  // as front-matter.
  const rulePage = '---\n\nIntro\n\nMore\n\n---\n\nRest';

  it('preserves a leading ---…--- body on a full-body markdown write (no content loss)', async () => {
    const service = makeService();
    const json = await (service as any).parseProsemirrorContent(
      rulePage,
      'markdown',
    );
    const serialized = JSON.stringify(json);
    // Every paragraph's text survives — nothing before the second `---` is lost.
    for (const t of ['Intro', 'More', 'Rest']) {
      expect(serialized).toContain(t);
    }
    // Both horizontal rules survive (front-matter strip would have removed the
    // leading one along with the content above the closing `---`).
    expect(
      (json.content ?? []).filter((n: any) => n.type === 'horizontalRule'),
    ).toHaveLength(2);
  });

  it('keeps a YAML-header-shaped first line as content, not stripped metadata', async () => {
    const service = makeService();
    // A full-body write whose body happens to open like a YAML header. On the
    // REST write path this is CONTENT (symmetric with agent-write) and must not
    // be silently dropped.
    const md = '---\ntitle: Kept In Body\n---\n\nParagraph body.';
    const json = await (service as any).parseProsemirrorContent(md, 'markdown');
    const serialized = JSON.stringify(json);
    expect(serialized).toContain('title: Kept In Body');
    expect(serialized).toContain('Paragraph body.');
  });
});
