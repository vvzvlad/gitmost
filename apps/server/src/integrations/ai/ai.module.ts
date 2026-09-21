import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CryptoModule } from '../crypto/crypto.module';
import { QueueName } from '../queue/constants';
import { AiService } from './ai.service';
import { AiSettingsService } from './ai-settings.service';
import { AiSettingsController } from './ai-settings.controller';
import { EmbeddingGenerationService } from './embedding-generation.service';
import { EmbeddingReindexProgressService } from './embedding-reindex-progress.service';

/**
 * LLM driver + provider-settings unit (§6.2/§6.4).
 *
 * CryptoModule supplies SecretBoxService for API-key encryption. WorkspaceRepo,
 * AiProviderCredentialsRepo (DatabaseModule, global) and WorkspaceAbilityFactory
 * (CaslModule, global) are resolved without explicit imports.
 */
@Module({
  imports: [
    CryptoModule,
    BullModule.registerQueue({ name: QueueName.AI_QUEUE }),
  ],
  controllers: [AiSettingsController],
  providers: [
    AiService,
    AiSettingsService,
    EmbeddingGenerationService,
    EmbeddingReindexProgressService,
  ],
  exports: [
    AiService,
    AiSettingsService,
    // #599: the embedding fingerprint lifecycle (active/target generation, GC,
    // atomic swap, coverage). Consumed by SearchModule (the vector arm + the
    // semantic coverage state), the AI-chat RAG tool and the EmbeddingModule
    // indexer. WorkspaceRepo / PageEmbeddingRepo / PageRepo come from the global
    // DatabaseModule.
    EmbeddingGenerationService,
    EmbeddingReindexProgressService,
  ],
})
export class AiModule {}
