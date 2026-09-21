import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

/**
 * #496: after the MCP client anchors a suggestion in the LIVE collab doc, it
 * re-reads the exact substring under the new mark and syncs it here as the
 * comment's stored `selection` (== apply-time expectedText). Fixes the perpetual
 * 409 where expectedText came from a debounced REST snapshot while the mark sat
 * in the live doc.
 */
export class ResyncSuggestionAnchorDto {
  @IsUUID()
  commentId: string;

  // The raw substring the mark now covers in the live document. Bounded like the
  // create-time selection (2000) so a legitimate anchored span is never cut.
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  selection: string;
}
