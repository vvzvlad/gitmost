import * as Y from 'yjs';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { PersistenceExtension } from './persistence.extension';
import { tiptapExtensions } from '../collaboration.util';
import {
  collectHtmlEmbedSources,
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
function buildExtension(featureEnabled = true, priorContent?: any) {
  const captured: { content?: any } = {};

  const existingPage = {
    id: 'page-1',
    slugId: 'slug-1',
    spaceId: 'space-1',
    workspaceId: 'ws-1',
    creatorId: 'creator-1',
    contributorIds: [],
    // The currently-persisted content. Defaults to an empty doc (differs from
    // new content -> persist runs); a test may pass a prior admin embed here to
    // exercise the preserve-admin-embed branch.
    content: priorContent ?? { type: 'doc', content: [] },
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
  priorContent?: any,
) {
  const { ext, captured } = buildExtension(featureEnabled, priorContent);
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

  it('toggle ON + non-admin store: PRESERVES an admin embed already in the persisted content through an unrelated edit', async () => {
    // Prior persisted content already holds an admin-authored embed.
    const ADMIN_SOURCE = '<script>adminAuthored()</script>';
    const prior = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'intro' }] },
        { type: HTML_EMBED_NODE_NAME, attrs: { source: ADMIN_SOURCE } },
      ],
    };
    // A non-admin makes an UNRELATED edit (tweaks the paragraph) but the embed
    // is still present in the merged doc.
    const edited = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'intro edited' }] },
        { type: HTML_EMBED_NODE_NAME, attrs: { source: ADMIN_SOURCE } },
      ],
    };

    const captured = await runStore('member', buildYdoc(edited), true, prior);
    expect(captured.content).toBeDefined();
    // The admin's pre-existing embed survives the non-admin store.
    expect(collectHtmlEmbedSources(captured.content)).toEqual(
      new Set([ADMIN_SOURCE]),
    );
  });

  it('toggle ON + non-admin store: strips a NEWLY-added embed while keeping the prior admin one', async () => {
    const ADMIN_SOURCE = '<script>adminAuthored()</script>';
    const prior = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'intro' }] },
        { type: HTML_EMBED_NODE_NAME, attrs: { source: ADMIN_SOURCE } },
      ],
    };
    // Non-admin keeps the admin embed, makes an unrelated paragraph edit (so the
    // store is not a no-op and is persisted), and ALSO adds a brand-new embed.
    const edited = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'intro edited' }] },
        { type: HTML_EMBED_NODE_NAME, attrs: { source: ADMIN_SOURCE } },
        { type: HTML_EMBED_NODE_NAME, attrs: { source: '<script>evil()</script>' } },
      ],
    };

    const captured = await runStore('member', buildYdoc(edited), true, prior);
    expect(captured.content).toBeDefined();
    // Only the admin-vetted source remains; the newly-introduced one is stripped.
    expect(collectHtmlEmbedSources(captured.content)).toEqual(
      new Set([ADMIN_SOURCE]),
    );
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

// Exercises the REAL early onChange guard (Gitea #26): guardHtmlEmbed converges
// the shared ydoc sub-second, before the 10s store debounce. We call it directly
// (it is the debounced timer body) and assert the ydoc fragment no longer yields
// an htmlEmbed for the non-admin's transient embed, while admin-vetted embeds
// already in the persisted content survive.
describe('PersistenceExtension.guardHtmlEmbed early onChange guard (real code)', () => {
  async function runGuard(
    role: string | null | undefined,
    doc: Y.Doc,
    featureEnabled = true,
    priorContent?: any,
  ) {
    const { ext } = buildExtension(featureEnabled, priorContent);
    await (ext as any).guardHtmlEmbed(
      'page-1',
      doc,
      { user: { id: 'u1', role, workspaceId: 'ws-1' } },
    );
  }

  it('toggle ON + non-admin: strips a newly-added embed from the shared ydoc', async () => {
    // Prior persisted content has NO embed; the live doc has one a non-admin
    // just added.
    const doc = buildYdoc({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'hi' }] },
        { type: HTML_EMBED_NODE_NAME, attrs: { source: '<script>evil()</script>' } },
      ],
    });
    expect(hasHtmlEmbedNode(TiptapTransformer.fromYdoc(doc, 'default'))).toBe(
      true,
    );

    await runGuard('member', doc, true, { type: 'doc', content: [] });

    // The shared ydoc fragment no longer yields any htmlEmbed.
    expect(hasHtmlEmbedNode(TiptapTransformer.fromYdoc(doc, 'default'))).toBe(
      false,
    );
  });

  it('toggle ON + non-admin: preserves a prior admin embed, strips the new one', async () => {
    const ADMIN_SOURCE = '<script>adminAuthored()</script>';
    const prior = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'intro' }] },
        { type: HTML_EMBED_NODE_NAME, attrs: { source: ADMIN_SOURCE } },
      ],
    };
    // Live doc keeps the admin embed AND adds a brand-new one.
    const doc = buildYdoc({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'intro' }] },
        { type: HTML_EMBED_NODE_NAME, attrs: { source: ADMIN_SOURCE } },
        { type: HTML_EMBED_NODE_NAME, attrs: { source: '<script>evil()</script>' } },
      ],
    });

    await runGuard('member', doc, true, prior);

    // Only the admin-vetted source survives in the shared ydoc.
    expect(
      collectHtmlEmbedSources(TiptapTransformer.fromYdoc(doc, 'default')),
    ).toEqual(new Set([ADMIN_SOURCE]));
  });

  it('toggle OFF + non-admin: strips ALL embeds (allow-list is null)', async () => {
    // Even an embed that matches the prior content is stripped when the toggle
    // is OFF, because the OFF path passes allowed=null (strip everything) and
    // never reads the prior content for an allow-list.
    const SOURCE = '<script>any()</script>';
    const doc = buildYdoc({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'hi' }] },
        { type: HTML_EMBED_NODE_NAME, attrs: { source: SOURCE } },
      ],
    });
    await runGuard('member', doc, false, {
      type: 'doc',
      content: [{ type: HTML_EMBED_NODE_NAME, attrs: { source: SOURCE } }],
    });
    expect(hasHtmlEmbedNode(TiptapTransformer.fromYdoc(doc, 'default'))).toBe(
      false,
    );
  });

  it('admin role: guard is a defensive no-op (embed preserved)', async () => {
    const doc = buildYdoc({
      type: 'doc',
      content: [
        { type: HTML_EMBED_NODE_NAME, attrs: { source: '<script>ok()</script>' } },
      ],
    });
    await runGuard('admin', doc, true, { type: 'doc', content: [] });
    expect(hasHtmlEmbedNode(TiptapTransformer.fromYdoc(doc, 'default'))).toBe(
      true,
    );
  });

  it('no embed present: guard is a cheap no-op (loop-safe re-fire)', async () => {
    const doc = buildYdoc({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'plain' }] }],
    });
    await runGuard('member', doc, true, { type: 'doc', content: [] });
    expect(hasHtmlEmbedNode(TiptapTransformer.fromYdoc(doc, 'default'))).toBe(
      false,
    );
  });
});
