import { Module } from '@nestjs/common';
import { CryptoModule } from '../crypto/crypto.module';
import { AiService } from './ai.service';
import { AiSettingsService } from './ai-settings.service';
import { AiSettingsController } from './ai-settings.controller';

/**
 * LLM driver + provider-settings unit (§6.2/§6.4).
 *
 * CryptoModule supplies SecretBoxService for API-key encryption. WorkspaceRepo,
 * AiProviderCredentialsRepo (DatabaseModule, global) and WorkspaceAbilityFactory
 * (CaslModule, global) are resolved without explicit imports.
 */
@Module({
  imports: [CryptoModule],
  controllers: [AiSettingsController],
  providers: [AiService, AiSettingsService],
  exports: [AiService, AiSettingsService],
})
export class AiModule {}
