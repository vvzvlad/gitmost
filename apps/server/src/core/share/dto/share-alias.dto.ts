import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

/**
 * Create/retarget a vanity alias for a page. `confirmReassign` is the
 * two-step guard for the "address already points at another page" case: the
 * first call without it gets a 409 carrying the current target, the client
 * confirms, and retries with `confirmReassign: true`.
 */
export class SetShareAliasDto {
  @IsString()
  @IsNotEmpty()
  pageId: string;

  @IsString()
  @IsNotEmpty()
  alias: string;

  @IsBoolean()
  @IsOptional()
  confirmReassign?: boolean;
}

export class RemoveShareAliasDto {
  @IsString()
  @IsNotEmpty()
  aliasId: string;
}

export class ShareAliasAvailabilityDto {
  @IsString()
  @IsNotEmpty()
  alias: string;
}

export class ShareAliasForPageDto {
  @IsString()
  @IsNotEmpty()
  pageId: string;
}
