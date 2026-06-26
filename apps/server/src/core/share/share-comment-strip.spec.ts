import { ShareService } from './share.service';

// Exercises the REAL ShareService comment-mark stripping for shared content via
// the smallest reachable seam: updatePublicAttachments -> prepareContentForShare
// -> removeMarkTypeFromDoc(doc, 'comment'). This is a documented threat-model
// item: `comment` marks are internal-team metadata (existence, location, count,
// resolved state, and the comment ids themselves) and MUST NOT leak to anonymous
// public-share viewers.
//
// prepareContentForShare is private and the page-load path (getSharedPage) needs
// a full DB-backed resolveReadableSharePage; updatePublicAttachments is the
// smallest public seam that runs the exact same sanitization on a doc we control.
// Only the workspace toggle (workspaceRepo.findById) and token service are
// touched, both mocked — no DB setup required.

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
  // htmlEmbed toggle ON so the embed strip is a no-op and we isolate the
  // comment-mark strip behaviour.
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

// A paragraph whose text carries a `comment` mark with a comment id.
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

function countCommentMarks(doc: any): number {
  let count = 0;
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.marks)) {
      for (const mark of node.marks) {
        if (mark?.type === 'comment') count++;
      }
    }
    if (Array.isArray(node.content)) node.content.forEach(walk);
  };
  walk(doc);
  return count;
}

describe('ShareService comment-mark stripping for public shares (real code)', () => {
  it('strips a top-level comment mark and preserves the visible text', async () => {
    const content = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [commentedText('secret-reviewed body', 'cmt-top-1')],
        },
      ],
    };

    const out = await sanitize(content);

    expect(countCommentMarks(out)).toBe(0);
    // The text itself survives; only the internal mark is removed.
    expect(JSON.stringify(out)).toContain('secret-reviewed body');
    // The comment id must not appear anywhere in the serialized output.
    expect(JSON.stringify(out)).not.toContain('cmt-top-1');
  });

  it('strips comment marks nested inside columns and callouts', async () => {
    const content = {
      type: 'doc',
      content: [
        {
          type: 'columns',
          content: [
            {
              type: 'column',
              content: [
                {
                  type: 'paragraph',
                  content: [commentedText('col body', 'cmt-col-1')],
                },
              ],
            },
            {
              type: 'column',
              content: [
                {
                  type: 'callout',
                  content: [
                    {
                      type: 'paragraph',
                      content: [commentedText('callout body', 'cmt-callout-1')],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const out = await sanitize(content);

    expect(countCommentMarks(out)).toBe(0);
    const serialized = JSON.stringify(out);
    // Visible content of both nested branches survives.
    expect(serialized).toContain('col body');
    expect(serialized).toContain('callout body');
    // No nested comment id leaks.
    expect(serialized).not.toContain('cmt-col-1');
    expect(serialized).not.toContain('cmt-callout-1');
  });

  it('strips every comment mark when multiple coexist (count goes to zero)', async () => {
    const content = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            commentedText('a', 'cmt-a'),
            { type: 'text', text: ' plain ' },
            commentedText('b', 'cmt-b'),
          ],
        },
        {
          type: 'paragraph',
          content: [commentedText('c', 'cmt-c')],
        },
      ],
    };

    // Sanity: the input genuinely has 3 comment marks before sanitization.
    expect(countCommentMarks(content)).toBe(3);

    const out = await sanitize(content);

    expect(countCommentMarks(out)).toBe(0);
    const serialized = JSON.stringify(out);
    for (const id of ['cmt-a', 'cmt-b', 'cmt-c']) {
      expect(serialized).not.toContain(id);
    }
  });
});
