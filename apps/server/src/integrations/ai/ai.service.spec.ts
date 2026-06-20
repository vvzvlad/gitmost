import { AiService } from './ai.service';
import { AiNotConfiguredException } from './ai-not-configured.exception';

/**
 * Unit test for the role model-override 503 path of AiService.getChatModel.
 *
 * AiService's constructor body is trivial (it only stores its deps), so it can
 * be unit-constructed with stubbed collaborators — no Nest module graph, which
 * the src-rooted jest setup cannot fully resolve for the heavier specs. We stub:
 *  - aiSettings.resolve  -> a workspace configured for openai (so cfg.driver is
 *    set and we pass the first guard),
 *  - aiProviderCredentialsRepo.find -> undefined (the override driver has NO
 *    configured credentials),
 *  - secretBox -> unused on this path (no creds to decrypt).
 *
 * With a role override pointing at a DIFFERENT driver ('gemini') that has no
 * creds, getChatModel must throw AiNotConfiguredException (503) and the message
 * must name the override driver (and the role) so an admin can fix it.
 */
describe('AiService.getChatModel role model override', () => {
  function makeService(opts: {
    workspaceDriver: string;
    credsApiKeyEnc?: string;
  }) {
    const aiSettings = {
      resolve: jest.fn().mockResolvedValue({
        driver: opts.workspaceDriver,
        chatModel: 'gpt-4o-mini',
        apiKey: 'workspace-key',
        baseUrl: undefined,
      }),
    };
    const aiProviderCredentialsRepo = {
      find: jest.fn().mockResolvedValue(
        opts.credsApiKeyEnc ? { apiKeyEnc: opts.credsApiKeyEnc } : undefined,
      ),
    };
    const secretBox = {
      decryptSecret: jest.fn().mockReturnValue('decrypted'),
    };
    const service = new AiService(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aiSettings as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aiProviderCredentialsRepo as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      secretBox as any,
    );
    return { service, aiSettings, aiProviderCredentialsRepo, secretBox };
  }

  it('throws AiNotConfiguredException (503) naming the override driver when its creds are missing', async () => {
    const { service, aiProviderCredentialsRepo } = makeService({
      workspaceDriver: 'openai',
    });

    await expect(
      service.getChatModel('ws-1', {
        driver: 'gemini',
        chatModel: 'gemini-2.0-flash',
        roleName: 'Researcher',
      }),
    ).rejects.toBeInstanceOf(AiNotConfiguredException);

    // Re-run to assert the message names the driver (and role) for the admin.
    await service
      .getChatModel('ws-1', {
        driver: 'gemini',
        chatModel: 'gemini-2.0-flash',
        roleName: 'Researcher',
      })
      .then(
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

    // The override driver's creds were looked up for the right driver.
    expect(aiProviderCredentialsRepo.find).toHaveBeenCalledWith('ws-1', 'gemini');
  });

  it('cross-driver override with creds present: resolves without throwing, using the OVERRIDE driver creds', async () => {
    // Workspace driver is openai; the role overrides to gemini, which HAS creds.
    const { service, aiProviderCredentialsRepo, secretBox } = makeService({
      workspaceDriver: 'openai',
      credsApiKeyEnc: 'enc-gemini-key',
    });

    const model = await service.getChatModel('ws-1', {
      driver: 'gemini',
      chatModel: 'gemini-2.0-flash',
      roleName: 'Researcher',
    });

    // A real LanguageModel was built (no 503).
    expect(model).toBeDefined();
    // Creds were fetched for the OVERRIDE driver, then decrypted.
    expect(aiProviderCredentialsRepo.find).toHaveBeenCalledWith('ws-1', 'gemini');
    expect(secretBox.decryptSecret).toHaveBeenCalledWith('enc-gemini-key');
  });

  it('chatModel-only override (no driver): reuses the workspace driver+creds, no creds lookup/decrypt', async () => {
    // No override.driver => the workspace openai driver + its apiKey are reused;
    // ai_provider_credentials must NOT be queried and nothing is decrypted.
    const { service, aiProviderCredentialsRepo, secretBox } = makeService({
      workspaceDriver: 'openai',
    });

    const model = await service.getChatModel('ws-1', {
      chatModel: 'gpt-4o',
      roleName: 'Writer',
    });

    expect(model).toBeDefined();
    expect(aiProviderCredentialsRepo.find).not.toHaveBeenCalled();
    expect(secretBox.decryptSecret).not.toHaveBeenCalled();
  });
});
