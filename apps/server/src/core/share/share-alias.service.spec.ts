import { BadRequestException, ConflictException } from '@nestjs/common';
import { ShareAliasService } from './share-alias.service';

/**
 * Behaviour tests for the alias write/resolve semantics: create vs no-op vs the
 * 409 reassign guard, uniqueness-race handling, availability probe, and the
 * request-time readable-target resolution (which re-runs the share boundary).
 */
describe('ShareAliasService', () => {
  // Sentinel handed to repo calls so tests can assert they ran inside the tx.
  const trx = { __trx: true };

  function makeService() {
    const shareAliasRepo = {
      findByAliasAndWorkspace: jest.fn(),
      findByPageId: jest.fn(),
      findById: jest.fn(),
      insert: jest.fn(),
      updateAlias: jest.fn(),
      updatePageId: jest.fn(),
      deleteOthersForPage: jest.fn(),
      delete: jest.fn(),
    };
    const pageRepo = { findById: jest.fn() };
    const shareService = {
      resolveReadableSharePage: jest.fn(),
      isSharingAllowed: jest.fn(),
    };
    // Fake kysely db: only .transaction().execute(cb) is used by setAlias.
    const db = {
      transaction: jest.fn(() => ({
        execute: jest.fn(async (cb: any) => cb(trx)),
      })),
    };
    const service = new ShareAliasService(
      shareAliasRepo as any,
      pageRepo as any,
      shareService as any,
      db as any,
    );
    return { service, shareAliasRepo, pageRepo, shareService, db };
  }

  describe('setAlias', () => {
    it('rejects an invalid alias before touching the db', async () => {
      const { service, shareAliasRepo } = makeService();
      await expect(
        service.setAlias({
          workspaceId: 'ws-1',
          pageId: 'p-1',
          creatorId: 'u-1',
          alias: 'A', // too short + uppercase
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(shareAliasRepo.findByAliasAndWorkspace).not.toHaveBeenCalled();
    });

    it('normalizes then inserts a brand-new alias (page has none yet)', async () => {
      const { service, shareAliasRepo } = makeService();
      shareAliasRepo.findByAliasAndWorkspace.mockResolvedValue(undefined);
      shareAliasRepo.findByPageId.mockResolvedValue(undefined);
      shareAliasRepo.insert.mockResolvedValue({ id: 'a-1', alias: 'my-page' });

      const res = await service.setAlias({
        workspaceId: 'ws-1',
        pageId: 'p-1',
        creatorId: 'u-1',
        alias: '  My Page ',
      });

      expect(shareAliasRepo.findByAliasAndWorkspace).toHaveBeenCalledWith(
        'my-page',
        'ws-1',
        trx,
      );
      expect(shareAliasRepo.insert).toHaveBeenCalledWith(
        {
          workspaceId: 'ws-1',
          alias: 'my-page',
          pageId: 'p-1',
          creatorId: 'u-1',
        },
        trx,
      );
      expect(shareAliasRepo.updateAlias).not.toHaveBeenCalled();
      // self-heal still runs, keeping just the inserted row
      expect(shareAliasRepo.deleteOthersForPage).toHaveBeenCalledWith(
        'p-1',
        'a-1',
        'ws-1',
        trx,
      );
      expect(res).toMatchObject({ id: 'a-1' });
    });

    it('renames the existing row in place when editing to a free name (te -> ted)', async () => {
      const { service, shareAliasRepo } = makeService();
      // The new slug is free...
      shareAliasRepo.findByAliasAndWorkspace.mockResolvedValue(undefined);
      // ...but the page already owns an alias named `te`.
      shareAliasRepo.findByPageId.mockResolvedValue({
        id: 'a-1',
        alias: 'te',
        pageId: 'p-1',
      });
      shareAliasRepo.updateAlias.mockResolvedValue({
        id: 'a-1',
        alias: 'ted',
        pageId: 'p-1',
      });

      const res = await service.setAlias({
        workspaceId: 'ws-1',
        pageId: 'p-1',
        creatorId: 'u-1',
        alias: 'ted',
      });

      // RENAME, not INSERT a second row.
      expect(shareAliasRepo.insert).not.toHaveBeenCalled();
      expect(shareAliasRepo.updateAlias).toHaveBeenCalledWith(
        'a-1',
        'ted',
        'ws-1',
        trx,
      );
      // ...and any other row for the page is reaped, so `te` cannot survive.
      expect(shareAliasRepo.deleteOthersForPage).toHaveBeenCalledWith(
        'p-1',
        'a-1',
        'ws-1',
        trx,
      );
      expect(res).toMatchObject({ id: 'a-1', alias: 'ted' });
    });

    it('is a no-op when the alias already points at the same page (and self-heals)', async () => {
      const { service, shareAliasRepo } = makeService();
      const existing = { id: 'a-1', alias: 'foo', pageId: 'p-1' };
      shareAliasRepo.findByAliasAndWorkspace.mockResolvedValue(existing);

      const res = await service.setAlias({
        workspaceId: 'ws-1',
        pageId: 'p-1',
        creatorId: 'u-1',
        alias: 'foo',
      });

      expect(res).toBe(existing);
      expect(shareAliasRepo.insert).not.toHaveBeenCalled();
      expect(shareAliasRepo.updateAlias).not.toHaveBeenCalled();
      expect(shareAliasRepo.updatePageId).not.toHaveBeenCalled();
      // self-heal reaps any legacy duplicate rows for the page
      expect(shareAliasRepo.deleteOthersForPage).toHaveBeenCalledWith(
        'p-1',
        'a-1',
        'ws-1',
        trx,
      );
    });

    it('self-heals a page with pre-existing duplicate rows down to one', async () => {
      const { service, shareAliasRepo } = makeService();
      // Name free; the page already has a (legacy) alias row we rename.
      shareAliasRepo.findByAliasAndWorkspace.mockResolvedValue(undefined);
      shareAliasRepo.findByPageId.mockResolvedValue({
        id: 'a-keep',
        alias: 'old',
        pageId: 'p-1',
      });
      shareAliasRepo.updateAlias.mockResolvedValue({
        id: 'a-keep',
        alias: 'new',
        pageId: 'p-1',
      });

      await service.setAlias({
        workspaceId: 'ws-1',
        pageId: 'p-1',
        creatorId: 'u-1',
        alias: 'new',
      });

      expect(shareAliasRepo.deleteOthersForPage).toHaveBeenCalledWith(
        'p-1',
        'a-keep',
        'ws-1',
        trx,
      );
    });

    it('throws 409 with current target when name is taken and not confirmed', async () => {
      const { service, shareAliasRepo, pageRepo } = makeService();
      shareAliasRepo.findByAliasAndWorkspace.mockResolvedValue({
        id: 'a-1',
        alias: 'foo',
        pageId: 'p-other',
      });
      pageRepo.findById.mockResolvedValue({ id: 'p-other', title: 'Other' });

      try {
        await service.setAlias({
          workspaceId: 'ws-1',
          pageId: 'p-1',
          creatorId: 'u-1',
          alias: 'foo',
        });
        fail('expected ConflictException');
      } catch (err) {
        expect(err).toBeInstanceOf(ConflictException);
        expect((err as ConflictException).getResponse()).toMatchObject({
          code: 'ALIAS_REASSIGN_REQUIRED',
          currentPageId: 'p-other',
          currentPageTitle: 'Other',
        });
      }
      expect(shareAliasRepo.updatePageId).not.toHaveBeenCalled();
    });

    it('retargets (UPDATE page_id) when confirmReassign is set', async () => {
      const { service, shareAliasRepo } = makeService();
      shareAliasRepo.findByAliasAndWorkspace.mockResolvedValue({
        id: 'a-1',
        alias: 'foo',
        pageId: 'p-other',
      });
      shareAliasRepo.updatePageId.mockResolvedValue({ id: 'a-1', pageId: 'p-1' });

      const res = await service.setAlias({
        workspaceId: 'ws-1',
        pageId: 'p-1',
        creatorId: 'u-1',
        alias: 'foo',
        confirmReassign: true,
      });

      expect(shareAliasRepo.updatePageId).toHaveBeenCalledWith(
        'a-1',
        'p-1',
        'ws-1',
        trx,
      );
      // ORDER MATTERS: the target page's existing alias row(s) are reaped BEFORE
      // the retarget, so the non-deferrable (workspace_id, page_id) index never
      // sees two rows for the page mid-statement. There is no trailing self-heal.
      expect(shareAliasRepo.deleteOthersForPage).toHaveBeenCalledWith(
        'p-1',
        'a-1',
        'ws-1',
        trx,
      );
      expect(shareAliasRepo.deleteOthersForPage).toHaveBeenCalledTimes(1);
      const deleteOrder =
        shareAliasRepo.deleteOthersForPage.mock.invocationCallOrder[0];
      const updateOrder =
        shareAliasRepo.updatePageId.mock.invocationCallOrder[0];
      expect(deleteOrder).toBeLessThan(updateOrder);
      expect(res).toMatchObject({ pageId: 'p-1' });
    });

    it('maps a unique-violation race (no constraint info) to 409 "Alias already taken"', async () => {
      const { service, shareAliasRepo } = makeService();
      shareAliasRepo.findByAliasAndWorkspace.mockResolvedValue(undefined);
      shareAliasRepo.insert.mockRejectedValue({ code: '23505' });

      try {
        await service.setAlias({
          workspaceId: 'ws-1',
          pageId: 'p-1',
          creatorId: 'u-1',
          alias: 'foo',
        });
        fail('expected ConflictException');
      } catch (err) {
        expect(err).toBeInstanceOf(ConflictException);
        expect((err as ConflictException).getResponse()).toMatchObject({
          message: 'Alias already taken',
        });
      }
    });

    it('maps the (workspace_id, alias) index violation to "Alias already taken"', async () => {
      const { service, shareAliasRepo } = makeService();
      shareAliasRepo.findByAliasAndWorkspace.mockResolvedValue(undefined);
      // postgres@3.x driver exposes the index name as `constraint_name`.
      shareAliasRepo.insert.mockRejectedValue({
        code: '23505',
        constraint_name: 'share_aliases_workspace_id_alias_unique',
      });

      try {
        await service.setAlias({
          workspaceId: 'ws-1',
          pageId: 'p-1',
          creatorId: 'u-1',
          alias: 'foo',
        });
        fail('expected ConflictException');
      } catch (err) {
        expect((err as ConflictException).getResponse()).toMatchObject({
          message: 'Alias already taken',
        });
      }
    });

    it('maps the (workspace_id, page_id) index violation to a DISTINCT page-race outcome', async () => {
      const { service, shareAliasRepo } = makeService();
      shareAliasRepo.findByAliasAndWorkspace.mockResolvedValue(undefined);
      shareAliasRepo.insert.mockRejectedValue({
        code: '23505',
        constraint_name: 'share_aliases_workspace_id_page_id_unique',
      });

      try {
        await service.setAlias({
          workspaceId: 'ws-1',
          pageId: 'p-1',
          creatorId: 'u-1',
          alias: 'foo',
        });
        fail('expected ConflictException');
      } catch (err) {
        expect(err).toBeInstanceOf(ConflictException);
        // NOT the misleading "Alias already taken" — a separate, page-scoped code.
        expect((err as ConflictException).getResponse()).toMatchObject({
          code: 'ALIAS_PAGE_RACE',
        });
        expect((err as ConflictException).getResponse()).not.toMatchObject({
          message: 'Alias already taken',
        });
      }
    });

    it('reads the index name from `.constraint` when `.constraint_name` is absent', async () => {
      const { service, shareAliasRepo } = makeService();
      shareAliasRepo.findByAliasAndWorkspace.mockResolvedValue(undefined);
      // Fallback path for non-postgres@3.x drivers.
      shareAliasRepo.insert.mockRejectedValue({
        code: '23505',
        constraint: 'share_aliases_workspace_id_page_id_unique',
      });

      try {
        await service.setAlias({
          workspaceId: 'ws-1',
          pageId: 'p-1',
          creatorId: 'u-1',
          alias: 'foo',
        });
        fail('expected ConflictException');
      } catch (err) {
        expect((err as ConflictException).getResponse()).toMatchObject({
          code: 'ALIAS_PAGE_RACE',
        });
      }
    });

    it('maps a non-unique-violation db error to BadRequest (Failed to set alias)', async () => {
      const { service, shareAliasRepo } = makeService();
      shareAliasRepo.findByAliasAndWorkspace.mockResolvedValue(undefined);
      shareAliasRepo.insert.mockRejectedValue({ code: '08006' }); // connection error

      await expect(
        service.setAlias({
          workspaceId: 'ws-1',
          pageId: 'p-1',
          creatorId: 'u-1',
          alias: 'foo',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('checkAvailability', () => {
    it('reports invalid for a bad slug without a db hit', async () => {
      const { service, shareAliasRepo } = makeService();
      const res = await service.checkAvailability('Bad Slug!', 'ws-1');
      expect(res).toMatchObject({ valid: false, available: false });
      expect(shareAliasRepo.findByAliasAndWorkspace).not.toHaveBeenCalled();
    });

    it('reports available when no row exists', async () => {
      const { service, shareAliasRepo } = makeService();
      shareAliasRepo.findByAliasAndWorkspace.mockResolvedValue(undefined);
      const res = await service.checkAvailability('free-name', 'ws-1');
      expect(res).toMatchObject({
        alias: 'free-name',
        valid: true,
        available: true,
        currentPageId: null,
      });
    });

    it('reports taken with the current target page', async () => {
      const { service, shareAliasRepo } = makeService();
      shareAliasRepo.findByAliasAndWorkspace.mockResolvedValue({
        id: 'a-1',
        pageId: 'p-9',
      });
      const res = await service.checkAvailability('taken', 'ws-1');
      expect(res).toMatchObject({ available: false, currentPageId: 'p-9' });
    });
  });

  describe('resolveReadableTarget', () => {
    it('returns null for an invalid alias', async () => {
      const { service } = makeService();
      expect(await service.resolveReadableTarget('!!', 'ws-1')).toBeNull();
    });

    it('returns null for an unknown or dangling alias', async () => {
      const { service, shareAliasRepo } = makeService();
      shareAliasRepo.findByAliasAndWorkspace.mockResolvedValueOnce(undefined);
      expect(await service.resolveReadableTarget('foo', 'ws-1')).toBeNull();

      shareAliasRepo.findByAliasAndWorkspace.mockResolvedValueOnce({
        id: 'a-1',
        pageId: null,
      });
      expect(await service.resolveReadableTarget('foo', 'ws-1')).toBeNull();
    });

    it('returns null when the page is no longer publicly readable', async () => {
      const { service, shareAliasRepo, shareService } = makeService();
      shareAliasRepo.findByAliasAndWorkspace.mockResolvedValue({
        id: 'a-1',
        pageId: 'p-1',
      });
      shareService.resolveReadableSharePage.mockResolvedValue(null);
      expect(await service.resolveReadableTarget('foo', 'ws-1')).toBeNull();
    });

    it('returns null when sharing is disabled for the space', async () => {
      const { service, shareAliasRepo, shareService } = makeService();
      shareAliasRepo.findByAliasAndWorkspace.mockResolvedValue({
        id: 'a-1',
        pageId: 'p-1',
      });
      shareService.resolveReadableSharePage.mockResolvedValue({
        share: { key: 'k', spaceId: 's-1' },
        page: { slugId: 'sid', title: 'T' },
      });
      shareService.isSharingAllowed.mockResolvedValue(false);
      expect(await service.resolveReadableTarget('foo', 'ws-1')).toBeNull();
    });

    it('returns the resolved share+page on success', async () => {
      const { service, shareAliasRepo, shareService } = makeService();
      shareAliasRepo.findByAliasAndWorkspace.mockResolvedValue({
        id: 'a-1',
        pageId: 'p-1',
      });
      const resolved = {
        share: { key: 'k', spaceId: 's-1' },
        page: { slugId: 'sid', title: 'T' },
      };
      shareService.resolveReadableSharePage.mockResolvedValue(resolved);
      shareService.isSharingAllowed.mockResolvedValue(true);

      const res = await service.resolveReadableTarget('FOO', 'ws-1');
      expect(res).toBe(resolved);
      // alias was normalized to lowercase before lookup
      expect(shareAliasRepo.findByAliasAndWorkspace).toHaveBeenCalledWith(
        'foo',
        'ws-1',
      );
    });
  });
});
