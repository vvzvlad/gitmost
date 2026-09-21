import { ShareController } from './share.controller';
import {
  PublicSharePayload,
  toPublicSharePayload,
} from './share-public-payload';

// The `/shares/page-info` route is the ONLY anonymous path that serializes the
// full {page, share} records. Trimming the response to an explicit allowlist is
// a security control (#218): a regression that returns `...shareData` (or adds a
// new field to the allowlist) must fail loudly. These tests lock the exact key
// set returned to anonymous viewers so internal metadata can never silently leak.

const PAGE_KEYS = ['id', 'slugId', 'title', 'icon', 'content'].sort();
const SHARE_KEYS = [
  'id',
  'key',
  'includeSubPages',
  'searchIndexing',
  'level',
  'sharedPage',
].sort();

// A page row carrying internal metadata that MUST NOT reach anonymous viewers.
function internalPage() {
  return {
    id: 'page-1',
    slugId: 'slug-1',
    title: 'Public Title',
    icon: '📄',
    content: { type: 'doc', content: [] },
    // --- leaky internals ---
    creatorId: 'user-1',
    lastUpdatedById: 'user-2',
    contributorIds: ['user-1', 'user-2'],
    spaceId: 'space-1',
    workspaceId: 'ws-1',
    parentPageId: 'parent-1',
    position: 'aa',
    isLocked: true,
    isTemplate: false,
    textContent: 'secret text content',
    ydoc: Buffer.from('binary'),
    createdAt: new Date('2020-01-01'),
    updatedAt: new Date('2020-01-02'),
    deletedAt: null,
  } as any;
}

// A resolved share carrying internal metadata.
function internalShare() {
  return {
    id: 'share-1',
    key: 'share-key',
    includeSubPages: false,
    searchIndexing: true,
    level: 0,
    sharedPage: { id: 'page-1', slugId: 'slug-1', title: 'Public Title' },
    // --- leaky internals ---
    creatorId: 'user-1',
    spaceId: 'space-1',
    workspaceId: 'ws-1',
    pageId: 'page-1',
    createdAt: new Date('2020-01-01'),
    updatedAt: new Date('2020-01-02'),
    deletedAt: null,
  } as any;
}

function buildController(over?: { aiAssistant?: boolean }) {
  const shareService = {
    // Deliberately returns the FULL internal records (as the real service does).
    getSharedPage: jest.fn(async () => ({
      page: internalPage(),
      share: internalShare(),
    })),
    isSharingAllowed: jest.fn(async () => true),
  };
  const aiSettings = {
    isPublicShareAssistantEnabled: jest.fn(
      async () => over?.aiAssistant ?? false,
    ),
    resolvePublicShareAssistantName: jest.fn(async () => 'Assistant'),
  };
  const licenseCheckService = {
    resolveFeatures: jest.fn(() => ({ tier: 'free' })),
  };

  const controller = new ShareController(
    shareService as any,
    {} as any, // shareRepo
    {} as any, // pageRepo
    {} as any, // pagePermissionRepo
    {} as any, // pageAccessService
    licenseCheckService as any,
    aiSettings as any,
    {} as any, // auditService
  );

  return { controller, shareService, aiSettings, licenseCheckService };
}

const workspace = {
  id: 'ws-1',
  licenseKey: null,
  plan: 'free',
} as any;

describe('ShareController.getSharedPageInfo — public payload whitelist (#218)', () => {
  it('returns EXACTLY the page allowlist keys (no leaked internals)', async () => {
    const { controller } = buildController();

    const res = await controller.getSharedPageInfo(
      { pageId: 'page-1' } as any,
      workspace,
    );

    expect(Object.keys(res.page).sort()).toEqual(PAGE_KEYS);
    for (const leaked of [
      'creatorId',
      'lastUpdatedById',
      'contributorIds',
      'spaceId',
      'workspaceId',
      'parentPageId',
      'position',
      'textContent',
      'ydoc',
      'createdAt',
      'updatedAt',
      'deletedAt',
    ]) {
      expect((res.page as any)[leaked]).toBeUndefined();
    }
    // The serialized payload must not carry the secret text content either.
    expect(JSON.stringify(res.page)).not.toContain('secret text content');
  });

  it('returns EXACTLY the share allowlist keys (no leaked internals)', async () => {
    const { controller } = buildController();

    const res = await controller.getSharedPageInfo(
      { pageId: 'page-1' } as any,
      workspace,
    );

    expect(Object.keys(res.share).sort()).toEqual(SHARE_KEYS);
    for (const leaked of [
      'creatorId',
      'spaceId',
      'workspaceId',
      'pageId',
      'createdAt',
      'updatedAt',
      'deletedAt',
    ]) {
      expect((res.share as any)[leaked]).toBeUndefined();
    }
  });

  it('surfaces the public AI-assistant flags and license features alongside the trimmed payload', async () => {
    const { controller } = buildController({ aiAssistant: true });

    const res = await controller.getSharedPageInfo(
      { pageId: 'page-1' } as any,
      workspace,
    );

    expect(res.aiAssistant).toBe(true);
    expect(res.aiAssistantName).toBe('Assistant');
    expect(res.features).toEqual({ tier: 'free' });
    // Top-level keys are limited to the trimmed payload + the public extras.
    expect(Object.keys(res).sort()).toEqual(
      ['page', 'share', 'aiAssistant', 'aiAssistantName', 'features'].sort(),
    );
  });
});

describe('toPublicSharePayload — key set is the contract', () => {
  it('copies only the allowlisted page/share keys', () => {
    const payload: PublicSharePayload = toPublicSharePayload(
      internalPage(),
      internalShare(),
    );

    expect(Object.keys(payload.page).sort()).toEqual(PAGE_KEYS);
    expect(Object.keys(payload.share).sort()).toEqual(SHARE_KEYS);
    expect(payload.page.id).toBe('page-1');
    expect(payload.share.key).toBe('share-key');
  });
});
