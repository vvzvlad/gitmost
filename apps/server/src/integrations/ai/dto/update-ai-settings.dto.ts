import { IsIn, IsOptional, IsString } from 'class-validator';
import { AI_DRIVERS, AiDriver, STT_API_STYLES, SttApiStyle } from '../ai.types';

/**
 * Admin update payload for the workspace AI provider settings.
 *
 * `apiKey` / `embeddingApiKey` / `sttApiKey` are write-only (§8.2): provided →
 * stored encrypted, '' → cleared, absent → left untouched. They are NEVER
 * returned by any endpoint. The global ValidationPipe runs with
 * `whitelist: true`, so unknown fields are stripped.
 */
export class UpdateAiSettingsDto {
  @IsOptional()
  @IsIn(AI_DRIVERS)
  driver?: AiDriver;

  @IsOptional()
  @IsString()
  chatModel?: string;

  @IsOptional()
  @IsString()
  embeddingModel?: string;

  @IsOptional()
  @IsString()
  baseUrl?: string;

  @IsOptional()
  @IsString()
  embeddingBaseUrl?: string;

  @IsOptional()
  @IsString()
  systemPrompt?: string;

  @IsOptional()
  @IsString()
  apiKey?: string;

  @IsOptional()
  @IsString()
  embeddingApiKey?: string;

  @IsOptional()
  @IsString()
  sttModel?: string;

  @IsOptional()
  @IsString()
  sttBaseUrl?: string;

  @IsOptional()
  @IsIn(STT_API_STYLES)
  sttApiStyle?: SttApiStyle;

  @IsOptional()
  @IsString()
  sttApiKey?: string;

  // Cheap model id for the anonymous public-share assistant; reuses the chat
  // driver/baseUrl/apiKey. Empty → the assistant falls back to chatModel.
  @IsOptional()
  @IsString()
  publicShareChatModel?: string;

  // Agent-role id whose persona the anonymous public-share assistant adopts;
  // empty/unset = built-in locked persona.
  @IsOptional()
  @IsString()
  publicShareAssistantRoleId?: string;
}
