import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  Inject,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { CommentService } from './comment.service';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';
import { ResolveCommentDto } from './dto/resolve-comment.dto';
import { ApplySuggestionDto } from './dto/apply-suggestion.dto';
import { DismissSuggestionDto } from './dto/dismiss-suggestion.dto';
import { ResyncSuggestionAnchorDto } from './dto/resync-suggestion-anchor.dto';
import { PageIdDto, CommentIdDto } from './dto/comments.input';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import {
  AuthProvenance,
  AuthProvenanceData,
} from '../../common/decorators/auth-provenance.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { User, Workspace } from '@docmost/db/types/entity.types';
import SpaceAbilityFactory from '../casl/abilities/space-ability.factory';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../casl/interfaces/space-ability.type';
import { CommentRepo } from '@docmost/db/repos/comment/comment.repo';
import { PageAccessService } from '../page/page-access/page-access.service';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';
import { WsService } from '../../ws/ws.service';

@UseGuards(JwtAuthGuard)
@Controller('comments')
export class CommentController {
  constructor(
    private readonly commentService: CommentService,
    private readonly commentRepo: CommentRepo,
    private readonly pageRepo: PageRepo,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly pageAccessService: PageAccessService,
    private readonly wsService: WsService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('create')
  async create(
    @Body() createCommentDto: CreateCommentDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @AuthProvenance() provenance: AuthProvenanceData,
  ) {
    const page = await this.pageRepo.findById(createCommentDto.pageId);
    if (!page || page.deletedAt) {
      throw new NotFoundException('Page not found');
    }

    await this.pageAccessService.validateCanComment(page, user, workspace.id);

    const comment = await this.commentService.create(
      {
        page,
        workspaceId: workspace.id,
        user,
      },
      createCommentDto,
      provenance,
    );

    this.auditService.log({
      event: AuditEvent.COMMENT_CREATED,
      resourceType: AuditResource.COMMENT,
      resourceId: comment.id,
      spaceId: page.spaceId,
      metadata: {
        pageId: page.id,
      },
    });

    return comment;
  }

  @HttpCode(HttpStatus.OK)
  @Post('/')
  async findPageComments(
    @Body() input: PageIdDto,
    @Body()
    pagination: PaginationOptions,
    @AuthUser() user: User,
  ) {
    const page = await this.pageRepo.findById(input.pageId);
    if (!page) {
      throw new NotFoundException('Page not found');
    }

    await this.pageAccessService.validateCanView(page, user);

    return this.commentService.findByPageId(page.id, pagination);
  }

  @HttpCode(HttpStatus.OK)
  @Post('info')
  async findOne(@Body() input: CommentIdDto, @AuthUser() user: User) {
    const comment = await this.commentRepo.findById(input.commentId);
    if (!comment) {
      throw new NotFoundException('Comment not found');
    }

    const page = await this.pageRepo.findById(comment.pageId);
    if (!page) {
      throw new NotFoundException('Page not found');
    }

    await this.pageAccessService.validateCanView(page, user);

    return comment;
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  async update(@Body() dto: UpdateCommentDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    const comment = await this.commentRepo.findById(dto.commentId, {
      includeCreator: true,
      includeResolvedBy: true,
    });
    if (!comment) {
      throw new NotFoundException('Comment not found');
    }

    const page = await this.pageRepo.findById(comment.pageId);
    if (!page) {
      throw new NotFoundException('Page not found');
    }

    await this.pageAccessService.validateCanComment(page, user, workspace.id);

    return this.commentService.update(comment, dto, user);
  }

  @HttpCode(HttpStatus.OK)
  @Post('resolve')
  async resolve(
    @Body() dto: ResolveCommentDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @AuthProvenance() provenance: AuthProvenanceData,
  ) {
    const comment = await this.commentRepo.findById(dto.commentId, {
      includeCreator: true,
      includeResolvedBy: true,
    });
    if (!comment) {
      throw new NotFoundException('Comment not found');
    }

    // Only top-level comments can be resolved; replies follow their parent.
    if (comment.parentCommentId) {
      throw new BadRequestException('Only parent comments can be resolved');
    }

    const page = await this.pageRepo.findById(comment.pageId);
    if (!page) {
      throw new NotFoundException('Page not found');
    }

    await this.pageAccessService.validateCanComment(page, user, workspace.id);

    const updated = await this.commentService.resolveComment(
      comment,
      dto.resolved,
      user,
      provenance,
    );

    this.auditService.log({
      event: dto.resolved
        ? AuditEvent.COMMENT_RESOLVED
        : AuditEvent.COMMENT_REOPENED,
      resourceType: AuditResource.COMMENT,
      resourceId: comment.id,
      spaceId: comment.spaceId,
      metadata: {
        pageId: comment.pageId,
      },
    });

    return updated;
  }

  @HttpCode(HttpStatus.OK)
  @Post('apply-suggestion')
  async applySuggestion(
    @Body() dto: ApplySuggestionDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @AuthProvenance() provenance: AuthProvenanceData,
  ) {
    const comment = await this.commentRepo.findById(dto.commentId, {
      includeCreator: true,
      includeResolvedBy: true,
    });
    if (!comment) {
      throw new NotFoundException('Comment not found');
    }

    const page = await this.pageRepo.findById(comment.pageId);
    if (!page || page.deletedAt) {
      throw new NotFoundException('Page not found');
    }

    // Authorize BEFORE revealing any structural detail about the comment
    // (metadata-disclosure hygiene). Applying a suggestion rewrites the page
    // text, so require edit access (NOT just comment access). Running this
    // first means a cross-workspace user with a guessed comment UUID gets a
    // uniform 403 regardless of the comment's type or suggestion state — it can
    // never distinguish those before the access check. The structural 400s
    // (top-level / has-a-suggested-edit) are re-checked by the service below.
    await this.pageAccessService.validateCanEdit(page, user);

    // The service re-validates the comment's state, returns idempotent success
    // for an already-applied suggestion, and lets ConflictException (409, with
    // currentText in the payload) propagate untouched.
    return this.commentService.applySuggestion(comment, user, provenance);
  }

  @HttpCode(HttpStatus.OK)
  @Post('resync-suggestion-anchor')
  async resyncSuggestionAnchor(
    @Body() dto: ResyncSuggestionAnchorDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const comment = await this.commentRepo.findById(dto.commentId, {
      includeCreator: true,
      includeResolvedBy: true,
    });
    if (!comment) {
      throw new NotFoundException('Comment not found');
    }

    const page = await this.pageRepo.findById(comment.pageId);
    if (!page || page.deletedAt) {
      throw new NotFoundException('Page not found');
    }

    // Authorize BEFORE revealing structural detail (mirrors apply/dismiss).
    // Re-anchoring does NOT change the page text — it only corrects the stored
    // selection metadata — so the page-level gate is comment access. The service
    // further restricts it to the suggestion's own author.
    await this.pageAccessService.validateCanComment(page, user, workspace.id);

    return this.commentService.resyncSuggestionAnchor(
      comment,
      dto.selection,
      user,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('dismiss-suggestion')
  async dismissSuggestion(
    @Body() dto: DismissSuggestionDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @AuthProvenance() provenance: AuthProvenanceData,
  ) {
    const comment = await this.commentRepo.findById(dto.commentId, {
      includeCreator: true,
      includeResolvedBy: true,
    });
    if (!comment) {
      throw new NotFoundException('Comment not found');
    }

    const page = await this.pageRepo.findById(comment.pageId);
    if (!page || page.deletedAt) {
      throw new NotFoundException('Page not found');
    }

    // Authorize BEFORE revealing any structural detail (metadata-disclosure
    // hygiene, mirroring apply-suggestion). Dismissing a suggestion does NOT
    // change the page text — it only removes/resolves the comment — so the
    // page-level gate is comment access (canComment), NOT edit access. A viewer
    // allowed to comment but not edit can still dismiss their own suggestion.
    // The structural 400s (top-level / has-a-suggested-edit / not applied /
    // not resolved) are re-checked by the service below.
    await this.pageAccessService.validateCanComment(page, user, workspace.id);

    // AUTHZ (#338): a childless dismiss IRREVERSIBLY hard-deletes the comment,
    // so — beyond canComment — restrict it to the comment owner OR a space
    // admin, exactly like POST /comments/delete. canComment alone is not enough:
    // it would let any bystander commenter erase another user's suggestion for
    // good. (apply-suggestion deliberately stays on canEdit: accepting an edit
    // is the editor's semantics, not the suggestion author's.)
    const isOwner = comment.creatorId === user.id;
    if (!isOwner) {
      const ability = await this.spaceAbility.createForUser(
        user,
        comment.spaceId,
      );
      // Space admin can dismiss any suggestion.
      if (ability.cannot(SpaceCaslAction.Manage, SpaceCaslSubject.Settings)) {
        throw new ForbiddenException(
          'You can only dismiss your own suggestions',
        );
      }
    }

    return this.commentService.dismissSuggestion(comment, user, provenance);
  }

  @HttpCode(HttpStatus.OK)
  @Post('delete')
  async delete(@Body() input: CommentIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    const comment = await this.commentRepo.findById(input.commentId);
    if (!comment) {
      throw new NotFoundException('Comment not found');
    }

    const page = await this.pageRepo.findById(comment.pageId);
    if (!page) {
      throw new NotFoundException('Page not found');
    }

    await this.pageAccessService.validateCanComment(page, user, workspace.id);

    // Check if user is the comment owner
    const isOwner = comment.creatorId === user.id;

    if (isOwner) {
      await this.commentRepo.deleteComment(comment.id);
    } else {
      const ability = await this.spaceAbility.createForUser(
        user,
        comment.spaceId,
      );

      // Space admin can delete any comment
      if (ability.cannot(SpaceCaslAction.Manage, SpaceCaslSubject.Settings)) {
        throw new ForbiddenException(
          'You can only delete your own comments',
        );
      }
      await this.commentRepo.deleteComment(comment.id);
    }

    this.wsService.emitCommentEvent(comment.spaceId, comment.pageId, {
      operation: 'commentDeleted',
      pageId: comment.pageId,
      commentId: comment.id,
    });

    this.auditService.log({
      event: AuditEvent.COMMENT_DELETED,
      resourceType: AuditResource.COMMENT,
      resourceId: comment.id,
      spaceId: comment.spaceId,
      changes: {
        before: {
          pageId: comment.pageId,
          creatorId: comment.creatorId,
        },
      },
    });
  }
}
