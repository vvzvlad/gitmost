import { BadRequestException, ConflictException } from '@nestjs/common';
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
      autoStart: true,
      launchMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
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

    it('instructions cleared to whitespace => BadRequest, repo.update NOT called', async () => {
      const { service, repo } = makeService({ existing: makeRow() });
      await expect(
        service.update('ws-1', 'r1', {
          instructions: '   ',
        } as UpdateAgentRoleDto),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('concurrent soft-delete: row exists on the pre-update lookup but the re-fetch is undefined => BadRequest (not a TypeError)', async () => {
      // findById returns the live row FIRST (pre-update guard passes), then the
      // role is soft-deleted concurrently, so the POST-update re-fetch returns
      // undefined. The service must surface a clean 400, never dereference
      // undefined (which would throw a TypeError in toView).
      const { service, repo } = makeService();
      repo.findById
        .mockResolvedValueOnce(makeRow())
        .mockResolvedValueOnce(undefined);
      await expect(
        service.update('ws-1', 'r1', { name: 'X' } as UpdateAgentRoleDto),
      ).rejects.toBeInstanceOf(BadRequestException);
      // The UPDATE ran (the row existed pre-update), but the re-fetch failed.
      expect(repo.update).toHaveBeenCalled();
      expect(repo.findById).toHaveBeenCalledTimes(2);
    });

    it('happy path returns toView(updated) reflecting the POST-update re-fetch (full AgentRoleView shape)', async () => {
      // The pre-update guard sees the OLD row; the post-update re-fetch returns a
      // DISTINCT row (the freshly-persisted state). The service must return the
      // view built from the SECOND findById, not the first — proving update()
      // returns toView(updated) rather than toView(existing).
      const { service, repo } = makeService();
      const oldRow = makeRow({ id: 'r1', name: 'Old name' });
      const createdAt = new Date('2024-01-01T00:00:00.000Z');
      const updatedAt = new Date('2024-06-20T00:00:00.000Z');
      const updatedRow = makeRow({
        id: 'r1',
        name: 'New name',
        emoji: '🤖',
        description: 'updated description',
        instructions: 'updated instructions',
        modelConfig: { driver: 'gemini', chatModel: 'gemini-2.0-flash' } as never,
        enabled: false,
        createdAt,
        updatedAt,
      });
      repo.findById
        .mockResolvedValueOnce(oldRow)
        .mockResolvedValueOnce(updatedRow);

      const result = await service.update('ws-1', 'r1', {
        name: 'New name',
      } as UpdateAgentRoleDto);

      // The returned value is the full admin view of the RE-FETCHED row, with
      // exactly the fields toView produces (no extra/leaked columns).
      expect(result).toEqual({
        id: 'r1',
        name: 'New name',
        emoji: '🤖',
        description: 'updated description',
        instructions: 'updated instructions',
        modelConfig: { driver: 'gemini', chatModel: 'gemini-2.0-flash' },
        enabled: false,
        autoStart: true,
        launchMessage: null,
        createdAt,
        updatedAt,
      });
    });

    it('emoji/description tri-state: emoji:"" => null (clear), emoji omitted => undefined (unchanged), description:"  " => null', async () => {
      const { service, repo } = makeService({ existing: makeRow() });

      // emoji explicitly emptied => clear to null; description whitespace => null.
      await service.update('ws-1', 'r1', {
        emoji: '',
        description: '  ',
      } as UpdateAgentRoleDto);
      const patch1 = repo.update.mock.calls[0][2];
      expect(patch1.emoji).toBeNull();
      expect(patch1.description).toBeNull();

      repo.update.mockClear();

      // emoji omitted => unchanged (undefined passed through to the repo patch).
      await service.update('ws-1', 'r1', {
        name: 'Renamed',
      } as UpdateAgentRoleDto);
      const patch2 = repo.update.mock.calls[0][2];
      expect(patch2.emoji).toBeUndefined();
      expect(patch2.description).toBeUndefined();
    });

    it('autoStart/launchMessage thread through; launchMessage:"" clears to null', async () => {
      const { service, repo } = makeService({ existing: makeRow() });
      await service.update('ws-1', 'r1', {
        autoStart: false,
        launchMessage: '  custom  ',
      } as UpdateAgentRoleDto);
      const patch = repo.update.mock.calls[0][2];
      expect(patch.autoStart).toBe(false);
      expect(patch.launchMessage).toBe('custom');

      repo.update.mockClear();

      // Explicit empty => clear to null.
      await service.update('ws-1', 'r1', {
        launchMessage: '   ',
      } as UpdateAgentRoleDto);
      expect(repo.update.mock.calls[0][2].launchMessage).toBeNull();
    });

    it('autoStart/launchMessage omitted => undefined (unchanged) in the patch', async () => {
      const { service, repo } = makeService({ existing: makeRow() });
      await service.update('ws-1', 'r1', {
        name: 'Renamed',
      } as UpdateAgentRoleDto);
      const patch = repo.update.mock.calls[0][2];
      expect(patch.autoStart).toBeUndefined();
      expect(patch.launchMessage).toBeUndefined();
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

    it('modelConfig:{chatModel} only persists {chatModel} (no driver key)', async () => {
      const { service, repo } = makeService();
      await service.create('ws-1', 'u1', {
        name: 'R',
        instructions: 'do',
        modelConfig: { chatModel: 'gpt-4o' },
      } as CreateAgentRoleDto);
      const values = repo.insert.mock.calls[0][0];
      expect(values.modelConfig).toEqual({ chatModel: 'gpt-4o' });
      expect('driver' in values.modelConfig).toBe(false);
    });

    it('modelConfig:{} (empty) normalizes to null', async () => {
      const { service, repo } = makeService();
      await service.create('ws-1', 'u1', {
        name: 'R',
        instructions: 'do',
        modelConfig: {},
      } as CreateAgentRoleDto);
      expect(repo.insert.mock.calls[0][0].modelConfig).toBeNull();
    });

    it('modelConfig:{chatModel:"   "} (whitespace-only) normalizes to null', async () => {
      const { service, repo } = makeService();
      await service.create('ws-1', 'u1', {
        name: 'R',
        instructions: 'do',
        modelConfig: { chatModel: '   ' },
      } as CreateAgentRoleDto);
      expect(repo.insert.mock.calls[0][0].modelConfig).toBeNull();
    });

    it('modelConfig:{driver,chatModel} round-trips both fields (trimmed)', async () => {
      const { service, repo } = makeService();
      await service.create('ws-1', 'u1', {
        name: 'R',
        instructions: 'do',
        modelConfig: { driver: 'gemini', chatModel: '  gemini-2.0-flash  ' },
      } as CreateAgentRoleDto);
      expect(repo.insert.mock.calls[0][0].modelConfig).toEqual({
        driver: 'gemini',
        chatModel: 'gemini-2.0-flash',
      });
    });

    it('duplicate name (Postgres 23505) => ConflictException (409), not 500', async () => {
      const { service, repo } = makeService();
      // The partial unique (workspace_id, name) index rejects the insert.
      repo.insert.mockRejectedValueOnce({ code: '23505' });
      await expect(
        service.create('ws-1', 'u1', {
          name: 'Researcher',
          instructions: 'do',
        } as CreateAgentRoleDto),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('duplicate name 409 message contains the TRIMMED submitted name', async () => {
      const { service, repo } = makeService();
      repo.insert.mockRejectedValueOnce({ code: '23505' });
      await service
        .create('ws-1', 'u1', {
          name: '  Researcher  ',
          instructions: 'do',
        } as CreateAgentRoleDto)
        .then(
          () => {
            throw new Error('expected create to throw');
          },
          (err: unknown) => {
            expect(err).toBeInstanceOf(ConflictException);
            const message = (err as ConflictException).message;
            // The trimmed name appears verbatim; the untrimmed padding does not.
            expect(message).toContain('"Researcher"');
            expect(message).not.toContain('  Researcher  ');
          },
        );
    });

    it('non-unique-violation error is NOT swallowed (re-thrown as-is)', async () => {
      const { service, repo } = makeService();
      const other = Object.assign(new Error('boom'), { code: '23502' });
      repo.insert.mockRejectedValueOnce(other);
      await expect(
        service.create('ws-1', 'u1', {
          name: 'Researcher',
          instructions: 'do',
        } as CreateAgentRoleDto),
      ).rejects.toBe(other);
    });

    it('autoStart omitted => defaults to true; launchMessage omitted => null', async () => {
      const { service, repo } = makeService();
      await service.create('ws-1', 'u1', {
        name: 'R',
        instructions: 'do',
      } as CreateAgentRoleDto);
      const values = repo.insert.mock.calls[0][0];
      expect(values.autoStart).toBe(true);
      expect(values.launchMessage).toBeNull();
    });

    it('autoStart:false + launchMessage round-trip (trimmed) to the repo', async () => {
      const { service, repo } = makeService();
      await service.create('ws-1', 'u1', {
        name: 'R',
        instructions: 'do',
        autoStart: false,
        launchMessage: '  do the thing  ',
      } as CreateAgentRoleDto);
      const values = repo.insert.mock.calls[0][0];
      expect(values.autoStart).toBe(false);
      expect(values.launchMessage).toBe('do the thing');
    });

    it('empty/whitespace launchMessage normalizes to null', async () => {
      const { service, repo } = makeService();
      await service.create('ws-1', 'u1', {
        name: 'R',
        instructions: 'do',
        launchMessage: '   ',
      } as CreateAgentRoleDto);
      expect(repo.insert.mock.calls[0][0].launchMessage).toBeNull();
    });
  });

  describe('list view (security: non-admin must not see instructions/modelConfig)', () => {
    function makeListService(rows: AiAgentRole[]) {
      const repo = {
        findById: jest.fn(),
        insert: jest.fn(),
        update: jest.fn(),
        softDelete: jest.fn(),
        listByWorkspace: jest.fn().mockResolvedValue(rows),
      };
      const service = new AiAgentRolesService(repo as never);
      return { service, repo };
    }

    const row = makeRow({
      id: 'r1',
      name: 'Researcher',
      emoji: '🔬',
      description: 'finds things',
      instructions: 'SECRET admin-authored persona',
      modelConfig: { driver: 'gemini', chatModel: 'gemini-2.0-flash' } as never,
      enabled: true,
    });

    it('non-admin (isAdmin=false) gets the picker view WITHOUT instructions/modelConfig', async () => {
      const { service } = makeListService([row]);
      const list = await service.list('ws-1', false);
      expect(list).toHaveLength(1);
      const item = list[0] as unknown as Record<string, unknown>;
      // The picker fields ARE present — INCLUDING the auto-start fields, which
      // the client needs to decide whether/what to auto-send on role pick.
      expect(item).toEqual({
        id: 'r1',
        name: 'Researcher',
        emoji: '🔬',
        description: 'finds things',
        enabled: true,
        autoStart: true,
        launchMessage: null,
      });
      // ...and the admin-only fields are absent (not just undefined).
      expect('instructions' in item).toBe(false);
      expect('modelConfig' in item).toBe(false);
      expect('createdAt' in item).toBe(false);
      expect('updatedAt' in item).toBe(false);
      // autoStart/launchMessage are deliberately NOT admin-only — present here.
      expect('autoStart' in item).toBe(true);
      expect('launchMessage' in item).toBe(true);
    });

    it('admin (isAdmin=true) gets the full view WITH instructions/modelConfig', async () => {
      const { service } = makeListService([row]);
      const list = await service.list('ws-1', true);
      expect(list).toHaveLength(1);
      const item = list[0] as unknown as Record<string, unknown>;
      expect(item.instructions).toBe('SECRET admin-authored persona');
      expect(item.modelConfig).toEqual({
        driver: 'gemini',
        chatModel: 'gemini-2.0-flash',
      });
    });
  });

  describe('update conflict', () => {
    it('duplicate name (Postgres 23505) => ConflictException (409)', async () => {
      const { service, repo } = makeService({ existing: makeRow() });
      repo.update.mockRejectedValueOnce({ code: '23505' });
      await expect(
        service.update('ws-1', 'r1', {
          name: 'Taken',
        } as UpdateAgentRoleDto),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
