import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';

export type ContentFormat = 'json' | 'markdown' | 'html';

// READ-only rendering formats for `getPage` (#502). A superset of the writable
// `ContentFormat` with `text` — a flat, deterministic, machine-diffable text
// rendering — added. Kept SEPARATE from `ContentFormat` so the write path
// (createPage/updatePage `parseProsemirrorContent`) can never be handed `text`.
export type PageReadFormat = ContentFormat | 'text';

export class CreatePageDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  icon?: string;

  @IsOptional()
  @IsString()
  parentPageId?: string;

  @IsUUID()
  spaceId: string;

  @IsOptional()
  content?: string | object;

  @ValidateIf((o) => o.content !== undefined)
  @Transform(({ value }) => value?.toLowerCase() ?? 'json')
  @IsIn(['json', 'markdown', 'html'])
  format?: ContentFormat;

  // When true, create the page as a temporary note: arm its death timer
  // (now + workspace temporaryNoteHours) at creation.
  @IsOptional()
  @IsBoolean()
  temporary?: boolean;
}
