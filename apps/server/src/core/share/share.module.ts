import { Module } from '@nestjs/common';
import { ShareController } from './share.controller';
import { ShareService } from './share.service';
import { TokenModule } from '../auth/token.module';
import { ShareSeoController } from './share-seo.controller';
import { TransclusionModule } from '../page/transclusion/transclusion.module';
import { AiModule } from '../../integrations/ai/ai.module';

@Module({
  // AiModule (AiSettingsService) is used by the page-info route to surface
  // whether the anonymous public-share assistant is enabled for the workspace.
  imports: [TokenModule, TransclusionModule, AiModule],
  controllers: [ShareController, ShareSeoController],
  providers: [ShareService],
  exports: [ShareService],
})
export class ShareModule {}
