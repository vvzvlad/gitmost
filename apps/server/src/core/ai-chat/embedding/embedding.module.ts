import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AiModule } from '../../../integrations/ai/ai.module';
import { QueueName } from '../../../integrations/queue/constants';
import { EmbeddingIndexerService } from './embedding-indexer.service';
import { EmbeddingProcessor } from './embedding.processor';

/**
 * Vector-RAG indexing unit (§6.7 stage D / §14[M1]).
 *
 * Hosts the AI_QUEUE consumer (`EmbeddingProcessor`) and the indexer service.
 * AiModule supplies AiService (embeddings); PageRepo / PageEmbeddingRepo come
 * from the global DatabaseModule. The queue itself is also registered globally
 * by QueueModule, but we register it here too so the processor binds its worker
 * to AI_QUEUE in this module's context (mirrors how other processors are wired).
 */
@Module({
  imports: [
    AiModule,
    BullModule.registerQueue({ name: QueueName.AI_QUEUE }),
  ],
  providers: [EmbeddingIndexerService, EmbeddingProcessor],
  exports: [EmbeddingIndexerService],
})
export class EmbeddingModule {}
