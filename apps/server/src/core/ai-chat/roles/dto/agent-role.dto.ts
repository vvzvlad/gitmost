import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AI_DRIVERS, AiDriver } from '../../../../integrations/ai/ai.types';

/**
 * Optional per-role model override. `chatModel` swaps the model id; `driver`
 * (optional) switches the provider — when set it must be a supported driver and
 * its creds must already exist (enforced at resolve time with a clear 503).
 */
export class RoleModelConfigDto {
  @IsOptional()
  @IsIn(AI_DRIVERS)
  driver?: AiDriver;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  chatModel?: string;
}

/** Admin create payload for an agent role. */
export class CreateAgentRoleDto {
  @IsString()
  @MaxLength(200)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  emoji?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsString()
  @MaxLength(20000)
  instructions: string;

  // null/omitted => use the workspace default model.
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => RoleModelConfigDto)
  modelConfig?: RoleModelConfigDto | null;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/** Admin update payload for an agent role (all fields optional). */
export class UpdateAgentRoleDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  emoji?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  instructions?: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => RoleModelConfigDto)
  modelConfig?: RoleModelConfigDto | null;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
