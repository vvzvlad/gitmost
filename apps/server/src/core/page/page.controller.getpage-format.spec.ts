import { NotFoundException } from '@nestjs/common';
import { PageController } from './page.controller';
import { jsonToText, jsonToMarkdown } from '../../collaboration/collaboration.util';

// #502 READ: getPage `format:"text"` routes through the deterministic jsonToText
// path (placeholders for non-text nodes, block-per-line), while `format:"json"`
// (or none) returns the raw content and `format:"markdown"` still converts. This
// pins the CONTROLLER wiring with lightweight mocks (no DB needed — the jsonToText
// output contract itself is pinned in json-to-text-deterministic.spec.ts).

const CONTENT = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Config' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'key=', marks: [{ type: 'bold' }] },
        { type: 'text', text: 'value' },
      ],
    },
    { type: 'image', attrs: { src: 's' } },
  ],
};

function makeController(page: any): PageController {
  const pageRepo = { findById: jest.fn().mockResolvedValue(page) } as any;
  const pageAccessService = {
    validateCanViewWithPermissions: jest
      .fn()
      .mockResolvedValue({ canEdit: true, hasRestriction: false }),
  } as any;
  // Only pageRepo + pageAccessService are exercised by getPage; the rest are
  // never touched on this path, so undefined placeholders are fine.
  return new PageController(
    undefined as any, // pageService
    pageRepo,
    undefined as any, // pageHistoryService
    undefined as any, // spaceAbility
    pageAccessService,
    undefined as any, // backlinkService
    undefined as any, // labelService
    undefined as any, // auditService
  );
}

const user = { id: 'u1' } as any;

describe('PageController.getPage — format:"text" (#502)', () => {
  it('returns deterministic flat text with placeholders for non-text nodes', async () => {
    const controller = makeController({ id: 'p1', content: CONTENT });
    const res: any = await controller.getPage({ pageId: 'p1', format: 'text' } as any, user);
    expect(res.content).toBe(jsonToText(CONTENT, { deterministic: true }));
    expect(res.content).toBe('Config\nkey=value\n[image]');
    expect(res.permissions).toEqual({ canEdit: true, hasRestriction: false });
  });

  it('markdown format still converts to markdown (unchanged)', async () => {
    const controller = makeController({ id: 'p1', content: CONTENT });
    const res: any = await controller.getPage({ pageId: 'p1', format: 'markdown' } as any, user);
    expect(res.content).toBe(jsonToMarkdown(CONTENT));
  });

  it('json / no format returns the raw ProseMirror content object', async () => {
    const controller = makeController({ id: 'p1', content: CONTENT });
    const res: any = await controller.getPage({ pageId: 'p1' } as any, user);
    expect(res.content).toEqual(CONTENT); // untouched object, not a string
  });

  it('missing page -> NotFoundException', async () => {
    const controller = makeController(null);
    await expect(
      controller.getPage({ pageId: 'nope', format: 'text' } as any, user),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
