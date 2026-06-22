import {
  IsAlphanumeric,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform, TransformFnParams } from 'class-transformer';
import { NoUrls } from '../../../common/validators/no-urls.validator';

export class CreateWorkspaceDto {
  @MinLength(1)
  @MaxLength(64)
  @IsString()
  @NoUrls()
  @Transform(({ value }: TransformFnParams) => value?.trim())
  name: string;

  @IsOptional()
  @MinLength(4)
  @MaxLength(30)
  @IsAlphanumeric()
  @Transform(({ value }: TransformFnParams) => value?.trim().toLowerCase())
  hostname?: string;

  @IsOptional()
  @IsString()
  description?: string;
}
