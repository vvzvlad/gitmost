import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class SearchDTO {
  // Defense-in-depth cap on the raw query length. The real stack-depth bound is
  // the parser's MAX_PARSED_TERMS term cap (see search-query-parser.ts); this
  // just rejects absurd payloads early. 10k chars still comfortably holds any
  // legitimate query.
  @IsNotEmpty()
  @IsString()
  @MaxLength(10000)
  query: string;

  // #529 A3 — match mode. `auto` (default) routes identifier-like terms
  // (192.0.2, esp32, WB-MGE-30D86B) to the substring/trigram branch and words
  // to full-text; `word`/`prefix`/`substring` are explicit overrides.
  @IsOptional()
  @IsIn(['auto', 'word', 'prefix', 'substring'])
  match?: 'auto' | 'word' | 'prefix' | 'substring';

  @IsOptional()
  @IsString()
  spaceId: string;

  @IsOptional()
  @IsString()
  shareId?: string;

  @IsOptional()
  @IsString()
  creatorId?: string;

  @IsOptional()
  @IsNumber()
  limit?: number;

  @IsOptional()
  @IsNumber()
  offset?: number;

  // --- Opt-in agent-lookup mode (#443). ------------------------------------
  // These fields are ADDITIVE and default-off: a web client that sends none of
  // them gets byte-identical FTS behaviour and result shape. In the unified #529
  // engine, `parentPageId` and `titleOnly` are read by SearchService.searchPage
  // (subtree scoping and title-only matching, respectively). `substring` is NOT
  // read by the native driver — it is accepted-but-ignored, kept only for
  // back-compat with the upstream lookup request shape.
  //
  // NOTE (standalone stdio vs stock upstream): stock upstream validates this DTO
  // with `whitelist: true`, so an older server silently strips these unknown
  // fields and the request degrades gracefully to the plain FTS behaviour.

  // Accepted-but-ignored by the #529 native driver (kept for upstream lookup
  // back-compat). The unified engine ALWAYS runs the hybrid FTS + substring/
  // trigram branches with tiered ranking, so this flag no longer toggles anything.
  @IsOptional()
  @IsBoolean()
  substring?: boolean;

  // Restrict the search to a page and all of its descendants (inclusive).
  @IsOptional()
  @IsString()
  parentPageId?: string;

  // Match titles only; do not scan text_content.
  @IsOptional()
  @IsBoolean()
  titleOnly?: boolean;
}

export class SearchShareDTO extends SearchDTO {
  @IsNotEmpty()
  @IsString()
  shareId: string;

  @IsOptional()
  @IsString()
  spaceId: string;
}

export class SearchSuggestionDTO {
  @IsString()
  query: string;

  @IsOptional()
  @IsBoolean()
  includeUsers?: boolean;

  @IsOptional()
  @IsBoolean()
  includeGroups?: boolean;

  @IsOptional()
  @IsBoolean()
  includePages?: boolean;

  @IsOptional()
  @IsBoolean()
  onlyTemplates?: boolean;

  @IsOptional()
  @IsString()
  spaceId?: string;

  @IsOptional()
  @IsNumber()
  limit?: number;
}
