import {
  IsString,
  IsOptional,
  MaxLength,
  Matches,
  IsNotEmpty,
} from 'class-validator';

export class MovePageDto {
  @IsString()
  pageId: string;

  // `position` is a fractional-indexing key from `generateJitteredKeyBetween`
  // (the SAME generator page.service uses). Validate by CHARSET, not length: the
  // generator's default base-62 alphabet is [0-9A-Za-z], and DENSE between-inserts
  // legitimately grow a key well past a dozen chars (measured >40), so the old
  // @MinLength(5)/@MaxLength(12) bounds wrongly 400'd valid ordering keys the
  // server itself produced (Gitea #139 item 6). The charset regex rejects control
  // chars / separators / injection, and a generous MaxLength stays only as a
  // DoS guard — far above any realistic key, so it never rejects a real move.
  @IsString()
  @Matches(/^[0-9A-Za-z]+$/, {
    message: 'position must be a fractional-index key ([0-9A-Za-z])',
  })
  @MaxLength(256)
  position: string;

  @IsOptional()
  @IsString()
  parentPageId?: string | null;
}

export class MovePageToSpaceDto {
  @IsNotEmpty()
  @IsString()
  pageId: string;

  @IsNotEmpty()
  @IsString()
  spaceId: string;
}
