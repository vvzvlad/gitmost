import { IsIn, IsOptional, IsString } from 'class-validator';
import { AI_DRIVERS, AiDriver } from '../ai.types';

/**
 * Admin update payload for the workspace AI provider settings.
 *
 * `apiKey` is write-only (§8.2): provided → stored encrypted, '' → cleared,
 * absent → left untouched. It is NEVER returned by any endpoint. The global
 * ValidationPipe runs with `whitelist: true`, so unknown fields are stripped.
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
  systemPrompt?: string;

  @IsOptional()
  @IsString()
  apiKey?: string;
}
