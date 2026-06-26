import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { TransclusionService } from '../transclusion.service';

/**
 * Permission-boundary tests for TransclusionService.unsyncReference.
 *
 * unsyncReference converts a `transclusionReference` into a self-contained copy
 * on the reference page: it copies attachments and deletes the reference row.
 * It is a write path that must NOT exfiltrate data across workspaces and must
 * NOT escalate privilege. These tests assert that every guard fires BEFORE any
 * attachment storage copy / attachment row insert / ref-row delete happens.
 *
 * Service is built with the 10 positional constructor args; only the deps each
 * test touches are real stubs. Real storage is never exercised: content used in
 * these tests has no attachment nodes, so the attachment-copy block is never
 * entered on the success-shaped paths, and guard paths throw before it.
 *
 * Source order of guards (transclusion.service.ts ~681):
 *   1. referencePage missing/soft-deleted -> NotFound('Reference page not found')
 *   2. sourcePage missing/soft-deleted    -> NotFound('Source page not found')
 *   3. either page in a different workspace -> Forbidden
 *   4. validateCanEdit(referencePage)      (may throw -> propagates)
 *   5. validateCanView(sourcePage)
 *   6. transclusion row missing            -> NotFound('Sync block not found')
 */

const USER_WORKSPACE = 'ws-user';

function buildService(opts: {
  pages?: Record<string, any>;
  validateCanEdit?: jest.Mock;
  validateCanView?: jest.Mock;
  transclusion?: any;
}) {
  const pageRepo = {
    findById: jest.fn(async (id: string) => opts.pages?.[id] ?? null),
  };
  const pageAccessService = {
    validateCanEdit:
      opts.validateCanEdit ?? jest.fn().mockResolvedValue({ hasRestriction: false }),
    validateCanView: opts.validateCanView ?? jest.fn().mockResolvedValue(undefined),
  };
  const pageTransclusionsRepo = {
    findByPageAndTransclusion: jest
      .fn()
      .mockResolvedValue(opts.transclusion ?? null),
  };
  const pageTransclusionReferencesRepo = {
    deleteOne: jest.fn().mockResolvedValue(undefined),
  };
  const attachmentRepo = {
    findByIds: jest.fn().mockResolvedValue([]),
    insertAttachment: jest.fn().mockResolvedValue(undefined),
  };
  const storageService = {
    copy: jest.fn().mockResolvedValue(undefined),
  };

  const service = new TransclusionService(
    {} as any, // db
    pageTransclusionsRepo as any,
    pageTransclusionReferencesRepo as any,
    {} as any, // pageTemplateReferencesRepo
    pageRepo as any,
    {} as any, // pagePermissionRepo
    {} as any, // spaceMemberRepo
    attachmentRepo as any,
    storageService as any,
    pageAccessService as any,
  );

  return {
    service,
    pageRepo,
    pageAccessService,
    pageTransclusionsRepo,
    pageTransclusionReferencesRepo,
    attachmentRepo,
    storageService,
  };
}

const user = { id: 'user-1', workspaceId: USER_WORKSPACE } as any;

function refPage(overrides: Partial<any> = {}) {
  return {
    id: 'ref-1',
    workspaceId: USER_WORKSPACE,
    spaceId: 'space-ref',
    deletedAt: null,
    ...overrides,
  };
}
function srcPage(overrides: Partial<any> = {}) {
  return {
    id: 'src-1',
    workspaceId: USER_WORKSPACE,
    spaceId: 'space-src',
    deletedAt: null,
    ...overrides,
  };
}

