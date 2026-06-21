import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

export class ToggleTemplateDto {
  @IsUUID()
  pageId!: string;

  /** When omitted, the flag is toggled relative to its current value. */
  @IsOptional()
  @IsBoolean()
  isTemplate?: boolean;
}
