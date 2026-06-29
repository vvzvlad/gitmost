import { ShareService } from './share.service';

// Sibling of share-comment-strip.spec.ts. The public-share sanitizer strips ONLY
// `comment` marks (internal-team metadata) via removeMarkTypeFromDoc(doc,
// 'comment'). The `spoiler` mark is legitimate authored content (hidden text the
// reader clicks to reveal) and MUST survive the share-strip — otherwise public
// readers would see the secret in plain text or lose it entirely.
//
// We drive the SAME real seam the comment-strip test uses:
// updatePublicAttachments -> prepareContentForShare -> removeMarkTypeFromDoc.

const WS = 'ws-1';
const PAGE = 'page-1';

function buildService() {
  const shareRepo = { findById: jest.fn() };
  const pageRepo = { findById: jest.fn() };
  const pagePermissionRepo = {
    hasRestrictedAncestor: jest.fn(async () => false),
  };
  const tokenService = {
    generateAttachmentToken: jest.fn(async () => 'tok'),
  };
  const workspaceRepo = {
    findById: jest.fn(async () => ({ id: WS, settings: { htmlEmbed: true } })),
  };

  return new ShareService(
    shareRepo as any,
    pageRepo as any,
    pagePermissionRepo as any,
    {} as any, // db (unused on this path)
    tokenService as any,
    {} as any, // transclusionService (unused)
    workspaceRepo as any,
  );
}

// Text carrying a `spoiler` mark (no attributes; revealed state is UI-only).
function spoilerText(text: string) {
  return {
    type: 'text',
    text,
    marks: [{ type: 'spoiler' }],
  };
}

// Text carrying a `comment` mark with an id (the thing that DOES get stripped).
function commentedText(text: string, commentId: string) {
  return {
    type: 'text',
    text,
    marks: [{ type: 'comment', attrs: { commentId, resolved: false } }],
  };
}

async function sanitize(content: any) {
  const service = buildService();
  return service.updatePublicAttachments({
    id: PAGE,
    workspaceId: WS,
    content,
  } as any);
}

function countMarks(doc: any, type: string): number {
  let count = 0;
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.marks)) {
      for (const mark of node.marks) {
        if (mark?.type === type) count++;
      }
    }
    if (Array.isArray(node.content)) node.content.forEach(walk);
  };
  walk(doc);
  return count;
}

describe('ShareService keeps spoiler marks on public shares (real code)', () => {
  it('does NOT strip a spoiler mark', async () => {
    const content = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'visible ' }, spoilerText('hidden')],
        },
      ],
    };

    expect(countMarks(content, 'spoiler')).toBe(1);

    const out = await sanitize(content);

    // The spoiler mark survives the share-strip.
    expect(countMarks(out, 'spoiler')).toBe(1);
    expect(JSON.stringify(out)).toContain('hidden');
  });

  it('strips comment marks but keeps spoiler marks in the same doc', async () => {
    const content = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            commentedText('reviewed', 'cmt-1'),
            { type: 'text', text: ' and ' },
            spoilerText('secret'),
          ],
        },
      ],
    };

    expect(countMarks(content, 'comment')).toBe(1);
    expect(countMarks(content, 'spoiler')).toBe(1);

    const out = await sanitize(content);

    // comment is removed, spoiler is preserved.
    expect(countMarks(out, 'comment')).toBe(0);
    expect(countMarks(out, 'spoiler')).toBe(1);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('cmt-1');
    expect(serialized).toContain('secret');
  });
});
