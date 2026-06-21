import {
  extractUserMentionIdsFromJson,
  getAttachmentIds,
  extractMentions,
  extractUserMentions,
  extractPageMentions,
  removeMarkTypeFromDoc,
} from './utils';
import { jsonToNode } from '../../../collaboration/collaboration.util';

// Real UUIDs (uuid.validate must accept these).
const UUID_A = '550e8400-e29b-41d4-a716-446655440000';
const UUID_B = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const UUID_C = '00000000-0000-4000-8000-000000000000';

// Helper builders that mirror the real ProseMirror JSON shapes.
const doc = (...content: any[]) => ({ type: 'doc', content });
const paragraph = (...content: any[]) => ({ type: 'paragraph', content });
const mention = (attrs: Record<string, any>) => ({ type: 'mention', attrs });

describe('extractUserMentionIdsFromJson', () => {
  it('collects entityIds for user mentions only', () => {
    const json = doc(
      paragraph(
        mention({ entityType: 'user', entityId: UUID_A }),
        mention({ entityType: 'user', entityId: UUID_B }),
      ),
    );
    expect(extractUserMentionIdsFromJson(json)).toEqual([UUID_A, UUID_B]);
  });

  it('dedups the same entityId', () => {
    const json = doc(
      paragraph(
        mention({ entityType: 'user', entityId: UUID_A }),
        mention({ entityType: 'user', entityId: UUID_A }),
      ),
    );
    // Mutation guard: a non-dedup impl would return [UUID_A, UUID_A].
    expect(extractUserMentionIdsFromJson(json)).toEqual([UUID_A]);
    expect(extractUserMentionIdsFromJson(json)).toHaveLength(1);
  });

  it('filters OUT non-user entityTypes (page mentions ignored)', () => {
    const json = doc(
      paragraph(
        mention({ entityType: 'page', entityId: UUID_A }),
        mention({ entityType: 'user', entityId: UUID_B }),
      ),
    );
    // Cross-contamination guard: page mention must not leak in.
    expect(extractUserMentionIdsFromJson(json)).toEqual([UUID_B]);
  });

  it('skips a user mention with no entityId', () => {
    const json = doc(
      paragraph(
        mention({ entityType: 'user' }),
        mention({ entityType: 'user', entityId: UUID_A }),
      ),
    );
    expect(extractUserMentionIdsFromJson(json)).toEqual([UUID_A]);
  });

  it('returns [] for null / undefined node', () => {
    expect(extractUserMentionIdsFromJson(null)).toEqual([]);
    expect(extractUserMentionIdsFromJson(undefined)).toEqual([]);
  });

  it('handles a mention node with missing attrs without throwing', () => {
    const json = doc(paragraph({ type: 'mention' }));
    expect(() => extractUserMentionIdsFromJson(json)).not.toThrow();
    expect(extractUserMentionIdsFromJson(json)).toEqual([]);
  });

  it('walks deeply nested content', () => {
    const json = doc(
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              paragraph(mention({ entityType: 'user', entityId: UUID_A })),
            ],
          },
        ],
      },
    );
    expect(extractUserMentionIdsFromJson(json)).toEqual([UUID_A]);
  });
});

describe('getAttachmentIds', () => {
  it('collects attachmentIds from image, video and attachment nodes', () => {
    const json = doc(
      { type: 'image', attrs: { src: 'a', attachmentId: UUID_A } },
      { type: 'video', attrs: { src: 'b', attachmentId: UUID_B } },
      {
        type: 'attachment',
        attrs: {
          url: 'c',
          name: 'file',
          mimeType: 'application/pdf',
          size: 1,
          attachmentId: UUID_C,
        },
      },
    );
    expect(getAttachmentIds(json).sort()).toEqual(
      [UUID_A, UUID_B, UUID_C].sort(),
    );
  });

  it('skips an invalid (non-UUID) attachmentId', () => {
    const json = doc(
      { type: 'image', attrs: { src: 'a', attachmentId: 'not-a-uuid' } },
      { type: 'image', attrs: { src: 'b', attachmentId: UUID_A } },
    );
    // Guard: a non-UUID must never leak into downstream queries.
    expect(getAttachmentIds(json)).toEqual([UUID_A]);
  });

  it('dedups the same attachmentId across nodes', () => {
    const json = doc(
      { type: 'image', attrs: { src: 'a', attachmentId: UUID_A } },
      { type: 'image', attrs: { src: 'b', attachmentId: UUID_A } },
    );
    expect(getAttachmentIds(json)).toEqual([UUID_A]);
  });

  it('ignores non-attachment node types', () => {
    const json = doc(
      paragraph({ type: 'text', text: 'hi' }),
      // A paragraph carrying an attachmentId-like attr must NOT be collected.
      { ...paragraph(), attrs: { attachmentId: UUID_A } },
    );
    expect(getAttachmentIds(json)).toEqual([]);
  });

  it('returns [] for an empty doc with no attachments', () => {
    expect(getAttachmentIds(doc(paragraph()))).toEqual([]);
  });
});

