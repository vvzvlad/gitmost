import { Controller, Get, Logger, Param, Req, Res } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { join } from 'path';
import * as fs from 'node:fs';
import slugify from '@sindresorhus/slugify';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { Workspace } from '@docmost/db/types/entity.types';
import { ShareAliasService } from './share-alias.service';

/**
 * Public resolver for vanity links `GET /l/:alias`. Excluded from the global
 * `/api` prefix (see main.ts) and parallel to ShareSeoController.
 *
 * On a hit it issues a 302 (NEVER 301) to the canonical
 * `/share/:key/p/:slug` page, so:
 *   - the existing share render + SSR meta is reused verbatim (crawlers follow
 *     the 302 and get the correct preview);
 *   - because the alias target is mutable, a temporary redirect is always
 *     re-resolved — a cached 301 would pin clients to the pre-swap page.
 *
 * Any unknown / dangling / no-longer-readable alias serves the plain SPA index
 * (same as any unknown path) so the existence of a name never leaks.
 */
@Controller('l')
export class ShareAliasRedirectController {
  private readonly logger = new Logger(ShareAliasRedirectController.name);

  constructor(
    private readonly shareAliasService: ShareAliasService,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly environmentService: EnvironmentService,
  ) {}

  @Get(':alias')
  async resolve(
    @Param('alias') rawAlias: string,
    @Req() req: FastifyRequest,
    @Res({ passthrough: false }) res: FastifyReply,
  ) {
    // NestJS does not apply middlewares to paths excluded from the global /api
    // prefix, so the DomainMiddleware workspace resolution is duplicated here
    // (same workaround as ShareSeoController).
    let workspace: Workspace = null;
    if (this.environmentService.isSelfHosted()) {
      workspace = await this.workspaceRepo.findFirst();
    } else {
      const header = req.raw.headers.host;
      const subdomain = header?.split('.')[0];
      workspace = subdomain
        ? await this.workspaceRepo.findByHostname(subdomain)
        : null;
    }

    const clientDistPath = join(__dirname, '..', '..', '..', '..', 'client/dist');
    const indexFilePath = join(clientDistPath, 'index.html');

    let decoded = rawAlias;
    try {
      decoded = decodeURIComponent(rawAlias);
    } catch {
      // Malformed percent-encoding -> treat as unknown alias.
    }

    const resolved = workspace
      ? await this.shareAliasService.resolveReadableTarget(
          decoded,
          workspace.id,
        )
      : null;

    if (!resolved) {
      return this.sendIndex(indexFilePath, res);
    }

    const slug = buildPageSlug(resolved.page.slugId, resolved.page.title);
    // 302, NOT 301: the alias is retargetable, so the redirect must always be
    // re-resolved by clients/crawlers.
    return res.redirect(`/share/${resolved.share.key}/p/${slug}`, 302);
  }

  private sendIndex(indexFilePath: string, res: FastifyReply) {
    if (!fs.existsSync(indexFilePath)) {
      // No built client (e.g. API-only dev): nothing to serve.
      res.status(404).send('Not found');
      return;
    }
    const stream = fs.createReadStream(indexFilePath);
    res.type('text/html').send(stream);
  }
}

/** Canonical share page slug: `<title-slug>-<slugId>` (mirrors the client). */
function buildPageSlug(slugId: string, title?: string): string {
  const titleSlug = slugify(title?.substring(0, 70) || 'untitled');
  return `${titleSlug}-${slugId}`;
}
