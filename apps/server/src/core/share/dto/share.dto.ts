import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { PublishedMode } from '../published-mode.constants';

export class CreateShareDto {
  @IsString()
  @IsNotEmpty()
  pageId: string;

  @IsBoolean()
  @IsOptional()
  includeSubPages: boolean;

  @IsOptional()
  @IsBoolean()
  searchIndexing: boolean;

  // #370 Stage B — publication mode. 'live' (default) serves the current draft;
  // 'approved' serves the last manually-saved version (page_history.kind
  // ='manual'). Mutually exclusive with includeSubPages (enforced server-side).
  @IsOptional()
  @IsIn(['live', 'approved'])
  publishedMode?: PublishedMode;
}

export class UpdateShareDto extends CreateShareDto {
  @IsString()
  @IsNotEmpty()
  shareId: string;

  @IsString()
  @IsOptional()
  pageId: string;
}

export class ShareIdDto {
  @IsString()
  @IsNotEmpty()
  shareId: string;
}

export class SpaceIdDto {
  @IsUUID()
  spaceId: string;
}

export class ShareInfoDto {
  @IsString()
  @IsOptional()
  shareId?: string;

  @IsString()
  @IsOptional()
  pageId: string;
}

export class SharePageIdDto {
  @IsString()
  @IsNotEmpty()
  pageId: string;
}