describe('extractMentions / extractUserMentions / extractPageMentions', () => {
  it('extractMentions dedups by id (NOT by entityId)', () => {
    const json = doc(
      paragraph(
        mention({
          id: 'mention-1',
          label: 'Alice',
          entityType: 'user',
          entityId: UUID_A,
          creatorId: UUID_C,
        }),
        // Same id, different label -> must be dropped as a duplicate.
        mention({
          id: 'mention-1',
          label: 'Alice again',
          entityType: 'user',
          entityId: UUID_A,
          creatorId: UUID_C,
        }),
        // Different id but SAME entityId -> must be KEPT (dedup key is id).
        mention({
          id: 'mention-2',
          label: 'Alice elsewhere',
          entityType: 'user',
          entityId: UUID_A,
          creatorId: UUID_C,
        }),
      ),
    );
    const result = extractMentions(json);
    // Dedup key footgun: if it deduped by entityId we'd only get 1.
    expect(result.map((m) => m.id)).toEqual(['mention-1', 'mention-2']);
  });

  it('extractMentions skips a mention missing id', () => {
    const json = doc(
      paragraph(
        mention({ label: 'no id', entityType: 'user', entityId: UUID_A }),
        mention({
          id: 'mention-1',
          label: 'has id',
          entityType: 'user',
          entityId: UUID_A,
        }),
      ),
    );
    const result = extractMentions(json);
    expect(result.map((m) => m.id)).toEqual(['mention-1']);
  });

  it('extractMentions preserves the full mention shape', () => {
    const json = doc(
      paragraph(
        mention({
          id: 'mention-1',
          label: 'Bob',
          entityType: 'user',
          entityId: UUID_B,
          creatorId: UUID_C,
        }),
      ),
    );
    const [m] = extractMentions(json);
    expect(m).toMatchObject({
      id: 'mention-1',
      label: 'Bob',
      entityType: 'user',
      entityId: UUID_B,
      creatorId: UUID_C,
    });
  });

  it('extractUserMentions keeps only entityType === user', () => {
    const list = [
      { id: '1', label: 'u', entityType: 'user', entityId: UUID_A, creatorId: 'c' },
      { id: '2', label: 'p', entityType: 'page', entityId: UUID_B, creatorId: 'c' },
    ] as any;
    const users = extractUserMentions(list);
    expect(users.map((m) => m.id)).toEqual(['1']);
    expect(users.every((m) => m.entityType === 'user')).toBe(true);
  });

  it('extractPageMentions dedups by entityId and filters to page', () => {
    const list = [
      { id: 'a', label: 'p', entityType: 'page', entityId: UUID_A, creatorId: 'c' },
      // Same entityId, different id -> must be dropped (dedup key is entityId).
      { id: 'b', label: 'p2', entityType: 'page', entityId: UUID_A, creatorId: 'c' },
      // A user mention that happens to share the entityId -> filtered out.
      { id: 'c', label: 'u', entityType: 'user', entityId: UUID_A, creatorId: 'c' },
      { id: 'd', label: 'p3', entityType: 'page', entityId: UUID_B, creatorId: 'c' },
    ] as any;
    const pages = extractPageMentions(list);
    // Dedup key footgun: dedup is by entityId here, not by id.
    expect(pages.map((m) => m.entityId)).toEqual([UUID_A, UUID_B]);
    expect(pages.map((m) => m.id)).toEqual(['a', 'd']);
    expect(pages.every((m) => m.entityType === 'page')).toBe(true);
  });

  it('extractUserMentions / extractPageMentions return [] for an empty list', () => {
    expect(extractUserMentions([])).toEqual([]);
    expect(extractPageMentions([])).toEqual([]);
  });
});

describe('removeMarkTypeFromDoc', () => {
  it('removes the named mark across the whole doc', () => {
    const node = jsonToNode(
      doc(
        paragraph({ type: 'text', text: 'first', marks: [{ type: 'bold' }] }),
        paragraph({ type: 'text', text: 'second', marks: [{ type: 'bold' }] }),
      ),
    );
    const result = removeMarkTypeFromDoc(node, 'bold');
    // No text node anywhere should still carry marks after removal.
    const json = result.toJSON();
    const marksLeft: any[] = [];
    result.descendants((n) => {
      if (n.marks.length > 0) marksLeft.push(n.marks);
    });
    expect(marksLeft).toEqual([]);
    expect(JSON.stringify(json)).not.toContain('"type":"bold"');
    // Text content survives, only the mark is gone.
    expect(result.textContent).toBe('firstsecond');
  });

  it('leaves other marks intact when removing one mark type', () => {
    const node = jsonToNode(
      doc(
        paragraph({
          type: 'text',
          text: 'styled',
          marks: [{ type: 'bold' }, { type: 'italic' }],
        }),
      ),
    );
    const result = removeMarkTypeFromDoc(node, 'bold');
    const serialized = JSON.stringify(result.toJSON());
    expect(serialized).not.toContain('"bold"');
    expect(serialized).toContain('"italic"');
  });

  it('returns the doc unchanged (no throw) for an unknown mark name', () => {
    const node = jsonToNode(
      doc(paragraph({ type: 'text', text: 'x', marks: [{ type: 'bold' }] })),
    );
    let result!: ReturnType<typeof removeMarkTypeFromDoc>;
    // Guard: the `!markType` branch must short-circuit, never throw.
    expect(() => {
      result = removeMarkTypeFromDoc(node, 'noSuchMarkAnywhere');
    }).not.toThrow();
    // Returns the SAME node reference (no transform applied).
    expect(result).toBe(node);
    expect(JSON.stringify(result.toJSON())).toContain('"bold"');
  });

  it('is a no-op on a doc that has no marks', () => {
    const node = jsonToNode(
      doc(paragraph({ type: 'text', text: 'plain' })),
    );
    const result = removeMarkTypeFromDoc(node, 'bold');
    expect(result.textContent).toBe('plain');
    expect(JSON.stringify(result.toJSON())).not.toContain('marks');
  });
});