describe('TransclusionService.unsyncReference (permission boundary)', () => {
  it('reference page in a DIFFERENT workspace -> Forbidden before any write or delete', async () => {
    const ctx = buildService({
      pages: {
        'ref-1': refPage({ workspaceId: 'other-ws' }),
        'src-1': srcPage(),
      },
      transclusion: { content: { type: 'doc', content: [] } },
    });

    await expect(
      ctx.service.unsyncReference('ref-1', 'src-1', 't1', user),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // No attachment copy, no attachment insert, no ref-row delete, and the
    // edit/view permission checks are never even reached.
    expect(ctx.storageService.copy).not.toHaveBeenCalled();
    expect(ctx.attachmentRepo.insertAttachment).not.toHaveBeenCalled();
    expect(ctx.pageTransclusionReferencesRepo.deleteOne).not.toHaveBeenCalled();
    expect(ctx.pageAccessService.validateCanEdit).not.toHaveBeenCalled();
  });

  it('source page in a DIFFERENT workspace -> Forbidden before any write or delete', async () => {
    const ctx = buildService({
      pages: {
        'ref-1': refPage(),
        'src-1': srcPage({ workspaceId: 'other-ws' }),
      },
      transclusion: { content: { type: 'doc', content: [] } },
    });

    await expect(
      ctx.service.unsyncReference('ref-1', 'src-1', 't1', user),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(ctx.storageService.copy).not.toHaveBeenCalled();
    expect(ctx.attachmentRepo.insertAttachment).not.toHaveBeenCalled();
    expect(ctx.pageTransclusionReferencesRepo.deleteOne).not.toHaveBeenCalled();
    expect(ctx.pageAccessService.validateCanEdit).not.toHaveBeenCalled();
  });

  it('reference page missing -> NotFound', async () => {
    const ctx = buildService({
      pages: { 'src-1': srcPage() }, // ref-1 absent
    });
    await expect(
      ctx.service.unsyncReference('ref-1', 'src-1', 't1', user),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(ctx.pageTransclusionReferencesRepo.deleteOne).not.toHaveBeenCalled();
  });

  it('reference page soft-deleted -> NotFound', async () => {
    const ctx = buildService({
      pages: {
        'ref-1': refPage({ deletedAt: new Date() }),
        'src-1': srcPage(),
      },
    });
    await expect(
      ctx.service.unsyncReference('ref-1', 'src-1', 't1', user),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(ctx.pageTransclusionReferencesRepo.deleteOne).not.toHaveBeenCalled();
  });

  it('source page missing -> NotFound', async () => {
    const ctx = buildService({
      pages: { 'ref-1': refPage() }, // src-1 absent
    });
    await expect(
      ctx.service.unsyncReference('ref-1', 'src-1', 't1', user),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(ctx.pageTransclusionReferencesRepo.deleteOne).not.toHaveBeenCalled();
  });

  it('source page soft-deleted -> NotFound', async () => {
    const ctx = buildService({
      pages: {
        'ref-1': refPage(),
        'src-1': srcPage({ deletedAt: new Date() }),
      },
    });
    await expect(
      ctx.service.unsyncReference('ref-1', 'src-1', 't1', user),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(ctx.pageTransclusionReferencesRepo.deleteOne).not.toHaveBeenCalled();
  });

  it('validateCanEdit(referencePage) throws -> propagates; no attachment copy, ref row NOT deleted', async () => {
    const editError = new ForbiddenException('no edit');
    const validateCanEdit = jest.fn().mockRejectedValue(editError);
    const validateCanView = jest.fn().mockResolvedValue(undefined);
    const ctx = buildService({
      pages: { 'ref-1': refPage(), 'src-1': srcPage() },
      validateCanEdit,
      validateCanView,
      transclusion: { content: { type: 'doc', content: [] } },
    });

    await expect(
      ctx.service.unsyncReference('ref-1', 'src-1', 't1', user),
    ).rejects.toBe(editError);

    // Edit check fires on the reference page (the write target).
    expect(validateCanEdit).toHaveBeenCalledTimes(1);
    expect(validateCanEdit.mock.calls[0][0].id).toBe('ref-1');
    // View on source never reached, no copy, no insert, no delete.
    expect(validateCanView).not.toHaveBeenCalled();
    expect(ctx.storageService.copy).not.toHaveBeenCalled();
    expect(ctx.attachmentRepo.insertAttachment).not.toHaveBeenCalled();
    expect(ctx.pageTransclusionReferencesRepo.deleteOne).not.toHaveBeenCalled();
  });

  it('transclusion row missing -> NotFound("Sync block not found"); no delete', async () => {
    const ctx = buildService({
      pages: { 'ref-1': refPage(), 'src-1': srcPage() },
      transclusion: null, // findByPageAndTransclusion resolves null
    });

    await expect(
      ctx.service.unsyncReference('ref-1', 'src-1', 't1', user),
    ).rejects.toMatchObject({ message: 'Sync block not found' });
    await expect(
      ctx.service.unsyncReference('ref-1', 'src-1', 't1', user),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(ctx.pageTransclusionReferencesRepo.deleteOne).not.toHaveBeenCalled();
    expect(ctx.attachmentRepo.insertAttachment).not.toHaveBeenCalled();
  });

  it('happy path with no attachment nodes: deletes the ref row, copies nothing', async () => {
    // Sanity check that with all guards passing and content carrying no
    // attachment nodes, the ref row IS deleted and no storage copy happens.
    const ctx = buildService({
      pages: { 'ref-1': refPage(), 'src-1': srcPage() },
      transclusion: {
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [] }],
        },
      },
    });

    const result = await ctx.service.unsyncReference(
      'ref-1',
      'src-1',
      't1',
      user,
    );

    expect(result).toHaveProperty('content');
    expect(ctx.storageService.copy).not.toHaveBeenCalled();
    expect(ctx.attachmentRepo.insertAttachment).not.toHaveBeenCalled();
    expect(ctx.pageTransclusionReferencesRepo.deleteOne).toHaveBeenCalledWith(
      'ref-1',
      'src-1',
      't1',
    );
  });
});
