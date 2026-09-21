import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

import { PageReadFormat } from './create-page.dto';
import { IsPageIdOrSlugId } from './page-identity.validator';

export class PageIdDto {
  @IsString()
  @IsNotEmpty()
  // Format-validate the double identity (#435): accept only a page UUID or a
  // 10-char slugId so a malformed / swapped identity is rejected at the boundary
  // rather than passed to the repo as a bare string. Base for PageInfoDto,
  // DeletePageDto, BacklinksListDto, AddLabelsDto/RemoveLabelDto, etc.
  @IsPageIdOrSlugId()
  pageId: string;
}

export class SpaceIdDto {
  @IsUUID()
  spaceId: string;
}

export class PageHistoryIdDto {
  @IsUUID()
  historyId: string;
}

export class PageInfoDto extends PageIdDto {
  @IsOptional()
  @IsBoolean()
  includeSpace: boolean;

  @IsOptional()
  @IsBoolean()
  includeContent: boolean;

  // #647 §E / R2 — opt-in ONLY (set by getPage/getPageJson). When true, the
  // response carries a `contentHash` computed COHERENTLY with the returned
  // content (live when the doc is loaded, else a transient ydoc reconstruction),
  // and the returned `content` is that same live-when-loaded materialization —
  // the base hash for a guarded-replace and the cache key that gives getPage
  // read-your-own-writes. Every OTHER reader omits it and keeps the cheap path
  // (no hash, no live read).
  @IsOptional()
  @IsBoolean()
  includeContentHash?: boolean;

  // #654 §Server — opt-in read-your-own-writes hint for the structural read
  // tools (getOutline/getNode/searchInPage/getTable). Set ONLY by the MCP client
  // for a page it just wrote to. When true the handler resolves the LIVE content
  // via the non-claiming `readLiveIfLoaded` primitive (#647) so the returned
  // `content` reflects an acked-but-not-yet-flushed edit instead of the
  // debounce-stale DB row; it always fails open to the DB row (never an error).
  // The response then carries sibling `contentSource`/`fallbackReason` fields.
  // Every other reader omits it and keeps the cheap path (no owner probe).
  @IsOptional()
  @IsBoolean()
  preferLive?: boolean;

  @IsOptional()
  @Transform(({ value }) => value?.toLowerCase())
  @IsIn(['json', 'markdown', 'html', 'text'])
  format?: PageReadFormat;
}

export class PageWorkTimeDto extends PageIdDto {
  // Viewer IANA timezone for the per-day punch-card buckets (§6.3). Optional —
  // falls back to UTC server-side. Length-capped so a bogus value cannot bloat
  // the request; the value is only ever handed to Intl.DateTimeFormat, which
  // throws on an unknown zone (caught by the controller → 400).
  @IsOptional()
  @IsString()
  @MaxLength(64)
  tz?: string;
}

export class PageHistoryDayCountsDto extends PageIdDto {
  // #568 — viewer IANA timezone the revisions-per-day heatmap is bucketed in.
  // Optional (falls back to UTC server-side); length-capped so a bogus value
  // cannot bloat the request. The value only ever reaches Intl.DateTimeFormat,
  // which throws on an unknown zone (caught by the controller → 400).
  @IsOptional()
  @IsString()
  @MaxLength(64)
  tz?: string;
}

export class DeletePageDto extends PageIdDto {
  @IsOptional()
  @IsBoolean()
  permanentlyDelete?: boolean;
}
