import {
  Body,
  Controller,
  ConflictException,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsOptional, IsUUID, ValidateIf } from 'class-validator';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SpaceRepo } from '@docmost/db/repos/space/space.repo';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { User } from '@docmost/db/types/entity.types';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import SpaceAbilityFactory from '../casl/abilities/space-ability.factory';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../casl/interfaces/space-ability.type';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';
import { PageAccessService } from './page-access/page-access.service';

class SpacePagePreferenceDto {
  @IsUUID()
  spaceId: string;

  // null clears the setting; an omitted or malformed ID is invalid.
  @ValidateIf((_dto, value) => value !== null)
  @IsUUID()
  pageId: string | null;
}

class SpacePinDto extends SpacePagePreferenceDto {
  @IsOptional()
  @IsBoolean()
  onlyIfUnset?: boolean;
}

@UseGuards(JwtAuthGuard)
@Controller('pages/preferences')
export class PagePreferenceController {
  constructor(
    private readonly pageRepo: PageRepo,
    private readonly spaceRepo: SpaceRepo,
    private readonly userRepo: UserRepo,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly pageAccess: PageAccessService,
    @Inject(AUDIT_SERVICE) private readonly audit: IAuditService,
  ) {}

  @Post('space-home')
  @HttpCode(HttpStatus.OK)
  async setSpaceHome(
    @Body() dto: SpacePagePreferenceDto,
    @AuthUser() user: User,
  ) {
    const space = await this.checkSpacePage(
      dto,
      user,
      SpaceCaslAction.Manage,
      SpaceCaslSubject.Settings,
    );
    const updated = await this.spaceRepo.setHomePage(
      dto.spaceId,
      user.workspaceId,
      dto.pageId,
    );
    if (!updated) throw new NotFoundException('Space not found');
    const before =
      (space.settings as { homePageId?: string } | null)?.homePageId ?? null;
    if (before !== dto.pageId) {
      this.audit.log({
        event: AuditEvent.SPACE_UPDATED,
        resourceType: AuditResource.SPACE,
        resourceId: space.id,
        spaceId: space.id,
        changes: {
          before: { homePageId: before },
          after: { homePageId: dto.pageId },
        },
      });
    }
    return { pageId: dto.pageId };
  }

  @Post('space-pin')
  @HttpCode(HttpStatus.OK)
  async setSpacePin(@Body() dto: SpacePinDto, @AuthUser() user: User) {
    await this.checkSpacePage(
      dto,
      user,
      SpaceCaslAction.Read,
      SpaceCaslSubject.Page,
    );
    const updated = await this.userRepo.setSpacePin(
      user.id,
      user.workspaceId,
      dto.spaceId,
      dto.pageId,
      dto.onlyIfUnset,
    );
    if (!updated)
      throw new ConflictException('Space pin storage limit reached');
    const settings = updated.settings as {
      spacePins?: Record<string, string | null>;
    };
    return { pageId: settings?.spacePins?.[dto.spaceId] ?? null };
  }

  private async checkSpacePage(
    dto: SpacePagePreferenceDto,
    user: User,
    action: SpaceCaslAction,
    subject: SpaceCaslSubject,
  ) {
    const space = await this.spaceRepo.findById(dto.spaceId, user.workspaceId);
    if (!space) throw new NotFoundException('Space not found');
    const ability = await this.spaceAbility.createForUser(user, space.id);
    if (ability.cannot(action, subject)) throw new ForbiddenException();
    if (dto.pageId === null) return space;

    const page = await this.pageRepo.findById(dto.pageId);
    if (
      !page ||
      page.deletedAt ||
      page.spaceId !== space.id ||
      page.workspaceId !== user.workspaceId
    ) {
      throw new NotFoundException('Page not found in this space');
    }
    await this.pageAccess.validateCanView(page, user);
    return space;
  }
}
