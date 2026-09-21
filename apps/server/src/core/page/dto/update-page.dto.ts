import { PartialType } from '@nestjs/mapped-types';
import { CreatePageDto, ContentFormat } from './create-page.dto';
import { IsIn, IsOptional, IsString, ValidateIf } from 'class-validator';
import { Transform } from 'class-transformer';

export type ContentOperation = 'append' | 'prepend' | 'replace';

export class UpdatePageDto extends PartialType(CreatePageDto) {
  @IsString()
  pageId: string;

  @IsOptional()
  content?: string | object;

  @ValidateIf((o) => o.content !== undefined)
  @Transform(({ value }) => value?.toLowerCase())
  @IsIn(['append', 'prepend', 'replace'])
  operation?: ContentOperation;

  @ValidateIf((o) => o.content !== undefined)
  @Transform(({ value }) => value?.toLowerCase() ?? 'json')
  @IsIn(['json', 'markdown', 'html'])
  format?: ContentFormat;

  // #647 §D — optional server-side write-CAS base hash. When present on a
  // `replace`, `/pages/update` routes the write through `replaceIfMatch`: the
  // body is applied only if the authoritative live doc still hashes to this
  // value, else HTTP 409 + `currentHash`. Absent → the prior unguarded replace
  // (back-compat). The MCP `updatePageJson`/`updatePageMarkdown` tools always
  // send it (mandatory client-side); other callers may omit it.
  @IsOptional()
  @IsString()
  baseHash?: string;
}
