import { AiSettingsController } from './ai-settings.controller';
import { AiService } from './ai.service';
import { AiSettingsService } from './ai-settings.service';
import { AiEmbeddingNotConfiguredException } from './ai-embedding-not-configured.exception';
import WorkspaceAbilityFactory from '../../core/casl/abilities/workspace-ability.factory';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { UpdateAiSettingsDto } from './dto/update-ai-settings.dto';

/**
 * #599 (R1) — changing the embedding config must AUTO-ENQUEUE the reindex.
 *
 * The fingerprint (model + revision + prefix scheme + dimensions) is what both
 * readers filter by, and the D2 guard drops the vector arm entirely while the active
 * generation's model differs from the configured one. So an admin who switches the
 * embedding model used to lose semantic search in BOTH search and RAG — silently,
 * and INDEFINITELY, until a human happened to click "Reindex now". Nothing else
 * enqueued the run.
 *
 * The flip side matters just as much: a full re-embed of a workspace is expensive
 * and provider-billed, so an edit that does NOT move the fingerprint (an API-key
 * rotation, a chat-model change, a system-prompt tweak) must enqueue NOTHING.
 */

const WS = { id: 'ws-1' } as unknown as Workspace;
const USER = { id: 'u-1' } as unknown as User;

function makeController(opts: {
  /** Fingerprint before the write, then after it. `null` = no provider resolves. */
  fingerprints: (string | null)[];
}) {
  const seq = [...opts.fingerprints];
  const aiService = {
    resolveEmbeddingProvider: jest.fn(async () => {
      const fp = seq.shift();
      if (fp == null) throw new AiEmbeddingNotConfiguredException();
      return { fingerprint: fp, modelId: 'm' };
    }),
  };

  const aiSettingsService = {
    update: jest.fn(async () => ({ driver: 'openai' })),
    getMasked: jest.fn(async () => ({ driver: 'openai', reindexing: true })),
    reindex: jest.fn(async () => undefined),
  };

  const workspaceAbility = {
    createForUser: () => ({ cannot: () => false }),
  };

  const controller = new AiSettingsController(
    aiService as unknown as AiService,
    aiSettingsService as unknown as AiSettingsService,
    workspaceAbility as unknown as WorkspaceAbilityFactory,
  );
  return { controller, aiService, aiSettingsService };
}

const dto = (patch: Partial<UpdateAiSettingsDto>) =>
  patch as UpdateAiSettingsDto;

describe('AiSettingsController.updateSettings — auto-reindex on a fingerprint change (#599 R1)', () => {
  it('changing the embedding MODEL enqueues exactly ONE reindex, for the new fingerprint', async () => {
    const { controller, aiSettingsService } = makeController({
      fingerprints: ['fp-e5', 'fp-bge'],
    });

    await controller.updateSettings(
      dto({ embeddingModel: 'bge-base-en' }),
      USER,
      WS,
    );

    // NON-VACUITY: drop the enqueue and this is 0 — which is exactly the bug: the
    // model changed, the D2 guard turns the vector arm off (the active generation
    // lives in another embedding space), and NOTHING would ever rebuild the index.
    expect(aiSettingsService.reindex).toHaveBeenCalledTimes(1);
    expect(aiSettingsService.reindex).toHaveBeenCalledWith('ws-1');
    // The settings write happens BEFORE the enqueue, so the run the worker picks up
    // resolves the NEW config -> it targets the new fingerprint.
    expect(aiSettingsService.update).toHaveBeenCalledTimes(1);
    const updateOrder = aiSettingsService.update.mock.invocationCallOrder[0];
    const reindexOrder = aiSettingsService.reindex.mock.invocationCallOrder[0];
    expect(updateOrder).toBeLessThan(reindexOrder);
  });

  it('an UNRELATED settings edit (API-key rotation) enqueues NO reindex', async () => {
    const { controller, aiSettingsService } = makeController({
      // The key is not part of the fingerprint: same fp before and after.
      fingerprints: ['fp-e5', 'fp-e5'],
    });

    await controller.updateSettings(
      dto({ apiKey: 'sk-new-key', chatModel: 'gpt-4o', systemPrompt: 'hi' }),
      USER,
      WS,
    );

    // A full re-embed is expensive and provider-billed; the stored generation is
    // still perfectly valid here.
    expect(aiSettingsService.reindex).not.toHaveBeenCalled();
  });

  it('enqueues when the workspace goes from NO embedding provider to a configured one', async () => {
    const { controller, aiSettingsService } = makeController({
      fingerprints: [null, 'fp-e5'],
    });

    await controller.updateSettings(
      dto({ driver: 'openai', embeddingModel: 'text-embedding-3-small' }),
      USER,
      WS,
    );

    expect(aiSettingsService.reindex).toHaveBeenCalledTimes(1);
  });

  it('does NOT enqueue when the change leaves the workspace with no embedding provider', async () => {
    const { controller, aiSettingsService } = makeController({
      fingerprints: ['fp-e5', null],
    });

    await controller.updateSettings(dto({ embeddingModel: '' }), USER, WS);

    // Nothing to index against: the job would only no-op.
    expect(aiSettingsService.reindex).not.toHaveBeenCalled();
  });

  it('a FAILED enqueue does not fail the settings write (they are already persisted)', async () => {
    const { controller, aiSettingsService } = makeController({
      fingerprints: ['fp-e5', 'fp-bge'],
    });
    aiSettingsService.reindex.mockRejectedValue(new Error('redis down'));

    await expect(
      controller.updateSettings(
        dto({ embeddingModel: 'bge-base-en' }),
        USER,
        WS,
      ),
    ).resolves.toMatchObject({ driver: 'openai' });
  });
});
