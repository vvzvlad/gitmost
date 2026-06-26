import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { PageAccessService } from '../page/page-access/page-access.service';
import { ShareService } from './share.service';
import { ShareAliasService } from './share-alias.service';
import {
  RemoveShareAliasDto,
  SetShareAliasDto,
  ShareAliasAvailabilityDto,
  ShareAliasForPageDto,
} from './dto/share-alias.dto';

/**
 * Authenticated management of vanity `/l/:alias` links. The PUBLIC resolve path
 * lives in `ShareAliasRedirectController` (`/l/:alias`); this controller only
 * creates/retargets/removes/looks-up aliases for editors.
 */
@UseGuards(JwtAuthGuard)
@Controller('share-aliases')
export class ShareAliasController {
  constructor(
    private readonly shareAliasService: ShareAliasService,
    private readonly shareService: ShareService,
    private readonly pageRepo: PageRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly pageAccessService: PageAccessService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('set')
  async set(
    @Body() dto: SetShareAliasDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const page = await this.pageRepo.findById(dto.pageId);
    if (!page || page.workspaceId !== workspace.id) {
      throw new NotFoundException('Page not found');
    }

    // Editing the page is required to point an address at it.
    await this.pageAccessService.validateCanEdit(page, user);

    // The page must currently be publicly readable through the share graph; an
    // alias to a non-shared page would only ever 404.
    const resolved = await this.shareService.resolveReadableSharePage(
      undefined,
      page.id,
      workspace.id,
    );
    if (!resolved) {
      throw new BadRequestException('Page is not publicly shared');
    }

    const sharingAllowed = await this.shareService.isSharingAllowed(
      workspace.id,
      resolved.share.spaceId,
    );
    if (!sharingAllowed) {
      throw new ForbiddenException('Public sharing is disabled');
    }

    return this.shareAliasService.setAlias({
      workspaceId: workspace.id,
      pageId: page.id,
      creatorId: user.id,
      alias: dto.alias,
      confirmReassign: dto.confirmReassign,
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post('remove')
  async remove(
    @Body() dto: RemoveShareAliasDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const alias = await this.shareAliasService.getAliasById(
      dto.aliasId,
      workspace.id,
    );
    if (!alias) {
      throw new NotFoundException('Alias not found');
    }

    // Only someone who can edit the (current) target page may free the address.
    // A dangling alias (page deleted) can be removed by any workspace member.
    if (alias.pageId) {
      const page = await this.pageRepo.findById(alias.pageId);
      if (page) {
        await this.pageAccessService.validateCanEdit(page, user);
      }
    }

    await this.shareAliasService.removeAlias(alias.id, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('availability')
  async availability(
    @Body() dto: ShareAliasAvailabilityDto,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.shareAliasService.checkAvailability(dto.alias, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('for-page')
  async forPage(
    @Body() dto: ShareAliasForPageDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const page = await this.pageRepo.findById(dto.pageId);
    if (!page || page.workspaceId !== workspace.id) {
      throw new NotFoundException('Page not found');
    }
    await this.pageAccessService.validateCanView(page, user);

    return (
      (await this.shareAliasService.getAliasForPage(page.id, workspace.id)) ??
      null
    );
  }
}
