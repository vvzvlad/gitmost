import { BadRequestException } from '@nestjs/common';
import { AiAgentRolesService } from './ai-agent-roles.service';
import type { AiAgentRole } from '@docmost/db/types/entity.types';
import type {
  CreateAgentRoleDto,
  UpdateAgentRoleDto,
} from './dto/agent-role.dto';

/**
 * Unit tests for AiAgentRolesService CRUD guards: cross-workspace isolation
 * (update/remove must verify the role exists in THIS workspace before mutating)
 * and the modelConfig normalization the persisted column relies on.
 *
 * The service only stores the repo, so it is unit-constructed with a stubbed
 * repo.
 */
describe('AiAgentRolesService guards', () => {
  function makeRow(over: Partial<AiAgentRole> = {}): AiAgentRole {
    return {
      id: 'r1',
      workspaceId: 'ws-1',
      name: 'Researcher',
      emoji: null,
      description: null,
      instructions: 'be a researcher',
      modelConfig: null,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as AiAgentRole;
  }

  function makeService(opts: { existing?: AiAgentRole | undefined } = {}) {
    const repo = {
      findById: jest.fn().mockResolvedValue(opts.existing),
      insert: jest.fn().mockImplementation((v) => Promise.resolve(makeRow(v))),
      update: jest.fn().mockResolvedValue(undefined),
      softDelete: jest.fn().mockResolvedValue(undefined),
      listByWorkspace: jest.fn().mockResolvedValue([]),
    };
    const service = new AiAgentRolesService(repo as never);
    return { service, repo };
  }

  describe('update', () => {
    it('findById undefined (cross-workspace / concurrent delete) => BadRequest, repo.update NOT called', async () => {
      const { service, repo } = makeService({ existing: undefined });
      await expect(
        service.update('ws-1', 'r1', { name: 'X' } as UpdateAgentRoleDto),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('modelConfig:null clears it (passes null to repo.update)', async () => {
      const { service, repo } = makeService({ existing: makeRow() });
      await service.update('ws-1', 'r1', {
        modelConfig: null,
      } as UpdateAgentRoleDto);
      expect(repo.update).toHaveBeenCalledWith(
        'r1',
        'ws-1',
        expect.objectContaining({ modelConfig: null }),
      );
    });

    it('modelConfig:{driver} normalizes to the persisted shape', async () => {
      const { service, repo } = makeService({ existing: makeRow() });
      await service.update('ws-1', 'r1', {
        modelConfig: { driver: 'gemini' },
      } as UpdateAgentRoleDto);
      expect(repo.update).toHaveBeenCalledWith(
        'r1',
        'ws-1',
        expect.objectContaining({ modelConfig: { driver: 'gemini' } }),
      );
    });

    it('modelConfig omitted => repo.update receives undefined for that field (unchanged)', async () => {
      const { service, repo } = makeService({ existing: makeRow() });
      await service.update('ws-1', 'r1', {
        name: 'New name',
      } as UpdateAgentRoleDto);
      const patch = repo.update.mock.calls[0][2];
      expect(patch.modelConfig).toBeUndefined();
      expect(patch.name).toBe('New name');
    });

    it('name set to whitespace => BadRequest, repo.update NOT called', async () => {
      const { service, repo } = makeService({ existing: makeRow() });
      await expect(
        service.update('ws-1', 'r1', { name: '   ' } as UpdateAgentRoleDto),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.update).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('findById undefined => BadRequest, softDelete NOT called', async () => {
      const { service, repo } = makeService({ existing: undefined });
      await expect(service.remove('ws-1', 'r1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repo.softDelete).not.toHaveBeenCalled();
    });

    it('existing role => softDelete called workspace-scoped', async () => {
      const { service, repo } = makeService({ existing: makeRow() });
      await expect(service.remove('ws-1', 'r1')).resolves.toEqual({
        success: true,
      });
      expect(repo.softDelete).toHaveBeenCalledWith('r1', 'ws-1');
    });
  });

  describe('create', () => {
    it('blank name => BadRequest', async () => {
      const { service, repo } = makeService();
      await expect(
        service.create('ws-1', 'u1', {
          name: '   ',
          instructions: 'do',
        } as CreateAgentRoleDto),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.insert).not.toHaveBeenCalled();
    });

    it('blank instructions => BadRequest', async () => {
      const { service, repo } = makeService();
      await expect(
        service.create('ws-1', 'u1', {
          name: 'R',
          instructions: '   ',
        } as CreateAgentRoleDto),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.insert).not.toHaveBeenCalled();
    });
  });
});
