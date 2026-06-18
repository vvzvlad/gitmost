import { Timestamp, Generated } from '@docmost/db/types/db';

// ai_provider_credentials type
// Hand-written (not generated) because codegen requires a live DB.
// Mirrors the migration 20260616T120000-ai-provider-credentials.ts.
//
// SECURITY (D9/§8.1): this table holds encrypted per-workspace provider
// API keys. It must NEVER be added to workspace `baseFields` or returned by
// any workspace endpoint.
export interface AiProviderCredentials {
  id: Generated<string>;
  workspaceId: string;
  driver: string;
  apiKeyEnc: string | null;
  // Encrypted, embedding-specific provider key. Falls back to apiKeyEnc when null.
  embeddingApiKeyEnc: string | null;
  // Encrypted, STT-specific provider key. Falls back to apiKeyEnc when null.
  sttApiKeyEnc: string | null;
  createdAt: Generated<Timestamp>;
  updatedAt: Generated<Timestamp>;
}
