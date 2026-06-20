import { ForbiddenException } from '@nestjs/common';
import { AiAgentRolesController } from './ai-agent-roles.controller';
import { WorkspaceCaslAction, WorkspaceCaslSubject } from '../../casl/interfaces/workspace-ability.type';
import type { User, Workspace } from '@docmost/db/types/entity.types';
import type {
  CreateAgentRoleDto,
  UpdateAgentRoleDto,
} from './dto/agent-role.dto';

/**
 * Security-critical unit tests for the admin gate on AiAgentRolesController.
 *
 * The invariant: create/update/delete are ADMIN-only (Manage Settings ability)
 * and MUST NOT touch the roles service when the caller is not an admin; `list`
 * is reachable by any member (the chat-creation role picker) and must NOT call
 * the admin gate. The gate mirrors the AI-settings / MCP-servers admin check.
 *
 * The controller body only delegates, so it is unit-constructed with a stubbed
 * roles service + a stubbed WorkspaceAbilityFactory whose returned ability's
 * `cannot` is controlled per test.
 */
describe('AiAgentRolesController admin gate', () => {
  const user = { id: 'u1' } as User;
  const workspace = { id: 'ws-1' } as Workspace;

  function makeController(isAdmin: boolean) {
    // `cannot(Manage, Settings)` returns FALSE for an admin (they CAN manage),
    // TRUE for a non-admin (they cannot) — matching CASL's ability.cannot.
    const ability = {
      cannot: jest.fn().mockReturnValue(!isAdmin),
    };
    const workspaceAbility = {
      createForUser: jest.fn().mockReturnValue(ability),
    };
    const rolesService = {
      list: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'r1' }),
      update: jest.fn().mockResolvedValue({ id: 'r1' }),
      remove: jest.fn().mockResolvedValue({ success: true }),
    };
    const controller = new AiAgentRolesController(
      rolesService as never,
      workspaceAbility as never,
    );
    return { controller, rolesService, workspaceAbility, ability };
  }

  const createDto = { name: 'R', instructions: 'do' } as CreateAgentRoleDto;
  const updateDto = { name: 'R2' } as UpdateAgentRoleDto;

  describe('non-admin', () => {
    it('create throws ForbiddenException and does NOT call the service', async () => {
      const { controller, rolesService } = makeController(false);
      await expect(
        controller.create(createDto, user, workspace),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(rolesService.create).not.toHaveBeenCalled();
    });

    it('update throws ForbiddenException and does NOT call the service', async () => {
      const { controller, rolesService } = makeController(false);
      await expect(
        controller.update({ id: 'r1' }, updateDto, user, workspace),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(rolesService.update).not.toHaveBeenCalled();
    });

    it('delete throws ForbiddenException and does NOT call the service', async () => {
      const { controller, rolesService } = makeController(false);
      await expect(
        controller.remove({ id: 'r1' }, user, workspace),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(rolesService.remove).not.toHaveBeenCalled();
    });

    it('the gate checks the Manage/Settings ability', async () => {
      const { controller, ability } = makeController(false);
      await controller.create(createDto, user, workspace).catch(() => {});
      expect(ability.cannot).toHaveBeenCalledWith(
        WorkspaceCaslAction.Manage,
        WorkspaceCaslSubject.Settings,
      );
    });
  });

  describe('admin', () => {
    it('create delegates to the service with workspace.id', async () => {
      const { controller, rolesService } = makeController(true);
      await controller.create(createDto, user, workspace);
      expect(rolesService.create).toHaveBeenCalledWith(
        'ws-1',
        'u1',
        createDto,
      );
    });

    it('update delegates to the service with workspace.id + role id', async () => {
      const { controller, rolesService } = makeController(true);
      await controller.update({ id: 'r1' }, updateDto, user, workspace);
      expect(rolesService.update).toHaveBeenCalledWith('ws-1', 'r1', updateDto);
    });

    it('delete delegates to the service with workspace.id + role id', async () => {
      const { controller, rolesService } = makeController(true);
      await controller.remove({ id: 'r1' }, user, workspace);
      expect(rolesService.remove).toHaveBeenCalledWith('ws-1', 'r1');
    });
  });

  describe('list (member-reachable)', () => {
    it('does NOT call the admin gate, and delegates to the service', async () => {
      const { controller, rolesService, workspaceAbility } =
        makeController(false); // even a non-admin reaches list
      await controller.list(workspace);
      expect(rolesService.list).toHaveBeenCalledWith('ws-1');
      // assertAdmin builds an ability via createForUser — list must skip it.
      expect(workspaceAbility.createForUser).not.toHaveBeenCalled();
    });
  });
});
