import { ShareSeoController } from './share-seo.controller';

// Pins ShareSeoController.extractPageSlugId — the slug→pageId resolver used to
// look up a shared page from the public URL. A full UUID must pass through
// untouched; a "title-slug-<id>" must yield the trailing token; a single token
// is returned as-is; falsy input yields undefined. The method does not touch
// `this`, so the controller can be constructed with null collaborators.

function buildController(): ShareSeoController {
  return new ShareSeoController(null as any, null as any, null as any);
}

describe('ShareSeoController.extractPageSlugId', () => {
  const controller = buildController();

  it('returns a full UUID unchanged', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(controller.extractPageSlugId(uuid)).toBe(uuid);
  });

  it('returns the trailing token of a title-slug-id form', () => {
    expect(controller.extractPageSlugId('my-page-title-abc123')).toBe('abc123');
  });

  it('returns a single token (no hyphen) as-is', () => {
    expect(controller.extractPageSlugId('abc123')).toBe('abc123');
  });

  it('returns the last segment for a two-token slug', () => {
    expect(controller.extractPageSlugId('hello-world')).toBe('world');
  });

  it('returns undefined for an empty string (falsy guard)', () => {
    expect(controller.extractPageSlugId('')).toBeUndefined();
  });

  it('returns undefined for null/undefined input', () => {
    expect(controller.extractPageSlugId(undefined as any)).toBeUndefined();
    expect(controller.extractPageSlugId(null as any)).toBeUndefined();
  });
});
