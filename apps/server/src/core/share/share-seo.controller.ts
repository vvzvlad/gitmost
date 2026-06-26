import { Controller, Get, Logger, Param, Req, Res } from '@nestjs/common';
import { ShareService } from './share.service';
import { FastifyReply, FastifyRequest } from 'fastify';
import { join } from 'path';
import * as fs from 'node:fs';
import { validate as isValidUUID } from 'uuid';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { Workspace } from '@docmost/db/types/entity.types';
import { injectTrackerHead } from './inject-tracker-head.util';
import { buildShareMetaHtml } from './share-seo.util';

@Controller('share')
export class ShareSeoController {
  private readonly logger = new Logger(ShareSeoController.name);

  constructor(
    private readonly shareService: ShareService,
    private workspaceRepo: WorkspaceRepo,
    private environmentService: EnvironmentService,
  ) {}

  /*
   * add meta tags to publicly shared pages
   */
  @Get([':shareId/p/:pageSlug', 'p/:pageSlug'])
  async getShare(
    @Res({ passthrough: false }) res: FastifyReply,
    @Req() req: FastifyRequest,
    @Param('shareId') shareId: string,
    @Param('pageSlug') pageSlug: string,
  ) {
    // Nestjs does not to apply middlewares to paths excluded from the global /api prefix
    // https://github.com/nestjs/nest/issues/9124
    // https://github.com/nestjs/nest/issues/11572
    // https://github.com/nestjs/nest/issues/13401
    // we have to duplicate the DomainMiddleware code here as a workaround

    let workspace: Workspace = null;
    if (this.environmentService.isSelfHosted()) {
      workspace = await this.workspaceRepo.findFirst();
    } else {
      const header = req.raw.headers.host;
      const subdomain = header.split('.')[0];
      workspace = await this.workspaceRepo.findByHostname(subdomain);
    }

    const clientDistPath = join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'client/dist',
    );

    if (fs.existsSync(clientDistPath)) {
      const indexFilePath = join(clientDistPath, 'index.html');

      if (!workspace) {
        return this.sendIndex(indexFilePath, res);
      }

      const pageId = this.extractPageSlugId(pageSlug);

      // Funnel through the canonical readable-share boundary (NOT the raw
      // getShareForPage) so the restricted-ancestor gate runs: a permission-
      // restricted descendant of an includeSubPages share must NOT leak its
      // title to anonymous visitors / crawlers (red-team finding #3). null =>
      // not publicly readable => serve the plain SPA index with no meta.
      const resolved = await this.shareService.resolveReadableSharePage(
        undefined,
        pageId,
        workspace.id,
      );

      if (!resolved) {
        return this.sendIndex(indexFilePath, res);
      }

      // Honour a workspace/space-level sharing toggle flipped off AFTER this
      // share was created: the content API gates on isSharingAllowed, so the SEO
      // path must too or it keeps serving the title for a no-longer-shared page.
      const sharingAllowed = await this.shareService.isSharingAllowed(
        workspace.id,
        resolved.share.spaceId,
      );
      if (!sharingAllowed) {
        return this.sendIndex(indexFilePath, res);
      }

      const html = fs.readFileSync(indexFilePath, 'utf8');
      // Title of the PAGE being viewed (server-resolved), and noindex unless the
      // share opted into search indexing (buildShareMetaHtml injects it).
      let transformedHtml = buildShareMetaHtml(html, {
        title: resolved.page.title,
        searchIndexing: resolved.share.searchIndexing,
      });

      // Deliberate same-origin tracker surface: this is the ONE place where an
      // admin-authored analytics/tracker snippet (settings.trackerHead) is
      // injected verbatim into the page origin. It is admin-only (writable only
      // via the admin-gated workspace settings) and applies to PUBLIC SHARE
      // pages only. It is trusted content, so it is NOT escaped. The htmlEmbed
      // block itself is sandboxed and is the safe surface for everyone else.
      const trackerHead = (workspace?.settings as any)?.trackerHead;
      const beforeInjection = transformedHtml;
      transformedHtml = injectTrackerHead(transformedHtml, trackerHead);
      if (
        beforeInjection === transformedHtml &&
        typeof trackerHead === 'string' &&
        trackerHead.trim().length > 0
      ) {
        // A non-empty snippet was configured but nothing was injected: the only
        // reason injectTrackerHead leaves the html unchanged for a non-empty
        // snippet is a missing </head> marker.
        this.logger.warn(
          'trackerHead is configured but no </head> marker was found in the share index HTML; tracker snippet was not injected.',
        );
      }

      res.type('text/html').send(transformedHtml);
    }
  }

  sendIndex(indexFilePath: string, res: FastifyReply) {
    const stream = fs.createReadStream(indexFilePath);
    res.type('text/html').send(stream);
  }

  extractPageSlugId(slug: string): string {
    if (!slug) {
      return undefined;
    }
    if (isValidUUID(slug)) {
      return slug;
    }
    const parts = slug.split('-');
    return parts.length > 1 ? parts[parts.length - 1] : slug;
  }
}
