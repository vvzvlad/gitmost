import { Module } from '@nestjs/common';
import { AiModule } from '../../integrations/ai/ai.module';
import { TokenModule } from '../auth/token.module';
import { AiChatController } from './ai-chat.controller';
import { AiChatService } from './ai-chat.service';
import { AiChatToolsService } from './tools/ai-chat-tools.service';

/**
 * Per-user AI chat module (§6.1).
 *
 * AiModule supplies AiService + AiSettingsService. TokenModule supplies
 * TokenService for minting the per-user loopback access token (§15[C1]). The
 * AiChatRepo / AiChatMessageRepo come from the global DatabaseModule; the
 * UserThrottlerGuard + AI_CHAT throttler come from the global ThrottleModule
 * registered in AppModule.
 */
@Module({
  imports: [AiModule, TokenModule],
  controllers: [AiChatController],
  providers: [AiChatService, AiChatToolsService],
})
export class AiChatModule {}
