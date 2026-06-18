import { IsIn, IsOptional } from 'class-validator';

// Body for POST /workspace/ai-settings/test. Selects which endpoint to probe;
// defaults to the chat endpoint server-side when omitted.
export class TestAiConnectionDto {
  @IsOptional()
  @IsIn(['chat', 'embeddings'])
  capability?: 'chat' | 'embeddings';
}
