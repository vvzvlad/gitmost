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

/** One-shot page-title generation from note content (#199). */
export class GeneratePageTitleDto {
  // Note body as markdown/plain text. Capped to bound the prompt cost and
  // reject abusive payloads; the service truncates again before the model call.
  @IsString()
  @MinLength(1)
  @MaxLength(20000)
  content: string;
}

/** Optional chat id for listing messages of a specific chat. */
export class GetChatMessagesDto {
  @IsString()
  chatId: string;

  @IsOptional()
  @IsString()
  cursor?: string;
}

/** Resolve the chat bound to a document (the page's most-recent owned chat). */
export class BoundChatDto {
  @IsString()
  pageId: string;
}

/** Export a chat to Markdown (#183). `lang` localizes the few fixed
 *  role/tool-action labels; defaults to English server-side. */
export class ExportChatDto {
  @IsString()
  chatId: string;

  // A full client locale tag (e.g. 'en-US', 'ru-RU') — normalized server-side to
  // a supported export language (see normalizeLang). Accept any string so a
  // region-qualified locale is not rejected (the 400 that broke the real client).
  @IsOptional()
  @IsString()
  lang?: string;
}
