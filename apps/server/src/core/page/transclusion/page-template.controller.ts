import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { User } from '@docmost/db/types/entity.types';
import { TransclusionService } from './transclusion.service';
import { TemplateLookupDto } from './dto/template-lookup.dto';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageAccessService } from '../page-access/page-access.service';
import { ToggleTemplateDto } from './dto/toggle-template.dto';

@UseGuards(JwtAuthGuard)
@Controller('pages')
export class PageTemplateController {
  constructor(
    private readonly transclusionService: TransclusionService,
    private readonly pageRepo: PageRepo,
    private readonly pageAccessService: PageAccessService,
  ) {}

  /**
   * Whole-page live embed lookup for authenticated viewers. Returns current
   * content (comment marks stripped) for accessible source pages.
   */
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

    await this.pageAccessService.validateCanEdit(page, user);

    const isTemplate =
      typeof dto.isTemplate === 'boolean' ? dto.isTemplate : !page.isTemplate;

    await this.pageRepo.updatePage({ isTemplate }, page.id);

    return { pageId: page.id, isTemplate };
  }
}
