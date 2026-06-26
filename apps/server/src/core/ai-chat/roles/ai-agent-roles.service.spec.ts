import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
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
      source: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    } as AiAgentRole;
  }

  // A stubbed catalog provider; the CRUD tests never reach it (they exercise
  // create/update/remove/list only), so the methods just reject if hit.
  function makeCatalog() {
    return {
      fetchIndex: jest.fn(),
      fetchBundle: jest.fn(),
    };
  }

  function makeService(opts: { existing?: AiAgentRole | undefined } = {}) {
    const repo = {
      findById: jest.fn().mockResolvedValue(opts.existing),
      insert: jest.fn().mockImplementation((v) => Promise.resolve(makeRow(v))),
      update: jest.fn().mockResolvedValue(undefined),
      softDelete: jest.fn().mockResolvedValue(undefined),
      listByWorkspace: jest.fn().mockResolvedValue([]),
    };
    const catalog = makeCatalog();
    const service = new AiAgentRolesService(repo as never, catalog as never);
    return { service, repo, catalog };
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
        source: null,
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
      const service = new AiAgentRolesService(repo as never, makeCatalog() as never);
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

  // ---------------------------------------------------------------------------
  // Catalog: import (skip / rename / already-installed) and update reconciliation
  // against a MOCKED catalog provider + mocked repo (mirrors the CRUD style).
  // ---------------------------------------------------------------------------
  describe('importFromCatalog', () => {
    function catalogRole(over: Record<string, unknown> = {}) {
      return {
        slug: 'researcher',
        name: 'Researcher',
        instructions: 'be a researcher',
        ...over,
      };
    }

    function makeImportService(opts: {
      indexRoles?: { slug: string; version: number }[];
      bundleRoles?: Record<string, unknown>[];
      existing?: AiAgentRole[];
    }) {
      const index = {
        schemaVersion: 1,
        bundles: [
          {
            id: 'general',
            name: { en: 'General' },
            languages: ['en'],
            roles: opts.indexRoles ?? [{ slug: 'researcher', version: 3 }],
          },
        ],
      };
      const bundle = {
        schemaVersion: 1,
        language: 'en',
        roles: opts.bundleRoles ?? [catalogRole()],
      };
      const repo = {
        findById: jest.fn(),
        insert: jest.fn().mockImplementation((v) => Promise.resolve(makeRow(v))),
        update: jest.fn().mockResolvedValue(undefined),
        softDelete: jest.fn(),
        listByWorkspace: jest.fn().mockResolvedValue(opts.existing ?? []),
      };
      const catalog = {
        fetchIndex: jest.fn().mockResolvedValue(index),
        fetchBundle: jest.fn().mockResolvedValue(bundle),
      };
      const service = new AiAgentRolesService(repo as never, catalog as never);
      return { service, repo, catalog };
    }

    const dto = (over: Record<string, unknown> = {}) =>
      ({
        bundleId: 'general',
        language: 'en',
        conflict: 'skip',
        ...over,
      }) as never;

    it('inserts a new role with source { slug, language, version } from the index', async () => {
      const { service, repo } = makeImportService({});
      const res = await service.importFromCatalog('ws-1', 'u1', dto());
      expect(res).toMatchObject({ created: 1, skipped: 0, renamed: 0 });
      expect(res.errors).toEqual([]);
      const values = repo.insert.mock.calls[0][0];
      expect(values.source).toEqual({
        slug: 'researcher',
        language: 'en',
        version: 3,
      });
      expect(values.enabled).toBe(true);
    });

    it('already-installed catalog slug => skipped (no insert)', async () => {
      const existing = [
        makeRow({
          id: 'r-existing',
          name: 'Old researcher',
          source: { slug: 'researcher', language: 'en', version: 1 } as never,
        }),
      ];
      const { service, repo } = makeImportService({ existing });
      const res = await service.importFromCatalog('ws-1', 'u1', dto());
      expect(res).toMatchObject({ created: 0, skipped: 1, renamed: 0 });
      expect(repo.insert).not.toHaveBeenCalled();
    });

    it('same slug installed in a DIFFERENT language => NOT skipped (separate install)', async () => {
      // Installed as `ru`; importing the `en` variant of the same slug must
      // still import (dedup key is slug+language, matching the client UI).
      const existing = [
        makeRow({
          id: 'r-ru',
          name: 'Исследователь',
          source: { slug: 'researcher', language: 'ru', version: 1 } as never,
        }),
      ];
      const { service, repo } = makeImportService({ existing });
      const res = await service.importFromCatalog('ws-1', 'u1', dto());
      expect(res).toMatchObject({ created: 1, skipped: 0, renamed: 0 });
      expect(repo.insert).toHaveBeenCalledTimes(1);
      expect(repo.insert.mock.calls[0][0].source).toEqual({
        slug: 'researcher',
        language: 'en',
        version: 3,
      });
    });

    it('name collision + conflict:skip => skipped (no insert)', async () => {
      const existing = [makeRow({ id: 'r-x', name: 'Researcher' })];
      const { service, repo } = makeImportService({ existing });
      const res = await service.importFromCatalog(
        'ws-1',
        'u1',
        dto({ conflict: 'skip' }),
      );
      expect(res).toMatchObject({ created: 0, skipped: 1, renamed: 0 });
      expect(repo.insert).not.toHaveBeenCalled();
    });

    it('name collision + conflict:rename => inserts under " (2)"', async () => {
      const existing = [makeRow({ id: 'r-x', name: 'Researcher' })];
      const { service, repo } = makeImportService({ existing });
      const res = await service.importFromCatalog(
        'ws-1',
        'u1',
        dto({ conflict: 'rename' }),
      );
      expect(res).toMatchObject({ created: 1, skipped: 0, renamed: 1 });
      expect(repo.insert.mock.calls[0][0].name).toBe('Researcher (2)');
    });

    it('dto.slugs filters; an unknown slug becomes an error entry', async () => {
      const { service, repo } = makeImportService({
        bundleRoles: [catalogRole()],
      });
      const res = await service.importFromCatalog(
        'ws-1',
        'u1',
        dto({ slugs: ['researcher', 'ghost'] }),
      );
      expect(res.created).toBe(1);
      expect(res.errors).toEqual([
        { slug: 'ghost', message: 'Role not found in catalog bundle' },
      ]);
      expect(repo.insert).toHaveBeenCalledTimes(1);
    });

    it('insert unique-violation (23505) is recorded as an error, import continues', async () => {
      const { service, repo } = makeImportService({
        bundleRoles: [
          catalogRole({ slug: 'a', name: 'A' }),
          catalogRole({ slug: 'b', name: 'B' }),
        ],
        indexRoles: [
          { slug: 'a', version: 1 },
          { slug: 'b', version: 1 },
        ],
      });
      repo.insert
        .mockRejectedValueOnce({ code: '23505' })
        .mockImplementationOnce((v) => Promise.resolve(makeRow(v)));
      const res = await service.importFromCatalog('ws-1', 'u1', dto());
      expect(res.created).toBe(1);
      expect(res.errors).toEqual([
        { slug: 'a', message: 'A role with this name already exists' },
      ]);
    });

    it('non-unique insert error => generic message, root cause logged, import continues', async () => {
      const logSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      try {
        const { service, repo } = makeImportService({
          bundleRoles: [
            catalogRole({ slug: 'a', name: 'A' }),
            catalogRole({ slug: 'b', name: 'B' }),
          ],
          indexRoles: [
            { slug: 'a', version: 1 },
            { slug: 'b', version: 1 },
          ],
        });
        // A non-23505 failure (e.g. a not-null violation) on the first insert.
        const boom = Object.assign(new Error('null value in column'), {
          code: '23502',
        });
        repo.insert
          .mockRejectedValueOnce(boom)
          .mockImplementationOnce((v) => Promise.resolve(makeRow(v)));
        const res = await service.importFromCatalog('ws-1', 'u1', dto());
        // The generic (non-409) user-facing message; the second role still imports.
        expect(res.created).toBe(1);
        expect(res.errors).toEqual([
          { slug: 'a', message: 'Failed to import role' },
        ]);
        // The root cause was logged with the slug for diagnosis.
        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(String(logSpy.mock.calls[0][0])).toContain('slug=a');
      } finally {
        logSpy.mockRestore();
      }
    });
  });

  describe('updateFromCatalog', () => {
    function makeUpdateService(opts: {
      role?: AiAgentRole;
      indexBundles?: unknown[];
      bundleRoles?: Record<string, unknown>[];
      others?: AiAgentRole[];
    }) {
      const index = {
        schemaVersion: 1,
        bundles: opts.indexBundles ?? [
          {
            id: 'general',
            name: { en: 'General' },
            languages: ['en'],
            roles: [{ slug: 'researcher', version: 5 }],
          },
        ],
      };
      const bundle = {
        schemaVersion: 1,
        language: 'en',
        roles: opts.bundleRoles ?? [
          { slug: 'researcher', name: 'Researcher v5', instructions: 'new' },
        ],
      };
      const repo = {
        findById: jest.fn().mockResolvedValue(opts.role),
        insert: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined),
        softDelete: jest.fn(),
        listByWorkspace: jest.fn().mockResolvedValue(opts.others ?? []),
      };
      const catalog = {
        fetchIndex: jest.fn().mockResolvedValue(index),
        fetchBundle: jest.fn().mockResolvedValue(bundle),
      };
      const service = new AiAgentRolesService(repo as never, catalog as never);
      return { service, repo, catalog };
    }

    const imported = (version: number, over: Partial<AiAgentRole> = {}) =>
      makeRow({
        id: 'r1',
        name: 'Researcher',
        source: { slug: 'researcher', language: 'en', version } as never,
        ...over,
      });

    it('role not imported from catalog (source null) => BadRequest', async () => {
      const { service } = makeUpdateService({ role: makeRow({ source: null }) });
      await expect(
        service.updateFromCatalog('ws-1', { id: 'r1' } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('role not found => BadRequest', async () => {
      const { service } = makeUpdateService({ role: undefined });
      await expect(
        service.updateFromCatalog('ws-1', { id: 'r1' } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('catalog version <= source.version => up-to-date (no update)', async () => {
      const { service, repo } = makeUpdateService({ role: imported(5) });
      const res = await service.updateFromCatalog('ws-1', { id: 'r1' } as never);
      expect(res).toEqual({ updated: false, reason: 'up-to-date' });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('slug no longer listed in any bundle => not-in-catalog', async () => {
      const { service, repo } = makeUpdateService({
        role: imported(1),
        indexBundles: [
          {
            id: 'general',
            name: { en: 'General' },
            languages: ['en'],
            roles: [{ slug: 'other', version: 9 }],
          },
        ],
      });
      const res = await service.updateFromCatalog('ws-1', { id: 'r1' } as never);
      expect(res).toEqual({ updated: false, reason: 'not-in-catalog' });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('source.language no longer offered by the bundle => language-unavailable', async () => {
      const { service, repo } = makeUpdateService({
        role: imported(1, {
          source: { slug: 'researcher', language: 'ru', version: 1 } as never,
        }),
        indexBundles: [
          {
            id: 'general',
            name: { en: 'General' },
            languages: ['en'],
            roles: [{ slug: 'researcher', version: 5 }],
          },
        ],
      });
      const res = await service.updateFromCatalog('ws-1', { id: 'r1' } as never);
      expect(res).toEqual({ updated: false, reason: 'language-unavailable' });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('newer version => updates content + bumps source.version, returns versions', async () => {
      const role = imported(1);
      const { service, repo } = makeUpdateService({ role });
      // The post-update re-fetch returns the bumped row.
      repo.findById
        .mockResolvedValueOnce(role)
        .mockResolvedValueOnce(
          imported(5, { name: 'Researcher v5', instructions: 'new' }),
        );
      const res = await service.updateFromCatalog('ws-1', { id: 'r1' } as never);
      expect(res).toMatchObject({
        updated: true,
        fromVersion: 1,
        toVersion: 5,
      });
      const patch = repo.update.mock.calls[0][2];
      expect(patch.source).toEqual({
        slug: 'researcher',
        language: 'en',
        version: 5,
      });
      expect(patch.name).toBe('Researcher v5');
      // enabled is never touched by an update-from-catalog.
      expect('enabled' in patch).toBe(false);
    });

    it('new catalog name collides with another live role => keeps current name', async () => {
      const role = imported(1);
      const other = makeRow({ id: 'r2', name: 'Researcher v5' });
      const { service, repo } = makeUpdateService({ role, others: [role, other] });
      repo.findById
        .mockResolvedValueOnce(role)
        .mockResolvedValueOnce(imported(5));
      await service.updateFromCatalog('ws-1', { id: 'r1' } as never);
      // The colliding catalog name is dropped; the current name is kept.
      expect(repo.update.mock.calls[0][2].name).toBe('Researcher');
    });
  });

  // ---------------------------------------------------------------------------
  // Catalog browse (getCatalog / getCatalogBundle) against a MOCKED provider.
  // Covers the localized() three-tier fallback (requested lang -> en -> first ->
  // null), the sorted union of bundle languages, the missing-bundle BadGateway,
  // and the role-version default.
  // ---------------------------------------------------------------------------
  describe('getCatalog', () => {
    function makeBrowseService(index: unknown) {
      const repo = {
        findById: jest.fn(),
        insert: jest.fn(),
        update: jest.fn(),
        softDelete: jest.fn(),
        listByWorkspace: jest.fn(),
      };
      const catalog = {
        fetchIndex: jest.fn().mockResolvedValue(index),
        fetchBundle: jest.fn(),
      };
      const service = new AiAgentRolesService(repo as never, catalog as never);
      return { service, catalog };
    }

    it('returns the sorted union of every bundle language', async () => {
      const { service } = makeBrowseService({
        schemaVersion: 1,
        bundles: [
          {
            id: 'a',
            name: { en: 'A' },
            languages: ['ru', 'en'],
            roles: [],
          },
          {
            id: 'b',
            name: { en: 'B' },
            languages: ['en', 'de'],
            roles: [],
          },
        ],
      });
      const res = await service.getCatalog('en');
      expect(res.languages).toEqual(['de', 'en', 'ru']);
    });

    it('localized name uses the requested language when present', async () => {
      const { service } = makeBrowseService({
        schemaVersion: 1,
        bundles: [
          {
            id: 'a',
            name: { en: 'General', ru: 'Общие' },
            description: { en: 'desc-en', ru: 'desc-ru' },
            languages: ['en', 'ru'],
            roles: [{ slug: 'researcher', version: 2 }],
          },
        ],
      });
      const res = await service.getCatalog('ru');
      expect(res.bundles[0]).toMatchObject({
        id: 'a',
        name: 'Общие',
        description: 'desc-ru',
        languages: ['en', 'ru'],
        roles: [{ slug: 'researcher', version: 2 }],
      });
    });

    it('localized name falls back to en when the requested language is missing', async () => {
      const { service } = makeBrowseService({
        schemaVersion: 1,
        bundles: [
          {
            id: 'a',
            name: { en: 'General', ru: 'Общие' },
            languages: ['en', 'ru'],
            roles: [],
          },
        ],
      });
      const res = await service.getCatalog('fr');
      expect(res.bundles[0].name).toBe('General');
    });

    it('localized name falls back to the first available locale when en is absent', async () => {
      const { service } = makeBrowseService({
        schemaVersion: 1,
        bundles: [
          {
            id: 'a',
            name: { ru: 'Общие', de: 'Allgemein' },
            languages: ['ru', 'de'],
            roles: [],
          },
        ],
      });
      const res = await service.getCatalog('fr');
      // Neither 'fr' nor 'en' is present -> first available value.
      expect(res.bundles[0].name).toBe('Общие');
    });

    it('empty name map => falls back to the bundle id; absent description => null', async () => {
      const { service } = makeBrowseService({
        schemaVersion: 1,
        bundles: [
          {
            id: 'a',
            name: {},
            languages: ['en'],
            roles: [],
          },
        ],
      });
      const res = await service.getCatalog('en');
      expect(res.bundles[0].name).toBe('a');
      expect(res.bundles[0].description).toBeNull();
    });
  });

  describe('getCatalogBundle', () => {
    function makeBundleService(opts: {
      index: unknown;
      bundle: unknown;
    }) {
      const repo = {
        findById: jest.fn(),
        insert: jest.fn(),
        update: jest.fn(),
        softDelete: jest.fn(),
        listByWorkspace: jest.fn(),
      };
      const catalog = {
        fetchIndex: jest.fn().mockResolvedValue(opts.index),
        fetchBundle: jest.fn().mockResolvedValue(opts.bundle),
      };
      const service = new AiAgentRolesService(repo as never, catalog as never);
      return { service, catalog };
    }

    const index = {
      schemaVersion: 1,
      bundles: [
        {
          id: 'general',
          name: { en: 'General' },
          languages: ['en'],
          roles: [{ slug: 'researcher', version: 4 }],
        },
      ],
    };

    it('missing bundle in the index => BadGateway', async () => {
      const { service, catalog } = makeBundleService({
        index,
        bundle: { schemaVersion: 1, language: 'en', roles: [] },
      });
      await expect(
        service.getCatalogBundle('ghost', 'en'),
      ).rejects.toBeInstanceOf(BadGatewayException);
      expect(catalog.fetchBundle).not.toHaveBeenCalled();
    });

    it('maps role content with the version taken from the index', async () => {
      const { service } = makeBundleService({
        index,
        bundle: {
          schemaVersion: 1,
          language: 'en',
          roles: [
            {
              slug: 'researcher',
              name: 'Researcher',
              instructions: 'be a researcher',
              emoji: '🔬',
              autoStart: false,
              launchMessage: 'go',
            },
          ],
        },
      });
      const res = await service.getCatalogBundle('general', 'en');
      expect(res).toMatchObject({ bundleId: 'general', language: 'en' });
      expect(res.roles[0]).toEqual({
        slug: 'researcher',
        emoji: '🔬',
        name: 'Researcher',
        description: null,
        instructions: 'be a researcher',
        autoStart: false,
        launchMessage: 'go',
        version: 4,
      });
    });

    it('role absent from the index meta => version defaults to 1; autoStart defaults to true', async () => {
      const { service } = makeBundleService({
        index,
        bundle: {
          schemaVersion: 1,
          language: 'en',
          roles: [
            { slug: 'newcomer', name: 'Newcomer', instructions: 'hi' },
          ],
        },
      });
      const res = await service.getCatalogBundle('general', 'en');
      expect(res.roles[0]).toMatchObject({
        slug: 'newcomer',
        version: 1,
        autoStart: true,
        emoji: null,
        launchMessage: null,
      });
    });
  });
});
