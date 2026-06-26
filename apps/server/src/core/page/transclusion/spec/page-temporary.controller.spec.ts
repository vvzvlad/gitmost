import { Test } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { PageTemplateController } from '../page-template.controller';
import { TransclusionService } from '../transclusion.service';
import { ToggleTemporaryDto } from '../dto/toggle-temporary.dto';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageAccessService } from '../../page-access/page-access.service';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { UserThrottlerGuard } from '../../../../integrations/throttle/user-throttler.guard';
import { DEFAULT_TEMPORARY_NOTE_HOURS } from '../../constants/temporary-note.constants';

/**
 * Minimal chainable Kysely stub: every builder method returns `this`, and the
 * terminal `executeTakeFirst` resolves the configured workspace row.
 */
function makeDbStub(workspaceRow: { temporaryNoteHours: number | null } | undefined) {
  const builder: any = {
    selectFrom: () => builder,
    select: () => builder,
    where: () => builder,
    executeTakeFirst: jest.fn().mockResolvedValue(workspaceRow),
  };
  return builder;
}

describe('PageTemplateController.toggleTemporary', () => {
  let controller: PageTemplateController;
  let pageRepo: { findById: jest.Mock; updatePage: jest.Mock };
  let pageAccessService: { validateCanEdit: jest.Mock };

  const user = { id: 'u1', workspaceId: 'w1' } as any;

  async function buildController(
    page: any,
    workspaceRow: { temporaryNoteHours: number | null } | undefined = {
      temporaryNoteHours: null,
    },
  ) {
    pageRepo = {
      findById: jest.fn().mockResolvedValue(page),
      updatePage: jest.fn().mockResolvedValue(undefined),
    };
    pageAccessService = {
      validateCanEdit: jest.fn().mockResolvedValue(undefined),
    };

    const module = await Test.createTestingModule({
      controllers: [PageTemplateController],
      providers: [
        { provide: TransclusionService, useValue: { lookupTemplate: jest.fn() } },
        { provide: PageRepo, useValue: pageRepo },
        { provide: PageAccessService, useValue: pageAccessService },
        {
          provide: KYSELY_MODULE_CONNECTION_TOKEN(),
          useValue: makeDbStub(workspaceRow),
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(UserThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(PageTemplateController);
  }

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-26T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('throws NotFound and does not touch the page when missing', async () => {
    await buildController(null);
    await expect(
      controller.toggleTemporary({ pageId: 'p1' } as any, user),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(pageAccessService.validateCanEdit).not.toHaveBeenCalled();
    expect(pageRepo.updatePage).not.toHaveBeenCalled();
  });

  it('throws NotFound (not Forbidden) for a cross-workspace page', async () => {
    await buildController({
      id: 'p1',
      workspaceId: 'OTHER',
      deletedAt: null,
      temporaryExpiresAt: null,
    });
    await expect(
      controller.toggleTemporary({ pageId: 'p1' } as any, user),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(pageRepo.updatePage).not.toHaveBeenCalled();
  });

  it('enforces CASL edit: when validateCanEdit throws, the timer is NOT changed', async () => {
    await buildController({
      id: 'p1',
      workspaceId: 'w1',
      deletedAt: null,
      temporaryExpiresAt: null,
    });
    pageAccessService.validateCanEdit.mockRejectedValue(new ForbiddenException());
    await expect(
      controller.toggleTemporary({ pageId: 'p1' } as any, user),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(pageRepo.updatePage).not.toHaveBeenCalled();
  });

  it('arms the timer (toggle) using the default hours when the page is permanent', async () => {
    await buildController({
      id: 'p1',
      workspaceId: 'w1',
      deletedAt: null,
      temporaryExpiresAt: null,
    });
    const out = await controller.toggleTemporary({ pageId: 'p1' } as any, user);

    const expected = new Date(
      Date.now() + DEFAULT_TEMPORARY_NOTE_HOURS * 60 * 60 * 1000,
    );
    expect(pageAccessService.validateCanEdit).toHaveBeenCalled();
    expect(pageRepo.updatePage).toHaveBeenCalledWith(
      { temporaryExpiresAt: expected },
      'p1',
    );
    expect(out).toEqual({ pageId: 'p1', temporaryExpiresAt: expected });
  });

  it('uses the workspace temporaryNoteHours override when set', async () => {
    await buildController(
      {
        id: 'p1',
        workspaceId: 'w1',
        deletedAt: null,
        temporaryExpiresAt: null,
      },
      { temporaryNoteHours: 3 },
    );
    const out = await controller.toggleTemporary({ pageId: 'p1' } as any, user);
    const expected = new Date(Date.now() + 3 * 60 * 60 * 1000);
    expect(pageRepo.updatePage).toHaveBeenCalledWith(
      { temporaryExpiresAt: expected },
      'p1',
    );
    expect(out.temporaryExpiresAt).toEqual(expected);
  });

  it('clears the timer (make permanent) when toggling an armed note', async () => {
    await buildController({
      id: 'p1',
      workspaceId: 'w1',
      deletedAt: null,
      temporaryExpiresAt: new Date('2026-06-27T00:00:00.000Z'),
    });
    const out = await controller.toggleTemporary({ pageId: 'p1' } as any, user);
    expect(pageRepo.updatePage).toHaveBeenCalledWith(
      { temporaryExpiresAt: null },
      'p1',
    );
    expect(out).toEqual({ pageId: 'p1', temporaryExpiresAt: null });
  });

  it('respects an explicit temporary:false instead of toggling', async () => {
    await buildController({
      id: 'p1',
      workspaceId: 'w1',
      deletedAt: null,
      temporaryExpiresAt: null, // already permanent, but explicit false
    });
    const out = await controller.toggleTemporary(
      { pageId: 'p1', temporary: false } as any,
      user,
    );
    expect(pageRepo.updatePage).toHaveBeenCalledWith(
      { temporaryExpiresAt: null },
      'p1',
    );
    expect(out.temporaryExpiresAt).toBeNull();
  });
});

describe('ToggleTemporaryDto validation (class-validator)', () => {
  const uuid = '00000000-0000-4000-8000-000000000001';

  it('accepts a valid UUID with no flag (toggle)', async () => {
    const dto = plainToInstance(ToggleTemporaryDto, { pageId: uuid });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('accepts an explicit boolean temporary', async () => {
    const dto = plainToInstance(ToggleTemporaryDto, {
      pageId: uuid,
      temporary: true,
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects a non-UUID pageId', async () => {
    const dto = plainToInstance(ToggleTemporaryDto, { pageId: 'nope' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('isUuid');
  });

  it('rejects a non-boolean temporary', async () => {
    const dto = plainToInstance(ToggleTemporaryDto, {
      pageId: uuid,
      temporary: 'yes',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('isBoolean');
  });
});
