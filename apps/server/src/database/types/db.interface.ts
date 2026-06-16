import { DB } from '@docmost/db/types/db';
import { PageEmbeddings } from '@docmost/db/types/embeddings.types';
import { AiProviderCredentials } from '@docmost/db/types/ai-provider-credentials.types';

export interface DbInterface extends DB {
  pageEmbeddings: PageEmbeddings;
  aiProviderCredentials: AiProviderCredentials;
}
