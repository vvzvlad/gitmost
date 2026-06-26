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
    // CASL semantics: `can(Manage, Settings)` is TRUE for an admin / FALSE for a
    // non-admin; `cannot(...)` is the inverse. The controller uses `can` (via
    // canManageSettings) for both the admin gate and the list view branch.
    const ability = {
      can: jest.fn().mockReturnValue(isAdmin),
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
      getCatalog: jest.fn().mockResolvedValue({ languages: [], bundles: [] }),
      getCatalogBundle: jest.fn().mockResolvedValue({ roles: [] }),
      importFromCatalog: jest.fn().mockResolvedValue({ created: 0 }),
      updateFromCatalog: jest.fn().mockResolvedValue({ updated: false }),
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
      expect(ability.can).toHaveBeenCalledWith(
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

  // Catalog routes (browse + import) are ALL admin-only: a non-admin caller must
  // get ForbiddenException with the service untouched; an admin delegates with
  // the right arguments (import/update-from-catalog carry workspace.id).
  describe('catalog routes admin gate', () => {
    const catalogDto = { language: 'en' } as never;
    const bundleDto = { bundleId: 'general', language: 'en' } as never;
    const importDto = {
      bundleId: 'general',
      language: 'en',
      conflict: 'skip',
    } as never;
    const updateDto = { id: 'r1' } as never;

    describe('non-admin is rejected and the service is NOT called', () => {
      it('catalog', async () => {
        const { controller, rolesService } = makeController(false);
        await expect(
          controller.catalog(catalogDto, user, workspace),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(rolesService.getCatalog).not.toHaveBeenCalled();
      });

      it('catalog/bundle', async () => {
        const { controller, rolesService } = makeController(false);
        await expect(
          controller.catalogBundle(bundleDto, user, workspace),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(rolesService.getCatalogBundle).not.toHaveBeenCalled();
      });

      it('import', async () => {
        const { controller, rolesService } = makeController(false);
        await expect(
          controller.import(importDto, user, workspace),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(rolesService.importFromCatalog).not.toHaveBeenCalled();
      });

      it('update-from-catalog', async () => {
        const { controller, rolesService } = makeController(false);
        await expect(
          controller.updateFromCatalog(updateDto, user, workspace),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(rolesService.updateFromCatalog).not.toHaveBeenCalled();
      });
    });

    describe('admin delegates to the service', () => {
      it('catalog passes the requested language', async () => {
        const { controller, rolesService } = makeController(true);
        await controller.catalog(catalogDto, user, workspace);
        expect(rolesService.getCatalog).toHaveBeenCalledWith('en');
      });

      it('catalog/bundle passes bundleId + language', async () => {
        const { controller, rolesService } = makeController(true);
        await controller.catalogBundle(bundleDto, user, workspace);
        expect(rolesService.getCatalogBundle).toHaveBeenCalledWith(
          'general',
          'en',
        );
      });

      it('import passes workspace.id + user.id + dto', async () => {
        const { controller, rolesService } = makeController(true);
        await controller.import(importDto, user, workspace);
        expect(rolesService.importFromCatalog).toHaveBeenCalledWith(
          'ws-1',
          'u1',
          importDto,
        );
      });

      it('update-from-catalog passes workspace.id + dto', async () => {
        const { controller, rolesService } = makeController(true);
        await controller.updateFromCatalog(updateDto, user, workspace);
        expect(rolesService.updateFromCatalog).toHaveBeenCalledWith(
          'ws-1',
          updateDto,
        );
      });
    });
  });

  describe('list (member-reachable)', () => {
    it('non-admin reaches list and the service is asked for the picker view (isAdmin=false)', async () => {
      const { controller, rolesService } = makeController(false);
      await controller.list(user, workspace);
      // The member view is requested: workspace.id + isAdmin=false.
      expect(rolesService.list).toHaveBeenCalledWith('ws-1', false);
    });

    it('admin reaches list and the service is asked for the full view (isAdmin=true)', async () => {
      const { controller, rolesService } = makeController(true);
      await controller.list(user, workspace);
      expect(rolesService.list).toHaveBeenCalledWith('ws-1', true);
    });
  });
});
