import { IsUUID } from 'class-validator';

export class ApplySuggestionDto {
  @IsUUID()
  commentId: string;
}
