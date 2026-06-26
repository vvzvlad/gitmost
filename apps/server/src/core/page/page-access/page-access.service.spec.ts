import { ForbiddenException } from '@nestjs/common';
import { PageAccessService } from './page-access.service';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../../casl/interfaces/space-ability.type';

/**
 * Unit tests for PageAccessService — the privilege-escalation surface of the
 * page-access layer. The service is constructed directly with three jest-mocked
 * positional deps in the exact constructor order:
 *
 *   new PageAccessService(pagePermissionRepo, spaceAbility, spaceRepo)
 *
 * The CASL ability returned by `spaceAbility.createForUser` is mocked as a plain
 * object exposing `can`/`cannot`. We drive `can`/`cannot` per (action, subject)
 * so the restriction-vs-space-level branch logic can be exercised precisely.
 *
 * The most dangerous bug class here is branch inversion: if `validateCanEdit`
 * reads the SPACE ability when the page is restricted (or vice versa), a viewer
 * could edit a restricted page, or a page-level writer could be blocked. The
 * tests below pin the EXACT source of the edit decision for each branch.
 */

type AbilityDecision = (
  action: SpaceCaslAction,
  subject: SpaceCaslSubject,
) => boolean;

/**
 * Build a CASL-like ability stub. `decide` returns true when the user CAN do
 * (action, subject). `cannot` is the strict negation of `can`, matching CASL.
 */
function makeAbility(decide: AbilityDecision) {
  return {
    can: jest.fn((action: SpaceCaslAction, subject: SpaceCaslSubject) =>
      decide(action, subject),
    ),
    cannot: jest.fn(
      (action: SpaceCaslAction, subject: SpaceCaslSubject) =>
        !decide(action, subject),
    ),
  };
}

/**
 * Common "space member" ability: can Read pages, edit governed by `canEdit`.
 */
function memberAbility(canEdit: boolean) {
  return makeAbility((action, subject) => {
    if (subject !== SpaceCaslSubject.Page) return false;
    if (action === SpaceCaslAction.Read) return true;
    if (action === SpaceCaslAction.Edit) return canEdit;
    return false;
  });
}

/** Ability of a user who is NOT a space member: cannot even Read. */
function nonMemberAbility() {
  return makeAbility(() => false);
}

function buildService(opts: {
  ability: ReturnType<typeof makeAbility>;
  canUserEditPage?: () => Promise<{
    hasAnyRestriction: boolean;
    canAccess: boolean;
    canEdit: boolean;
  }>;
  canUserAccessPage?: () => Promise<boolean>;
  space?: unknown;
}) {
  const pagePermissionRepo = {
    canUserEditPage: jest.fn(
      opts.canUserEditPage ??
        (async () => ({
          hasAnyRestriction: false,
          canAccess: true,
          canEdit: true,
        })),
    ),
    canUserAccessPage: jest.fn(
      opts.canUserAccessPage ?? (async () => true),
    ),
  };
  const spaceAbility = {
    createForUser: jest.fn().mockResolvedValue(opts.ability),
  };
  const spaceRepo = {
    findById: jest.fn().mockResolvedValue(opts.space ?? null),
  };

  const service = new PageAccessService(
    pagePermissionRepo as any,
    spaceAbility as any,
    spaceRepo as any,
  );
  return { service, pagePermissionRepo, spaceAbility, spaceRepo };
}

const page = { id: 'page-1', spaceId: 'space-1' } as any;
const user = { id: 'user-1' } as any;

