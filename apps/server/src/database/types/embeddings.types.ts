import { Json, Timestamp, Generated } from '@docmost/db/types/db';

// embeddings type
export interface PageEmbeddings {
  id: Generated<string>;
  pageId: string;
  spaceId: string;
  modelName: string;
  modelDimensions: number;
  workspaceId: string;
  // Nullable: page-body embeddings have no attachment (only attachment chunks set it).
  attachmentId: string | null;
  embedding: number[];
  chunkIndex: Generated<number>;
  chunkStart: Generated<number>;
  chunkLength: Generated<number>;
  // The chunk text that produced the embedding (NOT NULL in the table).
  content: string;
  metadata: Generated<Json>;
  createdAt: Generated<Timestamp>;
  updatedAt: Generated<Timestamp>;
  deletedAt: Timestamp | null;
}
