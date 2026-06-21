import { Test } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PageTemplateController } from '../page-template.controller';
import { TransclusionService } from '../transclusion.service';
import { TemplateLookupDto } from '../dto/template-lookup.dto';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageAccessService } from '../../page-access/page-access.service';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { UserThrottlerGuard } from '../../../../integrations/throttle/user-throttler.guard';

describe('PageTemplateController.toggleTemplate', () => {
  let controller: PageTemplateController;
  let pageRepo: { findById: jest.Mock; updatePage: jest.Mock };
  let pageAccessService: { validateCanEdit: jest.Mock };
  let transclusionService: Partial<jest.Mocked<TransclusionService>>;

  const user = { id: 'u1', workspaceId: 'w1' } as any;
  const page = {
    id: 'p1',
    workspaceId: 'w1',
    deletedAt: null,
    isTemplate: false,
  } as any;

  beforeEach(async () => {
    pageRepo = {
      findById: jest.fn().mockResolvedValue(page),
      updatePage: jest.fn().mockResolvedValue(undefined),
    };
    pageAccessService = {
      validateCanEdit: jest.fn().mockResolvedValue(undefined),
    };
    transclusionService = { lookupTemplate: jest.fn() };

    const module = await Test.createTestingModule({
      controllers: [PageTemplateController],
      providers: [
        { provide: TransclusionService, useValue: transclusionService },
        { provide: PageRepo, useValue: pageRepo },
        { provide: PageAccessService, useValue: pageAccessService },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(UserThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(PageTemplateController);
  });

  it('throws NotFound and does not touch the page when the page is missing', async () => {
    pageRepo.findById.mockResolvedValue(null);
    await expect(
      controller.toggleTemplate({ pageId: 'p1' } as any, user),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(pageAccessService.validateCanEdit).not.toHaveBeenCalled();
    expect(pageRepo.updatePage).not.toHaveBeenCalled();
  });

  it('enforces CASL edit: when validateCanEdit throws, the flag is NOT flipped', async () => {
    pageAccessService.validateCanEdit.mockRejectedValue(
      new ForbiddenException(),
    );
    await expect(
      controller.toggleTemplate({ pageId: 'p1' } as any, user),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(pageAccessService.validateCanEdit).toHaveBeenCalledWith(page, user);
    expect(pageRepo.updatePage).not.toHaveBeenCalled();
  });

  it('flips is_template (toggle) when the user can edit', async () => {
    const out = await controller.toggleTemplate(
      { pageId: 'p1' } as any,
      user,
    );
    expect(pageAccessService.validateCanEdit).toHaveBeenCalledWith(page, user);
    // page.isTemplate was false → toggled to true
    expect(pageRepo.updatePage).toHaveBeenCalledWith({ isTemplate: true }, 'p1');
    expect(out).toEqual({ pageId: 'p1', isTemplate: true });
  });

  it('respects an explicit isTemplate flag instead of toggling', async () => {
    const out = await controller.toggleTemplate(
      { pageId: 'p1', isTemplate: false } as any,
      user,
    );
    expect(pageRepo.updatePage).toHaveBeenCalledWith(
      { isTemplate: false },
      'p1',
    );
    expect(out).toEqual({ pageId: 'p1', isTemplate: false });
  });

  it('lookup forwards dto.sourcePageIds + user.id + user.workspaceId to the service', async () => {
    const expected = { items: [] };
    (transclusionService.lookupTemplate as jest.Mock).mockResolvedValue(
      expected,
    );

    const dto = { sourcePageIds: ['s1', 's2'] } as any;
    const out = await controller.lookup(dto, user);

    expect(transclusionService.lookupTemplate).toHaveBeenCalledWith(
      ['s1', 's2'],
      'u1', // user.id
      'w1', // user.workspaceId
    );
    expect(out).toBe(expected);
  });
});

describe('TemplateLookupDto validation (class-validator)', () => {
  const uuid = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  it('accepts an array of <=50 valid UUIDs', async () => {
    const dto = plainToInstance(TemplateLookupDto, {
      sourcePageIds: [uuid(1), uuid(2)],
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects an over-cap array (ArrayMaxSize 50)', async () => {
    const dto = plainToInstance(TemplateLookupDto, {
      sourcePageIds: Array.from({ length: 51 }, (_, i) => uuid(i)),
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('arrayMaxSize');
  });

  it('rejects a non-UUID member (IsUUID each)', async () => {
    const dto = plainToInstance(TemplateLookupDto, {
      sourcePageIds: [uuid(1), 'not-a-uuid'],
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('isUuid');
  });
});