describe('PageAccessService.validateCanEdit', () => {
  it('throws Forbidden when the user is not a space member (cannot Read)', async () => {
    const { service, pagePermissionRepo } = buildService({
      ability: nonMemberAbility(),
    });

    await expect(service.validateCanEdit(page, user)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // Must short-circuit before ever consulting page-level permissions.
    expect(pagePermissionRepo.canUserEditPage).not.toHaveBeenCalled();
  });

  it('throws Forbidden when page is restricted and page-level canEdit is false', async () => {
    // Restriction present -> the page-level writer flag governs. Even though the
    // space ability grants Edit, a restricted page without a writer grant blocks.
    const { service } = buildService({
      ability: memberAbility(true),
      canUserEditPage: async () => ({
        hasAnyRestriction: true,
        canAccess: true,
        canEdit: false,
      }),
    });

    await expect(service.validateCanEdit(page, user)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('returns {hasRestriction:true} when page is restricted and page-level canEdit is true', async () => {
    // Restricted + page-level writer grant. The SPACE ability denies Edit, but
    // the page-level grant must win — a branch inversion here would block a
    // legitimate page writer.
    const { service } = buildService({
      ability: memberAbility(false),
      canUserEditPage: async () => ({
        hasAnyRestriction: true,
        canAccess: true,
        canEdit: true,
      }),
    });

    await expect(service.validateCanEdit(page, user)).resolves.toEqual({
      hasRestriction: true,
    });
  });

  it('throws Forbidden when page is unrestricted but the space ability denies Edit', async () => {
    // No restriction -> the space-level Edit decides. Space denies -> Forbidden,
    // even though page-level canEdit happens to be true (must be ignored here).
    const { service } = buildService({
      ability: memberAbility(false),
      canUserEditPage: async () => ({
        hasAnyRestriction: false,
        canAccess: true,
        canEdit: true,
      }),
    });

    await expect(service.validateCanEdit(page, user)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('returns {hasRestriction:false} when page is unrestricted and the space allows Edit', async () => {
    const { service } = buildService({
      ability: memberAbility(true),
      canUserEditPage: async () => ({
        hasAnyRestriction: false,
        canAccess: true,
        canEdit: false, // ignored: unrestricted -> space ability governs
      }),
    });

    await expect(service.validateCanEdit(page, user)).resolves.toEqual({
      hasRestriction: false,
    });
  });
});

describe('PageAccessService.validateCanViewWithPermissions', () => {
  it('throws Forbidden when restricted and canAccess is false', async () => {
    const { service } = buildService({
      ability: memberAbility(true),
      canUserEditPage: async () => ({
        hasAnyRestriction: true,
        canAccess: false,
        canEdit: true,
      }),
    });

    await expect(
      service.validateCanViewWithPermissions(page, user),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('restricted+accessible: canEdit is taken from canUserEditPage (NOT the space ability)', async () => {
    // Space ability would say "can edit" — but because the page is restricted,
    // the repo's page-level canEdit (false here) must be returned instead.
    const { service } = buildService({
      ability: memberAbility(true),
      canUserEditPage: async () => ({
        hasAnyRestriction: true,
        canAccess: true,
        canEdit: false,
      }),
    });

    await expect(
      service.validateCanViewWithPermissions(page, user),
    ).resolves.toEqual({ canEdit: false, hasRestriction: true });
  });

  it('restricted+accessible: surfaces page-level canEdit true', async () => {
    // Space ability denies Edit, but page-level writer grant must surface.
    const { service } = buildService({
      ability: memberAbility(false),
      canUserEditPage: async () => ({
        hasAnyRestriction: true,
        canAccess: true,
        canEdit: true,
      }),
    });

    await expect(
      service.validateCanViewWithPermissions(page, user),
    ).resolves.toEqual({ canEdit: true, hasRestriction: true });
  });

  it('unrestricted: canEdit comes from the SPACE ability, not the repo', async () => {
    // hasAnyRestriction false -> the SPACE Edit ability decides. The repo's
    // canEdit (false) must be ignored; the space grant (true) must win.
    const { service } = buildService({
      ability: memberAbility(true),
      canUserEditPage: async () => ({
        hasAnyRestriction: false,
        canAccess: true,
        canEdit: false,
      }),
    });

    await expect(
      service.validateCanViewWithPermissions(page, user),
    ).resolves.toEqual({ canEdit: true, hasRestriction: false });
  });

  it('unrestricted: space-denied Edit yields canEdit false even if repo says true', async () => {
    const { service } = buildService({
      ability: memberAbility(false),
      canUserEditPage: async () => ({
        hasAnyRestriction: false,
        canAccess: true,
        canEdit: true, // ignored
      }),
    });

    await expect(
      service.validateCanViewWithPermissions(page, user),
    ).resolves.toEqual({ canEdit: false, hasRestriction: false });
  });

  it('throws Forbidden when the user is not a space member', async () => {
    const { service, pagePermissionRepo } = buildService({
      ability: nonMemberAbility(),
    });
    await expect(
      service.validateCanViewWithPermissions(page, user),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(pagePermissionRepo.canUserEditPage).not.toHaveBeenCalled();
  });
});

describe('PageAccessService.validateCanComment', () => {
  it('returns immediately for an editor (validateCanEdit succeeds)', async () => {
    // Editor path: validateCanEdit resolves, so view/space-settings are never
    // consulted. allowViewerComments is irrelevant for an editor.
    const { service, spaceRepo, pagePermissionRepo } = buildService({
      ability: memberAbility(true),
      canUserEditPage: async () => ({
        hasAnyRestriction: false,
        canAccess: true,
        canEdit: true,
      }),
    });

    await expect(
      service.validateCanComment(page, user, 'ws-1'),
    ).resolves.toBeUndefined();
    // No need to fall through to the space-settings viewer-comment gate.
    expect(spaceRepo.findById).not.toHaveBeenCalled();
    expect(pagePermissionRepo.canUserAccessPage).not.toHaveBeenCalled();
  });

  it('passes for a non-editor viewer when allowViewerComments is true', async () => {
    // Not an editor (space denies Edit, no restriction) but can view, and the
    // space setting allows viewer comments -> resolves.
    const { service } = buildService({
      ability: memberAbility(false),
      canUserEditPage: async () => ({
        hasAnyRestriction: false,
        canAccess: true,
        canEdit: false,
      }),
      canUserAccessPage: async () => true,
      space: { settings: { comments: { allowViewerComments: true } } },
    });

    await expect(
      service.validateCanComment(page, user, 'ws-1'),
    ).resolves.toBeUndefined();
  });

  it('throws Forbidden for a non-editor viewer when allowViewerComments is false', async () => {
    const { service } = buildService({
      ability: memberAbility(false),
      canUserEditPage: async () => ({
        hasAnyRestriction: false,
        canAccess: true,
        canEdit: false,
      }),
      canUserAccessPage: async () => true,
      space: { settings: { comments: { allowViewerComments: false } } },
    });

    await expect(
      service.validateCanComment(page, user, 'ws-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throws Forbidden for a non-editor viewer when the setting is absent', async () => {
    // No comments settings at all (and a null space) -> the viewer-comment gate
    // is closed by default.
    const { service } = buildService({
      ability: memberAbility(false),
      canUserEditPage: async () => ({
        hasAnyRestriction: false,
        canAccess: true,
        canEdit: false,
      }),
      canUserAccessPage: async () => true,
      space: null,
    });

    await expect(
      service.validateCanComment(page, user, 'ws-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throws Forbidden when the user cannot view (non-editor AND no view access)', async () => {
    // Not an editor, and validateCanView fails (canUserAccessPage false) -> the
    // viewer-comment branch is never reached; Forbidden from validateCanView.
    const { service, spaceRepo } = buildService({
      ability: memberAbility(false),
      canUserEditPage: async () => ({
        hasAnyRestriction: false,
        canAccess: true,
        canEdit: false,
      }),
      canUserAccessPage: async () => false,
      space: { settings: { comments: { allowViewerComments: true } } },
    });

    await expect(
      service.validateCanComment(page, user, 'ws-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // view check fails before we ever look at space settings.
    expect(spaceRepo.findById).not.toHaveBeenCalled();
  });
});
