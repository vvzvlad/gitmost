import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { CommentController } from './comment.controller';

/**
 * Authz-gate tests for the apply-suggestion route. Applying a suggestion
 * rewrites the page text, so the route MUST call
 * pageAccessService.validateCanEdit BEFORE handing off to
 * commentService.applySuggestion (which performs the document mutation + stamp).
 * That ordering is a security boundary: an unauthorized user must never reach
 * the mutation. These tests pin it against a fully mocked controller so any
 * regression that drops the gate (or reorders it after the mutation) fails here.
 */
describe('CommentController apply-suggestion authz', () => {
  function makeController() {
    const commentService = {
      applySuggestion: jest.fn(async () => ({ id: 'c-1', applied: true })),
    };
    const commentRepo = { findById: jest.fn() };
    const pageRepo = { findById: jest.fn() };
    const spaceAbility = {} as any;
    const pageAccessService = {
      validateCanEdit: jest.fn(async () => undefined),
    };
    const wsService = {} as any;
    const auditService = { log: jest.fn() };

    const controller = new CommentController(
      commentService as any,
      commentRepo as any,
      pageRepo as any,
      spaceAbility,
      pageAccessService as any,
      wsService,
      auditService as any,
    );
    return {
      controller,
      commentService,
      commentRepo,
      pageRepo,
      pageAccessService,
    };
  }

  const user: any = { id: 'u-1' };
  const workspace: any = { id: 'ws-1' };
  const provenance: any = undefined;
  const dto: any = { commentId: 'c-1' };

  const comment = {
    id: 'c-1',
    pageId: 'p-1',
    spaceId: 'sp-1',
    suggestedText: 'new text',
    selection: 'old text',
  };
  const page = { id: 'p-1', spaceId: 'sp-1', deletedAt: null };

  it('validateCanEdit throwing Forbidden rejects AND applySuggestion is never called', async () => {
    const { controller, commentRepo, pageRepo, pageAccessService, commentService } =
      makeController();
    commentRepo.findById.mockResolvedValue(comment);
    pageRepo.findById.mockResolvedValue(page);
    pageAccessService.validateCanEdit.mockRejectedValue(
      new ForbiddenException('no edit access'),
    );

    await expect(
      controller.applySuggestion(dto, user, workspace, provenance),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // The security boundary: the mutation/stamp must NOT run for an
    // unauthorized user.
    expect(pageAccessService.validateCanEdit).toHaveBeenCalledWith(page, user);
    expect(commentService.applySuggestion).not.toHaveBeenCalled();
  });

  it('happy path: validateCanEdit resolves → applySuggestion is called and its result returned', async () => {
    const { controller, commentRepo, pageRepo, pageAccessService, commentService } =
      makeController();
    commentRepo.findById.mockResolvedValue(comment);
    pageRepo.findById.mockResolvedValue(page);
    const applied = { id: 'c-1', applied: true };
    commentService.applySuggestion.mockResolvedValue(applied);

    const result = await controller.applySuggestion(
      dto,
      user,
      workspace,
      provenance,
    );

    // Authorization ran before the mutation, then the service was invoked.
    expect(pageAccessService.validateCanEdit).toHaveBeenCalledWith(page, user);
    expect(commentService.applySuggestion).toHaveBeenCalledWith(
      comment,
      user,
      provenance,
    );
    expect(result).toBe(applied);
  });

  it('missing comment: NotFound is thrown without authorizing or applying', async () => {
    const { controller, commentRepo, pageRepo, pageAccessService, commentService } =
      makeController();
    commentRepo.findById.mockResolvedValue(null);

    await expect(
      controller.applySuggestion(dto, user, workspace, provenance),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(pageRepo.findById).not.toHaveBeenCalled();
    expect(pageAccessService.validateCanEdit).not.toHaveBeenCalled();
    expect(commentService.applySuggestion).not.toHaveBeenCalled();
  });
});

/**
 * Authz-gate tests for the dismiss-suggestion route (#329). Dismissing a
 * suggestion does NOT change the page text, so it authorizes with
 * validateCanComment (NOT validateCanEdit) — a viewer allowed to comment but not
 * edit can still dismiss. The gate MUST run BEFORE the service (which performs
 * the delete/resolve + mark removal). These tests pin that boundary.
 */
describe('CommentController dismiss-suggestion authz', () => {
  // isAdmin=false → ability.cannot(Manage, Settings) returns true (i.e. the user
  // is NOT a space admin). Flip to true to model a space admin.
  function makeController(isAdmin = false) {
    const commentService = {
      dismissSuggestion: jest.fn(async () => ({
        id: 'c-1',
        outcome: 'deleted',
      })),
    };
    const commentRepo = { findById: jest.fn() };
    const pageRepo = { findById: jest.fn() };
    const spaceAbility = {
      createForUser: jest.fn(async () => ({
        cannot: jest.fn(() => !isAdmin),
      })),
    } as any;
    const pageAccessService = {
      validateCanComment: jest.fn(async () => undefined),
      validateCanEdit: jest.fn(async () => undefined),
    };
    const wsService = {} as any;
    const auditService = { log: jest.fn() };

    const controller = new CommentController(
      commentService as any,
      commentRepo as any,
      pageRepo as any,
      spaceAbility,
      pageAccessService as any,
      wsService,
      auditService as any,
    );
    return {
      controller,
      commentService,
      commentRepo,
      pageRepo,
      pageAccessService,
      spaceAbility,
    };
  }

  const user: any = { id: 'u-1' };
  const workspace: any = { id: 'ws-1' };
  const provenance: any = undefined;
  const dto: any = { commentId: 'c-1' };
  // Owned by the acting user (u-1) unless a test overrides creatorId.
  const comment = {
    id: 'c-1',
    pageId: 'p-1',
    spaceId: 'sp-1',
    creatorId: 'u-1',
    suggestedText: 'new text',
    selection: 'old text',
  };
  const page = { id: 'p-1', spaceId: 'sp-1', deletedAt: null };

  it('authorizes with validateCanComment (NOT validateCanEdit) then calls the service', async () => {
    const {
      controller,
      commentRepo,
      pageRepo,
      pageAccessService,
      commentService,
    } = makeController();
    commentRepo.findById.mockResolvedValue(comment);
    pageRepo.findById.mockResolvedValue(page);
    const dismissed = { id: 'c-1', outcome: 'deleted' };
    commentService.dismissSuggestion.mockResolvedValue(dismissed);

    const result = await controller.dismissSuggestion(
      dto,
      user,
      workspace,
      provenance,
    );

    expect(pageAccessService.validateCanComment).toHaveBeenCalledWith(
      page,
      user,
      workspace.id,
    );
    // Dismiss must NOT require edit access.
    expect(pageAccessService.validateCanEdit).not.toHaveBeenCalled();
    expect(commentService.dismissSuggestion).toHaveBeenCalledWith(
      comment,
      user,
      provenance,
    );
    expect(result).toBe(dismissed);
  });

  it('validateCanComment throwing Forbidden rejects AND dismissSuggestion is never called', async () => {
    const {
      controller,
      commentRepo,
      pageRepo,
      pageAccessService,
      commentService,
    } = makeController();
    commentRepo.findById.mockResolvedValue(comment);
    pageRepo.findById.mockResolvedValue(page);
    pageAccessService.validateCanComment.mockRejectedValue(
      new ForbiddenException('no comment access'),
    );

    await expect(
      controller.dismissSuggestion(dto, user, workspace, provenance),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(commentService.dismissSuggestion).not.toHaveBeenCalled();
  });

  it('missing comment: NotFound without authorizing or dismissing', async () => {
    const { controller, commentRepo, pageRepo, pageAccessService, commentService } =
      makeController();
    commentRepo.findById.mockResolvedValue(null);

    await expect(
      controller.dismissSuggestion(dto, user, workspace, provenance),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(pageRepo.findById).not.toHaveBeenCalled();
    expect(pageAccessService.validateCanComment).not.toHaveBeenCalled();
    expect(commentService.dismissSuggestion).not.toHaveBeenCalled();
  });

  it('propagates a service BadRequest (e.g. already applied/resolved) unchanged', async () => {
    const { controller, commentRepo, pageRepo, commentService } =
      makeController();
    commentRepo.findById.mockResolvedValue(comment);
    pageRepo.findById.mockResolvedValue(page);
    commentService.dismissSuggestion.mockRejectedValue(
      new BadRequestException('already applied'),
    );

    await expect(
      controller.dismissSuggestion(dto, user, workspace, provenance),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // --- #338 owner-or-space-admin gate (mirrors POST /comments/delete) --------
  // A childless dismiss irreversibly hard-deletes the comment, so canComment is
  // not enough: only the comment owner or a space admin may dismiss.

  it('owner dismisses their own suggestion → allowed, no admin check needed', async () => {
    const { controller, commentRepo, pageRepo, commentService, spaceAbility } =
      makeController(false);
    // comment.creatorId === user.id (owner).
    commentRepo.findById.mockResolvedValue(comment);
    pageRepo.findById.mockResolvedValue(page);

    await controller.dismissSuggestion(dto, user, workspace, provenance);

    // Owner short-circuits the admin lookup.
    expect(spaceAbility.createForUser).not.toHaveBeenCalled();
    expect(commentService.dismissSuggestion).toHaveBeenCalledWith(
      comment,
      user,
      provenance,
    );
  });

  it('non-owner non-admin → Forbidden AND the service is never called', async () => {
    const { controller, commentRepo, pageRepo, commentService, spaceAbility } =
      makeController(false); // NOT a space admin
    commentRepo.findById.mockResolvedValue({
      ...comment,
      creatorId: 'someone-else',
    });
    pageRepo.findById.mockResolvedValue(page);

    await expect(
      controller.dismissSuggestion(dto, user, workspace, provenance),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(spaceAbility.createForUser).toHaveBeenCalledWith(user, comment.spaceId);
    expect(commentService.dismissSuggestion).not.toHaveBeenCalled();
  });

  it('non-owner space admin → allowed to dismiss another user’s suggestion', async () => {
    const { controller, commentRepo, pageRepo, commentService, spaceAbility } =
      makeController(true); // space admin
    commentRepo.findById.mockResolvedValue({
      ...comment,
      creatorId: 'someone-else',
    });
    pageRepo.findById.mockResolvedValue(page);

    await controller.dismissSuggestion(dto, user, workspace, provenance);

    expect(spaceAbility.createForUser).toHaveBeenCalledWith(user, comment.spaceId);
    expect(commentService.dismissSuggestion).toHaveBeenCalled();
  });
});
