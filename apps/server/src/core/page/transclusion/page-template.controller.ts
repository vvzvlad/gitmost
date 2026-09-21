import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { User } from '@docmost/db/types/entity.types';
import { TransclusionService } from './transclusion.service';
import { TemplateLookupDto } from './dto/template-lookup.dto';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageAccessService } from '../page-access/page-access.service';
import { ToggleTemplateDto } from './dto/toggle-template.dto';
import { ToggleTemporaryDto } from './dto/toggle-temporary.dto';
import { UserThrottlerGuard } from '../../../integrations/throttle/user-throttler.guard';
import { PAGE_TEMPLATE_THROTTLER } from '../../../integrations/throttle/throttler-names';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { DEFAULT_TEMPORARY_NOTE_HOURS } from '../constants/temporary-note.constants';

@UseGuards(JwtAuthGuard)
@Controller('pages')
export class PageTemplateController {
  constructor(
    private readonly transclusionService: TransclusionService,
    private readonly pageRepo: PageRepo,
    private readonly pageAccessService: PageAccessService,
    @InjectKysely() private readonly db: KyselyDB,
  ) {}

  /**
   * Whole-page live embed lookup for authenticated viewers. Returns current
   * content (comment marks stripped) for accessible source pages.
   *
   * DoS note: the embed cycle/depth cap (PAGE_EMBED_MAX_DEPTH=5) is enforced
   * CLIENT-side only — a scripted client could otherwise drive heavy full-doc
   * fan-out. The server bounds the cost with this per-user throttle plus the
   * DTO's ArrayMaxSize(50) cap; server-side recursive expansion is out of scope.
   */
  @UseGuards(JwtAuthGuard, UserThrottlerGuard)
  @Throttle({ [PAGE_TEMPLATE_THROTTLER]: { limit: 30, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('template/lookup')
  async lookup(@Body() dto: TemplateLookupDto, @AuthUser() user: User) {
    return this.transclusionService.lookupTemplate(
      dto.sourcePageIds,
      user.id,
      user.workspaceId,
    );
  }

  /**
   * Flip `pages.is_template`. Requires Edit on the page/space (CASL is enforced
   * inside `validateCanEdit`). The flag only affects template picker discovery;
   * it does not restrict editing or embedding.
   */
  @UseGuards(JwtAuthGuard, UserThrottlerGuard)
  @Throttle({ [PAGE_TEMPLATE_THROTTLER]: { limit: 30, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('toggle-template')
  async toggleTemplate(
    @Body() dto: ToggleTemplateDto,
    @AuthUser() user: User,
  ) {
    const page = await this.pageRepo.findById(dto.pageId);
    if (!page || page.deletedAt) {
      throw new NotFoundException('Page not found');
    }

    if (page.workspaceId !== user.workspaceId) {
      // Defense-in-depth: never act on a page outside the caller's workspace.
      // Use NotFound (not Forbidden) to avoid leaking cross-workspace existence.
      throw new NotFoundException('Page not found');
    }

    await this.pageAccessService.validateCanEdit(page, user);

    const isTemplate =
      typeof dto.isTemplate === 'boolean' ? dto.isTemplate : !page.isTemplate;

    await this.pageRepo.updatePage({ isTemplate }, page.id);

    return { pageId: page.id, isTemplate };
  }

  /**
   * Arm or disarm the "death timer" on a page (`pages.temporary_expires_at`).
   * Mirror of toggle-template: requires Edit on the page/space (CASL enforced in
   * `validateCanEdit`). Arming freezes the deadline at now + the workspace's
   * temporaryNoteHours; disarming ("Make permanent") clears it. Same workspace
   * defense-in-depth as toggle-template (NotFound, never Forbidden, on mismatch).
   */
  @UseGuards(JwtAuthGuard, UserThrottlerGuard)
  @Throttle({ [PAGE_TEMPLATE_THROTTLER]: { limit: 30, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('toggle-temporary')
  async toggleTemporary(
    @Body() dto: ToggleTemporaryDto,
    @AuthUser() user: User,
  ) {
    const page = await this.pageRepo.findById(dto.pageId);
    if (!page || page.deletedAt) {
      throw new NotFoundException('Page not found');
    }

    if (page.workspaceId !== user.workspaceId) {
      // Defense-in-depth: never act on a page outside the caller's workspace.
      // Use NotFound (not Forbidden) to avoid leaking cross-workspace existence.
      throw new NotFoundException('Page not found');
    }

    await this.pageAccessService.validateCanEdit(page, user);

    const makeTemporary =
      typeof dto.temporary === 'boolean'
        ? dto.temporary
        : page.temporaryExpiresAt == null;

    let temporaryExpiresAt: Date | null = null;
    if (makeTemporary) {
      const workspace = await this.db
        .selectFrom('workspaces')
        .select(['temporaryNoteHours'])
        .where('id', '=', user.workspaceId)
        .executeTakeFirst();
      const hours =
        workspace?.temporaryNoteHours ?? DEFAULT_TEMPORARY_NOTE_HOURS;
      temporaryExpiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
    }

    await this.pageRepo.updatePage({ temporaryExpiresAt }, page.id);

    return { pageId: page.id, temporaryExpiresAt };
  }
}
