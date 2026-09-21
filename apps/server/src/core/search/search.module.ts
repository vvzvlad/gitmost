import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { AiModule } from '../../integrations/ai/ai.module';

/**
 * #530: AiModule supplies AiService (embedQuery / resolveEmbeddingProvider).
 * PageEmbeddingRepo is provided by the @Global DatabaseModule, so it is injected
 * into SearchService without an explicit import here.
 */
@Module({
  imports: [AiModule],
  controllers: [SearchController],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
