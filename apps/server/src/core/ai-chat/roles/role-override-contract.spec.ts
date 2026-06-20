import { AiService } from '../../../integrations/ai/ai.service';
import { AiNotConfiguredException } from '../../../integrations/ai/ai-not-configured.exception';
import { roleModelOverride } from './role-model-config';
import type { AiAgentRole } from '@docmost/db/types/entity.types';

/**
 * Contract test for the override SHAPE that travels from a role's persisted
 * `model_config` (via roleModelOverride) into AiService.getChatModel.
 *
 * This is the seam between the two halves of the role-model feature:
 *  - roleModelOverride (pure) turns model_config into a ChatModelOverride;
 *  - getChatModel consumes that override to build the model (or to 503).
 * Wiring the REAL roleModelOverride output into a unit-constructed AiService
 * (with stubbed deps, no DB) pins that the two agree on the override contract:
 *  - a cross-driver override whose creds are absent => AiNotConfiguredException
 *    naming the role + driver;
 *  - a chatModel-only override keeps the workspace driver/creds (no creds
 *    lookup, no decrypt);
 *  - an ollama cross-driver override => 503 (no silent baseUrl reuse).
 */
describe('role override -> AiService.getChatModel contract', () => {
  function role(modelConfig: unknown, name = 'Researcher'): AiAgentRole {
    return { id: 'r1', name, modelConfig } as unknown as AiAgentRole;
  }

  function makeService(opts: {
    workspaceDriver: string;
    baseUrl?: string;
    credsApiKeyEnc?: string;
  }) {
    const aiSettings = {
      resolve: jest.fn().mockResolvedValue({
        driver: opts.workspaceDriver,
        chatModel: 'gpt-4o-mini',
        apiKey: 'workspace-key',
        baseUrl: opts.baseUrl,
      }),
    };
    const aiProviderCredentialsRepo = {
      find: jest
        .fn()
        .mockResolvedValue(
          opts.credsApiKeyEnc ? { apiKeyEnc: opts.credsApiKeyEnc } : undefined,
        ),
    };
    const secretBox = { decryptSecret: jest.fn().mockReturnValue('decrypted') };
    const service = new AiService(
      aiSettings as never,
      aiProviderCredentialsRepo as never,
      secretBox as never,
    );
    return { service, aiSettings, aiProviderCredentialsRepo, secretBox };
  }

  it('cross-driver override with NO creds => 503 naming the role and the override driver', async () => {
    const override = roleModelOverride(
      role({ driver: 'gemini', chatModel: 'gemini-2.0-flash' }),
    );
    expect(override).toEqual({
      driver: 'gemini',
      chatModel: 'gemini-2.0-flash',
      roleName: 'Researcher',
    });

    // Workspace is openai; the gemini override has no configured creds.
    const { service, aiProviderCredentialsRepo } = makeService({
      workspaceDriver: 'openai',
    });

    await service.getChatModel('ws-1', override).then(
      () => {
        throw new Error('expected getChatModel to throw');
      },
      (err: unknown) => {
        expect(err).toBeInstanceOf(AiNotConfiguredException);
        const message = (err as AiNotConfiguredException).message;
        expect(message).toContain('gemini');
        expect(message).toContain('Researcher');
      },
    );
    expect(aiProviderCredentialsRepo.find).toHaveBeenCalledWith('ws-1', 'gemini');
  });

  it('chatModel-only override keeps the workspace driver/creds (no creds lookup, no decrypt)', async () => {
    const override = roleModelOverride(role({ chatModel: 'gpt-4o' }));
    // No driver in the override => the workspace driver/creds are reused.
    expect(override).toEqual({
      driver: undefined,
      chatModel: 'gpt-4o',
      roleName: 'Researcher',
    });

    const { service, aiProviderCredentialsRepo, secretBox } = makeService({
      workspaceDriver: 'openai',
    });

    const model = await service.getChatModel('ws-1', override);
    expect(model).toBeDefined();
    expect(aiProviderCredentialsRepo.find).not.toHaveBeenCalled();
    expect(secretBox.decryptSecret).not.toHaveBeenCalled();
  });

  it('ollama cross-driver override (workspace driver != ollama) => 503, no baseUrl reuse', async () => {
    const override = roleModelOverride(
      role({ driver: 'ollama', chatModel: 'llama3' }, 'Local'),
    );
    expect(override).toEqual({
      driver: 'ollama',
      chatModel: 'llama3',
      roleName: 'Local',
    });

    const { service, aiProviderCredentialsRepo } = makeService({
      workspaceDriver: 'openai',
      baseUrl: 'https://openrouter.example/v1',
    });

    await service.getChatModel('ws-1', override).then(
      () => {
        throw new Error('expected getChatModel to throw');
      },
      (err: unknown) => {
        expect(err).toBeInstanceOf(AiNotConfiguredException);
        const message = (err as AiNotConfiguredException).message;
        expect(message).toContain('ollama');
        expect(message).toContain('openai');
        expect(message).toContain('Local');
        // The workspace gateway baseUrl must never be reused for ollama.
        expect(message).not.toContain('openrouter.example');
      },
    );
    // No creds lookup for ollama: we fail before reaching the creds branch.
    expect(aiProviderCredentialsRepo.find).not.toHaveBeenCalled();
  });
});
