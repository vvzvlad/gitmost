import { ServiceUnavailableException } from '@nestjs/common';

/**
 * Thrown when no usable embedding config exists for the workspace (missing
 * driver / embedding model / API key). Distinct from the chat variant so RAG
 * callers (indexer / semanticSearch) can 503 or skip independently of chat
 * being configured (§6.2/§6.7).
 */
export class AiEmbeddingNotConfiguredException extends ServiceUnavailableException {
  constructor() {
    super('AI embedding model not configured');
  }
}
