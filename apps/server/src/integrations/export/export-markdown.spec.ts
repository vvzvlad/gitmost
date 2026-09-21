// export.service.ts imports the ESM-only @sindresorhus/slugify (not in jest's
// transform allowlist). It is irrelevant to the markdown-serialization path under
// test (only used for page-mention link slugs on the DB path), so it is mocked
// out to keep the module graph loadable under ts-jest (mirrors the import specs).
jest.mock('@sindresorhus/slugify', () => ({
  __esModule: true,
  default: (input: string) => String(input),
}));

import { convertProseMirrorToMarkdown } from '@docmost/prosemirror-markdown';
import { ExportService } from './export.service';
import { ExportFormat } from './dto/export-dto';

/**
 * STEP 1 golden test for issue #345: server MARKDOWN export runs DIRECTLY through
 * the canonical converter (`convertProseMirrorToMarkdown`) — no HTML intermediate
 * and no `@docmost/editor-ext` markdown layer — so the emitted markdown is in the
 * canonical package forms and is byte-identical to the git-sync vault body.
 *
 * These are the goldens the swap has to satisfy: they assert the CANONICAL
 * surface (callout `> [!type]`, inline footnote `^[…]`, lossless image
 * `<!--img …-->`) rather than the old editor-ext forms (`:::type`, `[^id]`,
 * lossy `![alt](src)`).
 *
 * `exportPage(..., singlePage=false)` takes no DB path (no mention rewriting), so
 * the service is constructed with null collaborators and only the pure
 * PM -> Markdown path is exercised.
 */

function makeService(): ExportService {
  return new ExportService(
    null as any, // pageRepo
    null as any, // pagePermissionRepo
    null as any, // db
    null as any, // storageService
    null as any, // environmentService
    null as any, // domainService
  );
}

// A representative page exercising the node types whose canonical markdown form
// changed with the move off the editor-ext layer: callout, inline footnote, and a
// lossless image carrying width/align attrs that the old layer dropped.
const REPRESENTATIVE_DOC = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Body ' },
        { type: 'footnoteReference', attrs: { id: 'fn-1' } },
        { type: 'text', text: ' end.' },
      ],
    },
    {
      type: 'callout',
      attrs: { type: 'info', icon: null },
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Heads up' }],
        },
      ],
    },
    {
      type: 'image',
      attrs: {
        src: '/files/pic.png',
        alt: 'Pic',
        width: 320,
        align: 'left',
      },
    },
    {
      type: 'footnotesList',
      content: [
        {
          type: 'footnoteDefinition',
          attrs: { id: 'fn-1' },
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'the note' }],
            },
          ],
        },
      ],
    },
  ],
};

describe('ExportService — markdown export via the canonical converter (#345)', () => {
  it('emits canonical callout, inline footnote and lossless image forms', async () => {
    const service = makeService();
    const md = (await service.exportPage(ExportFormat.Markdown, {
      title: '',
      content: REPRESENTATIVE_DOC,
    } as any)) as string;

    // Callout: Obsidian `> [!type]`, NOT the legacy `:::type`.
    expect(md).toContain('> [!info]');
    expect(md).not.toContain(':::');

    // Inline footnote: `^[…]`, NOT the reference `[^id]` form.
    expect(md).toContain('^[the note]');
    expect(md).not.toMatch(/\[\^/);

    // Lossless image: trailing `<!--img …-->` carrying the dropped attrs.
    expect(md).toContain('![Pic](/files/pic.png)');
    expect(md).toContain('<!--img');
    expect(md).toContain('"width":"320"');
    expect(md).toContain('"align":"left"');
  });

  it('export body is byte-identical to the git-sync vault serializer (export == vault)', async () => {
    const service = makeService();
    // A title-less page: exportPage prepends NO heading, so the whole output is
    // the page BODY — exactly what git-sync serializes (git-sync stores the title
    // in frontmatter / the filename, never as an in-body H1).
    const exported = (await service.exportPage(ExportFormat.Markdown, {
      title: '',
      content: REPRESENTATIVE_DOC,
    } as any)) as string;

    // The git-sync vault writer feeds this SAME converter (git-sync
    // `stabilizePageBody` = convertProseMirrorToMarkdown(content) at the
    // fixpoint). For an already-stable doc the single pass IS the fixpoint, so
    // the two are byte-identical by construction — assert it.
    const vaultBody = convertProseMirrorToMarkdown(REPRESENTATIVE_DOC);
    expect(exported).toBe(vaultBody);
  });

  it('prepends the page title as an H1 heading (the one documented export/vault delta)', async () => {
    const service = makeService();
    const md = (await service.exportPage(ExportFormat.Markdown, {
      title: 'My Page',
      content: { type: 'doc', content: [] },
    } as any)) as string;

    // Export makes standalone files, so it prepends the title as an H1. This is
    // the ONE deliberate difference from the vault body (which carries the title
    // in frontmatter). The body below the heading still serializes canonically.
    expect(md.startsWith('# My Page')).toBe(true);
  });
});
