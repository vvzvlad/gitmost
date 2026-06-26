import { PartialType } from '@nestjs/mapped-types';
import { CreateWorkspaceDto } from './create-workspace.dto';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdateWorkspaceDto extends PartialType(CreateWorkspaceDto) {
  @IsOptional()
  @IsArray()
  emailDomains: string[];

  @IsOptional()
  @IsBoolean()
  enforceSso: boolean;

  @IsOptional()
  @IsBoolean()
  enforceMfa: boolean;

  @IsOptional()
  @IsBoolean()
  restrictApiToAdmins: boolean;

  @IsOptional()
  @IsBoolean()
  aiSearch: boolean;

  @IsOptional()
  @IsBoolean()
  generativeAi: boolean;

  @IsOptional()
  @IsBoolean()
  disablePublicSharing: boolean;

  @IsOptional()
  @IsBoolean()
  mcpEnabled: boolean;

  @IsOptional()
  @IsBoolean()
  isScimEnabled: boolean;

  @IsOptional()
  @IsBoolean()
  aiChat: boolean;

  @IsOptional()
  @IsBoolean()
  aiDictation: boolean;

  @IsOptional()
  @IsBoolean()
  aiDictationStreaming: boolean;

  // Workspace master toggle that enables/disables the HTML embed block type.
  // Persisted at settings.htmlEmbed. ABSENT/false => OFF (default). The block
  // itself renders in a sandboxed iframe, so this is a feature switch, not a
  // security gate.
  @IsOptional()
  @IsBoolean()
  htmlEmbed: boolean;

  // Admin-only analytics/tracker snippet (raw HTML/JS) injected verbatim into
  // the <head> of PUBLIC SHARE pages only (same-origin). Persisted at
  // settings.trackerHead. Admin-authored trusted content.
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  trackerHead?: string;

  @IsOptional()
  @IsBoolean()
  aiPublicShareAssistant: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  trashRetentionDays: number;

  // Default lifetime for new temporary notes, in HOURS. Frozen per-note at
  // creation, so changing this never reschedules existing notes.
  @IsOptional()
  @IsInt()
  @Min(1)
  temporaryNoteHours: number;

  @IsOptional()
  @IsBoolean()
  allowMemberTemplates: boolean;
}
