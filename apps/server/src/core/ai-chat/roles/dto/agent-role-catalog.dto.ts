import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

/** Safe identifier shape for any catalog path segment (bundleId / language).
 *  Mirrors SEGMENT_RE in the catalog provider — the path-traversal/SSRF guard
 *  is enforced both at the API boundary (here) and in the provider. */
const SEGMENT_RE = /^[a-z0-9-]+$/;

/** Browse the catalog, optionally localized to `language` (defaults applied in
 *  the service: fall back to 'en', then the first available language). */
export class CatalogQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(16)
  language?: string;
}

/** Open one catalog bundle in a specific language. */
export class CatalogBundleDto {
  @IsString()
  @Matches(SEGMENT_RE)
  bundleId: string;

  @IsString()
  @Matches(SEGMENT_RE)
  language: string;
}

/** Import roles from a catalog bundle into the workspace. */
export class ImportFromCatalogDto {
  @IsString()
  @Matches(SEGMENT_RE)
  bundleId: string;

  @IsString()
  @Matches(SEGMENT_RE)
  language: string;

  // Omitted => import the whole bundle; otherwise only these slugs.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  slugs?: string[];

  // How to handle a name collision with an existing (non-catalog) role:
  // 'skip' leaves it; 'rename' imports under a free " (N)" name.
  @IsIn(['skip', 'rename'])
  conflict: 'skip' | 'rename';
}

/** Update an already-imported role from its catalog source. */
export class UpdateFromCatalogDto {
  @IsUUID()
  id: string;
}
