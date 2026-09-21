import { AttachmentController } from './attachment.controller';
import { JwtType } from '../auth/dto/jwt-payload';

/**
 * getPublicFile (#574): a valid attachment token must not keep a soft-deleted
 * asset reachable. With an `approved` share the published content is a frozen
 * saved version that still references the attachment, so the endpoint has to
 * re-read the soft-delete state of BOTH the attachment row and its owning page
 * on every hit.
 */
describe('AttachmentController.getPublicFile — soft-delete re-check', () => {
  const workspaceId = '11111111-1111-4111-8111-111111111111';
  const pageId = '22222222-2222-4222-8222-222222222222';
  const attachmentId = '33333333-3333-4333-8333-333333333333';
  const otherPageId = '44444444-4444-4444-8444-444444444444';
  const otherAttachmentId = '55555555-5555-4555-8555-555555555555';

  const liveAttachment = () => ({
    id: attachmentId,
    fileName: 'diagram.png',
    filePath: 'space/x/diagram.png',
    fileSize: 1234,
    fileExt: '.png',
    mimeType: 'image/png',
    pageId,
    spaceId: '66666666-6666-4666-8666-666666666666',
    workspaceId,
    deletedAt: null,
  });

  const livePage = () => ({ id: pageId, workspaceId, deletedAt: null });

  const workspace = { id: workspaceId } as any;

  function build(overrides?: {
    attachment?: any;
    page?: any;
    jwtPayload?: any;
  }) {
    const attachment =
      overrides && 'attachment' in overrides
        ? overrides.attachment
        : liveAttachment();
    const page =
      overrides && 'page' in overrides ? overrides.page : livePage();

    const jwtPayload = overrides?.jwtPayload ?? {
      attachmentId,
      pageId,
      workspaceId,
      type: JwtType.ATTACHMENT,
    };

    const attachmentRepo = {
      findById: jest.fn().mockResolvedValue(attachment),
    };
    const pageRepo = { findById: jest.fn().mockResolvedValue(page) };
    const tokenService = {
      verifyJwt: jest.fn().mockResolvedValue(jwtPayload),
    };
    const storageService = {
      readStream: jest.fn().mockResolvedValue('file-stream'),
      readRangeStream: jest.fn(),
    };

    const controller = new AttachmentController(
      {} as any, // attachmentService
      storageService as any,
      {} as any, // workspaceAbility
      {} as any, // spaceAbility
      pageRepo as any,
      attachmentRepo as any,
      {} as any, // environmentService
      tokenService as any,
      {} as any, // pageAccessService
      { log: jest.fn() } as any, // auditService
    );

    const req = { headers: {} } as any;
    const res = {
      header: jest.fn(),
      headers: jest.fn(),
      status: jest.fn(),
      send: jest.fn().mockImplementation((body: any) => body),
    } as any;

    return { controller, req, res, storageService, pageRepo, attachmentRepo };
  }

  const call = (h: ReturnType<typeof build>) =>
    h.controller.getPublicFile(
      h.req,
      h.res,
      workspace,
      attachmentId,
      'diagram.png',
      'token',
    );

  it('(a) serves a live attachment on a live page', async () => {
    const h = build();
    await expect(call(h)).resolves.toBe('file-stream');
    expect(h.storageService.readStream).toHaveBeenCalledWith(
      'space/x/diagram.png',
    );
  });

  it('(b) refuses a soft-deleted attachment with 404 "File not found"', async () => {
    const h = build({
      attachment: { ...liveAttachment(), deletedAt: new Date() },
    });
    await expect(call(h)).rejects.toMatchObject({
      status: 404,
      message: 'File not found',
    });
    expect(h.storageService.readStream).not.toHaveBeenCalled();
  });

  it('(c) refuses a live attachment whose page is soft-deleted', async () => {
    const h = build({ page: { ...livePage(), deletedAt: new Date() } });
    await expect(call(h)).rejects.toMatchObject({
      status: 404,
      message: 'File not found',
    });
    expect(h.storageService.readStream).not.toHaveBeenCalled();
  });

  it('(c2) refuses when the owning page row is gone entirely', async () => {
    const h = build({ page: undefined });
    await expect(call(h)).rejects.toMatchObject({ status: 404 });
    expect(h.storageService.readStream).not.toHaveBeenCalled();
  });

  it('(d) refuses a token minted for a different page (no regression)', async () => {
    const h = build({
      jwtPayload: {
        attachmentId,
        pageId: otherPageId,
        workspaceId,
        type: JwtType.ATTACHMENT,
      },
    });
    await expect(call(h)).rejects.toMatchObject({
      status: 404,
      message: 'File not found',
    });
    expect(h.storageService.readStream).not.toHaveBeenCalled();
  });

  it('(d) refuses a token minted for a different file (no regression)', async () => {
    const h = build({
      jwtPayload: {
        attachmentId: otherAttachmentId,
        pageId,
        workspaceId,
        type: JwtType.ATTACHMENT,
      },
    });
    await expect(call(h)).rejects.toMatchObject({
      status: 404,
      message: 'File not found',
    });
    expect(h.storageService.readStream).not.toHaveBeenCalled();
  });

  it('(d) refuses a token minted for a different workspace (no regression)', async () => {
    const h = build({
      jwtPayload: {
        attachmentId,
        pageId,
        workspaceId: '77777777-7777-4777-8777-777777777777',
        type: JwtType.ATTACHMENT,
      },
    });
    await expect(call(h)).rejects.toMatchObject({ status: 404 });
    expect(h.storageService.readStream).not.toHaveBeenCalled();
  });
});
