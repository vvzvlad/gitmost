import {
  IsIn,
  IsJSON,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { z } from 'zod';

const yjsIdSchema = z.object({
  client: z.number().int().nonnegative(),
  clock: z.number().int().nonnegative(),
});

const yjsRelativePositionSchema = z.object({
  type: yjsIdSchema,
  tname: z.string().nullable(),
  item: yjsIdSchema.nullable(),
  assoc: z.number().int(),
});

export const yjsSelectionSchema = z.object({
  anchor: yjsRelativePositionSchema,
  head: yjsRelativePositionSchema,
});

export class CreateCommentDto {
  @IsString()
  pageId: string;

  @IsJSON()
  content: any;

  // The agent tool caps what it TYPES at 250 chars, but for a suggestion the
  // client resolves and sends the RAW anchored document substring (the exact
  // text under the mark), which can be longer once normalization is undone. Bound
  // the stored value at 2000 (matching suggestedText) so a legitimate anchored
  // substring is never rejected — the service used to lossily truncate at 250,
  // which broke the apply-time equality check.
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  selection: string;

  @IsOptional()
  @IsIn(['inline', 'page'])
  type: string;

  @IsOptional()
  @IsUUID()
  parentCommentId: string;

  @IsOptional()
  @IsObject()
  yjsSelection?: {
    anchor: any;
    head: any;
  };

  // Optional suggested replacement for the selected text (a "suggested edit").
  // Only valid on a top-level inline comment that carries a non-empty selection;
  // enforced in CommentService.create.
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  suggestedText?: string;
}
