import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Identify a chat by id (workspace-scoped on the server). */
export class ChatIdDto {
  @IsString()
  chatId: string;
}

/** Rename a chat. */
export class RenameChatDto {
  @IsString()
  chatId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  title: string;
}

/** Optional chat id for listing messages of a specific chat. */
export class GetChatMessagesDto {
  @IsString()
  chatId: string;

  @IsOptional()
  @IsString()
  cursor?: string;
}
