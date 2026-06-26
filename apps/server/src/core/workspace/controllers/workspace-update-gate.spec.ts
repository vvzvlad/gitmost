import { ForbiddenException } from '@nestjs/common';
import { WorkspaceController } from './workspace.controller';
import WorkspaceAbilityFactory from '../../casl/abilities/workspace-ability.factory';
import { UserRole } from '../../../common/helpers/types/permission';

// Pins the admin gate on WorkspaceController.updateWorkspace: writing workspace
// settings (including the admin-only trackerHead snippet and the htmlEmbed
// toggle) requires Manage settings ability. A MEMBER must be Forbidden BEFORE
// workspaceService.update is ever called; OWNER/ADMIN pass through.
//
// The REAL WorkspaceAbilityFactory is used (the gate under test); only the leaf
// service deps are stubbed. The controller is constructed directly with stubs,
// mirroring the other controller specs in this codebase.

function buildController() {
  const update = jest
    .fn()
    .mockResolvedValue({ id: 'w1', hostname: 'acme' });
  const workspaceService = { update };

  const controller = new WorkspaceController(
    workspaceService as any,
    {} as any, // workspaceInvitationService
    new WorkspaceAbilityFactory(), // REAL ability factory (the gate under test)
    {} as any, // workspaceRepo
    {} as any, // environmentService
    {} as any, // licenseCheckService
  );

  return { controller, update };
}

const res = { clearCookie: jest.fn() } as any;
const workspace = { id: 'w1', hostname: 'acme' } as any;
const userWith = (role: UserRole) => ({ id: 'u1', role }) as any;

describe('WorkspaceController.updateWorkspace settings gate', () => {
  it('forbids a MEMBER from writing trackerHead and never calls update', async () => {
    const { controller, update } = buildController();

    await expect(
      controller.updateWorkspace(
        res,
        { trackerHead: '<script>ga()</script>' } as any,
        userWith(UserRole.MEMBER),
        workspace,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(update).not.toHaveBeenCalled();
  });

  it('forbids a MEMBER from toggling htmlEmbed and never calls update', async () => {
    const { controller, update } = buildController();

    await expect(
      controller.updateWorkspace(
        res,
        { htmlEmbed: true } as any,
        userWith(UserRole.MEMBER),
        workspace,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(update).not.toHaveBeenCalled();
  });

  it('allows an OWNER to write trackerHead (update is called with the dto)', async () => {
    const { controller, update } = buildController();
    const dto = { trackerHead: '<script>ga()</script>' } as any;

    await controller.updateWorkspace(
      res,
      dto,
      userWith(UserRole.OWNER),
      workspace,
    );

    expect(update).toHaveBeenCalledWith('w1', dto);
  });

  it('allows an ADMIN to write trackerHead (update is called with the dto)', async () => {
    const { controller, update } = buildController();
    const dto = { trackerHead: '<script>ga()</script>' } as any;

    await controller.updateWorkspace(
      res,
      dto,
      userWith(UserRole.ADMIN),
      workspace,
    );

    expect(update).toHaveBeenCalledWith('w1', dto);
  });
});
