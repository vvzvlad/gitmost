import { Module } from '@nestjs/common';
import { AiModule } from '../../integrations/ai/ai.module';
import { TokenModule } from '../auth/token.module';
import { AiChatController } from './ai-chat.controller';
import { AiChatService } from './ai-chat.service';
import { AiTranscriptionService } from './ai-transcription.service';
import { AiChatToolsService } from './tools/ai-chat-tools.service';
import { EmbeddingModule } from './embedding/embedding.module';
import { ExternalMcpModule } from './external-mcp/external-mcp.module';

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
 */
@Module({
  imports: [AiModule, TokenModule, EmbeddingModule, ExternalMcpModule],
  controllers: [AiChatController],
  providers: [AiChatService, AiTranscriptionService, AiChatToolsService],
})
export class AiChatModule {}
