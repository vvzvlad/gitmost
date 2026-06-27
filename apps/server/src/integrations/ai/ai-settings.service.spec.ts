import { AiSettingsService, parsePositiveInt } from './ai-settings.service';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { AiAgentRoleRepo } from '@docmost/db/repos/ai-agent-roles/ai-agent-roles.repo';
import { AiProviderCredentialsRepo } from '@docmost/db/repos/ai-chat/ai-provider-credentials.repo';
import { PageEmbeddingRepo } from '@docmost/db/repos/ai-chat/page-embedding.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SecretBoxService } from '../crypto/secret-box';
import { EmbeddingReindexProgressService } from './embedding-reindex-progress.service';
import type { Queue } from 'bullmq';

/**
 * Round-trip coercion for numeric `::text` provider settings (e.g.
 * chatContextWindow). Values are stored as text and read back as strings, so
 * this guards the read path the DTO write-validation does not cover: a silent
 * loss of `Math.floor` or a `> 0` → `>= 0` drift would otherwise go unnoticed.
 */
describe('parsePositiveInt', () => {
  it('keeps a valid positive integer string', () => {
    expect(parsePositiveInt('200000')).toBe(200000);
  });

  it('floors a fractional string', () => {
    expect(parsePositiveInt('1.9')).toBe(1);
    expect(parsePositiveInt('1.0')).toBe(1);
  });

  it('returns undefined for zero', () => {
    expect(parsePositiveInt('0')).toBeUndefined();
  });

  it('returns undefined for a negative value', () => {
    expect(parsePositiveInt('-5')).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    expect(parsePositiveInt('')).toBeUndefined();
  });

  it('returns undefined for a non-numeric string', () => {
    expect(parsePositiveInt('abc')).toBeUndefined();
  });

  it('returns undefined for undefined / null', () => {
    expect(parsePositiveInt(undefined)).toBeUndefined();
    expect(parsePositiveInt(null)).toBeUndefined();
  });

  it('accepts a real number too (not only ::text strings)', () => {
    expect(parsePositiveInt(42)).toBe(42);
  });
});

/**
 * getMasked must surface the LIVE reindex run progress while a reindex is active
 * (so the "Indexed X of Y" counter can climb 0 -> total), and fall back to the
 * steady-state DB coverage count (countIndexedPages / countEmbeddablePages) when
 * no reindex is running. This is the server side of the fix for the counter that
 * otherwise stays stuck at "478 of 478" the whole reindex.
 */
describe('AiSettingsService.getMasked reindex progress', () => {
  const WORKSPACE_ID = 'ws-1';

  function makeService() {
    // No driver configured -> the credentials lookup is skipped, keeping the
    // setup minimal; we only care about the indexed/total numbers here.
    const workspaceRepo = {
      findById: jest.fn().mockResolvedValue({ settings: {} }),
    };
    const aiAgentRoleRepo = {};
    const aiProviderCredentialsRepo = { find: jest.fn() };
    const pageEmbeddingRepo = {
      countIndexedPages: jest.fn().mockResolvedValue(478),
    };
    const pageRepo = {
      countEmbeddablePages: jest.fn().mockResolvedValue(478),
    };
    const secretBox = {};
    const reindexProgress = {
      get: jest.fn().mockResolvedValue(null),
    };
    const aiQueue = {};

    const service = new AiSettingsService(
      workspaceRepo as unknown as WorkspaceRepo,
      aiAgentRoleRepo as unknown as AiAgentRoleRepo,
      aiProviderCredentialsRepo as unknown as AiProviderCredentialsRepo,
      pageEmbeddingRepo as unknown as PageEmbeddingRepo,
      pageRepo as unknown as PageRepo,
      secretBox as unknown as SecretBoxService,
      reindexProgress as unknown as EmbeddingReindexProgressService,
      aiQueue as unknown as Queue,
    );
    return { service, reindexProgress, pageEmbeddingRepo };
  }

  it('reports the live run numbers when a reindex progress record is active', async () => {
    const { service, reindexProgress } = makeService();
    // Mid-run: 120 of 478 pages processed.
    reindexProgress.get.mockResolvedValue({
      total: 478,
      done: 120,
      startedAt: Date.now(),
    });

    const masked = await service.getMasked(WORKSPACE_ID);

    expect(masked.indexedPages).toBe(120);
    expect(masked.totalPages).toBe(478);
    expect(masked.reindexing).toBe(true);
  });

  it('falls back to countIndexedPages when no reindex is active', async () => {
    const { service, reindexProgress } = makeService();
    reindexProgress.get.mockResolvedValue(null);

    const masked = await service.getMasked(WORKSPACE_ID);

    expect(masked.indexedPages).toBe(478);
    expect(masked.totalPages).toBe(478);
    expect(masked.reindexing).toBe(false);
  });
});
