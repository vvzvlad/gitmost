import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

export enum ExportFormat {
  HTML = 'html',
  Markdown = 'markdown',
  DOCX = 'docx',
  PDF = 'pdf',
}

export class ExportPageDto {
  @IsString()
  @IsNotEmpty()
  pageId: string;

  @IsString()
  @IsEnum(ExportFormat)
  format: ExportFormat;

  @IsOptional()
  @IsBoolean()
  includeChildren?: boolean;

  @IsOptional()
  @IsBoolean()
  includeAttachments?: boolean;
}

export class ExportSpaceDto {
  @IsString()
  @IsNotEmpty()
  spaceId: string;

  @IsString()
  @IsEnum(ExportFormat)
  format: ExportFormat;

  @IsOptional()
  @IsBoolean()
  includeAttachments?: boolean;
}
