// Importing ImportService transitively loads import-formatter.ts, which imports
// the ESM-only @sindresorhus/slugify (not in jest's transform allowlist). It is
// irrelevant to this path, so mock it to keep the module graph loadable (mirrors
// the sibling import.service specs).
jest.mock('@sindresorhus/slugify', () => ({
  __esModule: true,
  default: (input: string) => String(input),
}));

import { ImportService } from './import.service';

// #502 BLOCKER 1: the server markdown import path (`/pages/import`) now accepts an
// optional `disableMarkdownExtensions` flag threaded into `processMarkdown`.
//   - MCP agent `createPage` sends it TRUE  -> extensions OFF (a `$…$` config span
//     stays literal, a schemeless `www.host` is not autolinked).
//   - a HUMAN file upload omits it (default FALSE) -> extensions ON, so a real
//     `$x^2$` still becomes a formula (human imports unaffected).
// `processMarkdown` only uses the imported converter (no injected deps on this
// path), so the service is constructed with null deps for this focused unit test.

function makeService(): ImportService {
  return new ImportService(null as any, null as any, null as any, null as any);
}

function findAll(node: any, type: string, acc: any[] = []): any[] {
  if (!node || typeof node !== 'object') return acc;
  if (node.type === type) acc.push(node);
  if (Array.isArray(node.content)) for (const c of node.content) findAll(c, type, acc);
  return acc;
}
function hasLink(node: any): boolean {
  return findAll(node, 'text').some((t: any) =>
    t.marks?.some((m: any) => m.type === 'link'),
  );
}

describe('ImportService.processMarkdown — #502 disableMarkdownExtensions', () => {
  it('disableMarkdownExtensions=true (MCP createPage): `$…$` stays literal, no math', async () => {
    const svc = makeService();
    const doc = await svc.processMarkdown('export A=$FOO and B=$BAR done', true);
    expect(findAll(doc, 'mathInline')).toHaveLength(0);
  });

  it('disableMarkdownExtensions=true: a schemeless www is NOT autolinked', async () => {
    const svc = makeService();
    const doc = await svc.processMarkdown('see www.example.com here', true);
    expect(hasLink(doc)).toBe(false);
  });

  it('disableMarkdownExtensions=true: an explicit https:// STILL links', async () => {
    const svc = makeService();
    const doc = await svc.processMarkdown('see https://example.com here', true);
    expect(hasLink(doc)).toBe(true);
  });

  it('DEFAULT (human upload): a real `$x^2$` DOES become a math node', async () => {
    const svc = makeService();
    const doc = await svc.processMarkdown('$x^2$');
    expect(findAll(doc, 'mathInline')).toHaveLength(1);
  });

  it('DEFAULT (human upload): a schemeless www IS autolinked', async () => {
    const svc = makeService();
    const doc = await svc.processMarkdown('see www.example.com here');
    expect(hasLink(doc)).toBe(true);
  });
});
