import { Module } from '@nestjs/common';
import { AiModule } from '../../integrations/ai/ai.module';
import { TokenModule } from '../auth/token.module';
import { AiChatController } from './ai-chat.controller';
import { AiChatService } from './ai-chat.service';
import { AiTranscriptionService } from './ai-transcription.service';
import { AiChatToolsService } from './tools/ai-chat-tools.service';
import { EmbeddingModule } from './embedding/embedding.module';
import { ExternalMcpModule } from './external-mcp/external-mcp.module';
import { ShareModule } from '../share/share.module';
import { SearchModule } from '../search/search.module';
import { PublicShareChatController } from './public-share-chat.controller';
import { PublicShareChatService } from './public-share-chat.service';
import { PublicShareChatToolsService } from './tools/public-share-chat-tools.service';

/**
 * Per-user AI chat module (§6.1).
 *
 * AiModule supplies AiService + AiSettingsService. TokenModule supplies
 * TokenService for minting the per-user loopback access token (§15[C1]). The
 * AiChatRepo / AiChatMessageRepo / PageEmbeddingRepo / SpaceMemberRepo /
 * PagePermissionRepo come from the global DatabaseModule; the UserThrottlerGuard
 * + AI_CHAT throttler come from the global ThrottleModule registered in
 * AppModule. EmbeddingModule hosts the vector-RAG indexer + AI_QUEUE consumer
 * (§6.7 stage D); importing it here boots the processor with the app.
 *
 * ShareModule (ShareService) + SearchModule (SearchService) are imported for the
 * ANONYMOUS public-share assistant (PublicShareChatController), whose read-only
 * tools scope every lookup to a single share tree.
 */
@Module({
  imports: [
    AiModule,
    TokenModule,
    EmbeddingModule,
    ExternalMcpModule,
    ShareModule,
    SearchModule,
  ],
  controllers: [AiChatController, PublicShareChatController],
  providers: [
    AiChatService,
    AiTranscriptionService,
    AiChatToolsService,
    PublicShareChatService,
    PublicShareChatToolsService,
  ],
})
export class AiChatModule {}
