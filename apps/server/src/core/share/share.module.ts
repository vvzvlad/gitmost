import { Module } from '@nestjs/common';
import { ShareController } from './share.controller';
import { ShareService } from './share.service';
import { TokenModule } from '../auth/token.module';
import { ShareSeoController } from './share-seo.controller';
import { TransclusionModule } from '../page/transclusion/transclusion.module';
import { AiModule } from '../../integrations/ai/ai.module';
import { ShareAliasService } from './share-alias.service';
import { ShareAliasController } from './share-alias.controller';
import { ShareAliasRedirectController } from './share-alias-redirect.controller';

@Module({
  // AiModule (AiSettingsService) is used by the page-info route to surface
  // whether the anonymous public-share assistant is enabled for the workspace.
  imports: [TokenModule, TransclusionModule, AiModule],
  controllers: [
    ShareController,
    ShareSeoController,
    // Vanity /l/:alias: authenticated management + public 302 resolver.
    ShareAliasController,
    ShareAliasRedirectController,
  ],
  providers: [ShareService, ShareAliasService],
  exports: [ShareService, ShareAliasService],
})
export class ShareModule {}
