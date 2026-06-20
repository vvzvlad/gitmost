import * as Y from 'yjs';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { PersistenceExtension } from './persistence.extension';
import { tiptapExtensions } from '../collaboration.util';
import {
  hasHtmlEmbedNode,
  HTML_EMBED_NODE_NAME,
} from '../../common/helpers/prosemirror/html-embed.util';

// Exercises the REAL PersistenceExtension.onStoreDocument (the primary collab
// WebSocket write path) against a REAL ydoc, with thin repo/db/queue mocks.
// This replaces the prior re-implemented `applyAdminGate` stand-in for this
// entrypoint: if the role-extraction expression (`context?.user?.role`), the
// strip call, or the ydoc-rebuild branch is deleted/changed, these tests fail.

const RICH_DOC = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'intro paragraph' }],
    },
    {
      type: 'columns',
      content: [
        {
          type: 'column',
          attrs: { position: 'left' },
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'left col, mentioning ' },
                {
                  type: 'mention',
                  attrs: {
                    id: 'mention-1',
                    label: 'Alice',
                    entityType: 'user',
                    entityId: 'user-123',
                    creatorId: 'creator-1',
                  },
                },
              ],
            },
            // Nested embed inside a column — must be stripped recursively.
            {
              type: HTML_EMBED_NODE_NAME,
              attrs: { source: '<script>nested()</script>' },
            },
          ],
        },
        {
          type: 'column',
          attrs: { position: 'right' },
          content: [
            {
              type: 'table',
              content: [
                {
                  type: 'tableRow',
                  content: [
                    {
                      type: 'tableHeader',
                      attrs: { colspan: 1, rowspan: 1 },
                      content: [
                        { type: 'paragraph', content: [{ type: 'text', text: 'H' }] },
                      ],
                    },
                  ],
                },
                {
                  type: 'tableRow',
                  content: [
                    {
                      type: 'tableCell',
                      attrs: { colspan: 1, rowspan: 1 },
                      content: [
                        { type: 'paragraph', content: [{ type: 'text', text: 'cell' }] },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    // Top-level embed — must be stripped.
    {
      type: HTML_EMBED_NODE_NAME,
      attrs: { source: '<script>top()</script>' },
    },
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'outro paragraph' }],
    },
  ],
};

function buildYdoc(json: any): Y.Doc {
  return TiptapTransformer.toYdoc(json, 'default', tiptapExtensions);
}

// Count nodes by type across the whole tree (excludes htmlEmbed by listing it
// separately) so we can assert every OTHER node type survived the strip.
function nodeTypeCounts(json: any): Record<string, number> {
  const counts: Record<string, number> = {};
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return;
    if (n.type) counts[n.type] = (counts[n.type] ?? 0) + 1;
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  walk(json);
  return counts;
}

/**
 * Construct a real PersistenceExtension with the minimum mocks needed for
 * onStoreDocument to reach the strip + persist branch, and capture the content
 * that would be written to the page row.
 */
function buildExtension(featureEnabled = true) {
  const captured: { content?: any } = {};

  const existingPage = {
    id: 'page-1',
    slugId: 'slug-1',
    spaceId: 'space-1',
    workspaceId: 'ws-1',
    creatorId: 'creator-1',
    contributorIds: [],
    content: { type: 'doc', content: [] }, // differs from new content -> persist runs
    createdAt: new Date(),
    lastUpdatedSource: 'user',
  };

  const pageRepo = {
    findById: jest.fn(async () => ({ ...existingPage })),
    updatePage: jest.fn(async (values: any) => {
      captured.content = values.content;
    }),
  };
  const pageHistoryRepo = {
    findPageLastHistory: jest.fn(async () => null),
    saveHistory: jest.fn(async () => undefined),
  };
  // db.transaction().execute(cb) just runs the callback (no real DB).
  const db = {
    transaction: () => ({
      execute: (cb: any) => cb({} as any),
    }),
  };
  const noopQueue = { add: jest.fn(async () => undefined) } as any;
  const collabHistory = { addContributors: jest.fn(async () => undefined) } as any;
  const transclusionService = {
    syncPageTransclusions: jest.fn(async () => undefined),
    syncPageReferences: jest.fn(async () => undefined),
  } as any;

  // Workspace settings read used by the toggle-AND-admin gate.
  const workspaceRepo = {
    findById: jest.fn(async () => ({
      id: 'ws-1',
      settings: { htmlEmbed: featureEnabled },
    })),
  };

  const ext = new PersistenceExtension(
    pageRepo as any,
    pageHistoryRepo as any,
    db as any,
    noopQueue,
    noopQueue,
    noopQueue,
    collabHistory,
    transclusionService,
    workspaceRepo as any,
  );

  return { ext, captured, pageRepo };
}

async function runStore(
  role: string | null | undefined,
  doc: Y.Doc,
  featureEnabled = true,
) {
  const { ext, captured } = buildExtension(featureEnabled);
  // hocuspocus augments the Y.Doc with broadcastStateless; a bare Y.Doc has
  // none, so stub it (the post-persist broadcast is not under test here).
  (doc as any).broadcastStateless = () => undefined;
  await ext.onStoreDocument({
    documentName: 'page-1',
    document: doc,
    context: { user: { id: 'u1', role } },
  } as any);
  return captured;
}

describe('PersistenceExtension.onStoreDocument htmlEmbed admin gate (real code)', () => {
  it('non-admin store: strips EVERY htmlEmbed but preserves every other node', async () => {
    const doc = buildYdoc(RICH_DOC);
    const before = TiptapTransformer.fromYdoc(doc, 'default');
    expect(hasHtmlEmbedNode(before)).toBe(true);
    const beforeCounts = nodeTypeCounts(before);

    const captured = await runStore('member', doc);

    expect(captured.content).toBeDefined();
    // htmlEmbed gone from the persisted content.
    expect(hasHtmlEmbedNode(captured.content)).toBe(false);

    // Every non-embed node type is preserved with the SAME count (guards against
    // data loss if a node were missing from tiptapExtensions and dropped on the
    // toYdoc rebuild).
    const afterCounts = nodeTypeCounts(captured.content);
    for (const [type, count] of Object.entries(beforeCounts)) {
      if (type === HTML_EMBED_NODE_NAME) continue;
      expect(afterCounts[type]).toBe(count);
    }
    // The two embeds are gone.
    expect(beforeCounts[HTML_EMBED_NODE_NAME]).toBe(2);
    expect(afterCounts[HTML_EMBED_NODE_NAME]).toBeUndefined();

    // The shared ydoc fragment was also rewritten clean (re-decode it).
    const reDecoded = TiptapTransformer.fromYdoc(doc, 'default');
    expect(hasHtmlEmbedNode(reDecoded)).toBe(false);
  });

  it('toggle ON + admin store: htmlEmbed preserved in persisted content', async () => {
    const captured = await runStore('admin', buildYdoc(RICH_DOC), true);
    expect(captured.content).toBeDefined();
    expect(hasHtmlEmbedNode(captured.content)).toBe(true);
    expect(nodeTypeCounts(captured.content)[HTML_EMBED_NODE_NAME]).toBe(2);
  });

  it('toggle ON + owner store: htmlEmbed preserved', async () => {
    const captured = await runStore('owner', buildYdoc(RICH_DOC), true);
    expect(hasHtmlEmbedNode(captured.content)).toBe(true);
  });

  it('toggle OFF + admin store: stripped (feature disabled for everyone)', async () => {
    const captured = await runStore('admin', buildYdoc(RICH_DOC), false);
    expect(hasHtmlEmbedNode(captured.content)).toBe(false);
  });

  it('toggle OFF + owner store: stripped', async () => {
    const captured = await runStore('owner', buildYdoc(RICH_DOC), false);
    expect(hasHtmlEmbedNode(captured.content)).toBe(false);
  });

  it('toggle OFF + member store: stripped', async () => {
    const captured = await runStore('member', buildYdoc(RICH_DOC), false);
    expect(hasHtmlEmbedNode(captured.content)).toBe(false);
  });

  it('unknown/empty role: fails closed (stripped)', async () => {
    expect(
      hasHtmlEmbedNode((await runStore(undefined, buildYdoc(RICH_DOC))).content),
    ).toBe(false);
    expect(
      hasHtmlEmbedNode((await runStore(null, buildYdoc(RICH_DOC))).content),
    ).toBe(false);
    expect(
      hasHtmlEmbedNode((await runStore('viewer', buildYdoc(RICH_DOC))).content),
    ).toBe(false);
  });

  it('empty-fragment ydoc (no content) does not throw and persists no embed', async () => {
    const emptyDoc = buildYdoc({
      type: 'doc',
      content: [{ type: 'paragraph' }],
    });
    // Non-admin path with an empty/embed-free fragment must be a no-op strip,
    // not throw.
    await expect(runStore('member', emptyDoc)).resolves.toBeDefined();
  });
});
