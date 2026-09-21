import { IsUUID } from 'class-validator';

export class DismissSuggestionDto {
  @IsUUID()
  commentId: string;
}
