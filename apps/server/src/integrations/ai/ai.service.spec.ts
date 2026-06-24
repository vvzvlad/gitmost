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

  it('cross-driver override to ollama (workspace driver != ollama): throws 503, does NOT silently reuse the workspace baseUrl', async () => {
    // Workspace driver is openai with a configured (gateway) baseUrl. A role that
    // overrides to ollama has no dedicated ollama endpoint, so pointing the
    // ollama client at the workspace's openai baseUrl would be wrong — it must
    // fail explicitly instead.
    const aiSettings = {
      resolve: jest.fn().mockResolvedValue({
        driver: 'openai',
        chatModel: 'gpt-4o-mini',
        apiKey: 'workspace-key',
        baseUrl: 'https://openrouter.example/v1',
      }),
    };
    const aiProviderCredentialsRepo = { find: jest.fn() };
    const secretBox = { decryptSecret: jest.fn() };
    const service = new AiService(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aiSettings as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aiProviderCredentialsRepo as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      secretBox as any,
    );

    await service
      .getChatModel('ws-1', {
        driver: 'ollama',
        chatModel: 'llama3',
        roleName: 'Local',
      })
      .then(
        () => {
          throw new Error('expected getChatModel to throw');
        },
        (err: unknown) => {
          expect(err).toBeInstanceOf(AiNotConfiguredException);
          const message = (err as AiNotConfiguredException).message;
          // Names the role and the workspace driver, and mentions ollama.
          expect(message).toContain('ollama');
          expect(message).toContain('openai');
          expect(message).toContain('Local');
          // Must NOT leak / reuse the workspace gateway baseUrl in the path.
          expect(message).not.toContain('openrouter.example');
        },
      );

    // No ollama creds lookup happens (ollama needs no key); we fail before that.
    expect(aiProviderCredentialsRepo.find).not.toHaveBeenCalled();
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

  /**
   * Build a service whose workspace driver is ollama (no apiKey, with a baseUrl).
   * Complements makeService (which configures openai) for the same-driver and
   * not-configured ollama cases.
   */
  function makeOllamaService(over: { baseUrl?: string } = {}) {
    const aiSettings = {
      resolve: jest.fn().mockResolvedValue({
        driver: 'ollama',
        chatModel: 'llama3',
        apiKey: undefined,
        baseUrl: over.baseUrl ?? 'http://localhost:11434/v1',
      }),
    };
    const aiProviderCredentialsRepo = { find: jest.fn() };
    const secretBox = { decryptSecret: jest.fn() };
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

  it('same-driver ollama override (workspace driver=ollama): reuses the workspace ollama baseUrl, no creds lookup/decrypt', async () => {
    // Workspace driver IS ollama. A role that overrides to ollama (same driver)
    // legitimately reuses the workspace's configured ollama endpoint — it must
    // NOT hit the cross-driver 503 path, NOT query ai_provider_credentials, and
    // NOT decrypt anything (ollama needs no key).
    const { service, aiProviderCredentialsRepo, secretBox } = makeOllamaService();

    const model = await service.getChatModel('ws-1', {
      driver: 'ollama',
      chatModel: 'llama3.1',
      roleName: 'Local',
    });

    expect(model).toBeDefined();
    expect(aiProviderCredentialsRepo.find).not.toHaveBeenCalled();
    expect(secretBox.decryptSecret).not.toHaveBeenCalled();
  });

  it('chatModel-only override on an ollama workspace: reuses the workspace ollama baseUrl, no creds lookup', async () => {
    // No override.driver on an ollama workspace => the workspace ollama driver +
    // baseUrl are reused; no creds lookup, no decrypt (the cheap public-share
    // model-only override path against an ollama workspace).
    const { service, aiProviderCredentialsRepo, secretBox } = makeOllamaService();

    const model = await service.getChatModel('ws-1', { chatModel: 'mistral' });

    expect(model).toBeDefined();
    expect(aiProviderCredentialsRepo.find).not.toHaveBeenCalled();
    expect(secretBox.decryptSecret).not.toHaveBeenCalled();
  });

  it('blank chatModel guard: workspace has a driver but a blank chatModel and no override chatModel => AiNotConfiguredException', async () => {
    // cfg.driver passes the first guard, but cfg.chatModel is blank and the
    // override carries no chatModel, so the effective chatModel is empty.
    const aiSettings = {
      resolve: jest.fn().mockResolvedValue({
        driver: 'openai',
        chatModel: '',
        apiKey: 'workspace-key',
        baseUrl: undefined,
      }),
    };
    const aiProviderCredentialsRepo = { find: jest.fn() };
    const secretBox = { decryptSecret: jest.fn() };
    const service = new AiService(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aiSettings as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aiProviderCredentialsRepo as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      secretBox as any,
    );

    await expect(
      // Override has only a roleName, no chatModel to fill the blank.
      service.getChatModel('ws-1', { roleName: 'Writer' }),
    ).rejects.toBeInstanceOf(AiNotConfiguredException);
  });

  it('non-ollama driver with a missing apiKey => AiNotConfiguredException', async () => {
    // Workspace is openai (non-ollama) with a model but NO apiKey: the combined
    // `driver !== ollama && !apiKey` guard must 503.
    const aiSettings = {
      resolve: jest.fn().mockResolvedValue({
        driver: 'openai',
        chatModel: 'gpt-4o-mini',
        apiKey: undefined,
        baseUrl: undefined,
      }),
    };
    const aiProviderCredentialsRepo = { find: jest.fn() };
    const secretBox = { decryptSecret: jest.fn() };
    const service = new AiService(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aiSettings as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aiProviderCredentialsRepo as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      secretBox as any,
    );

    await expect(service.getChatModel('ws-1')).rejects.toBeInstanceOf(
      AiNotConfiguredException,
    );
  });
});

/**
 * Chat provider selection by the EXPLICIT `chatApiStyle` (NOT inferred from
 * baseUrl): 'openai-compatible' (default) uses @ai-sdk/openai-compatible, which
 * maps streamed reasoning_content to reasoning parts; 'openai' uses the official
 * provider; and openai-compatible without a baseURL safely falls back to the
 * official provider (it has no default endpoint). Asserted via `.provider`.
 */
describe('AiService.getChatModel chatApiStyle provider selection', () => {
  function serviceWith(opts: {
    baseUrl?: string;
    chatApiStyle?: 'openai-compatible' | 'openai';
  }) {
    const aiSettings = {
      resolve: jest.fn().mockResolvedValue({
        driver: 'openai',
        chatModel: 'glm-5.2',
        apiKey: 'key',
        baseUrl: opts.baseUrl,
        chatApiStyle: opts.chatApiStyle,
      }),
    };
    return new AiService(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aiSettings as any,
      { find: jest.fn() } as never,
      { decryptSecret: jest.fn() } as never,
    );
  }

  const providerOf = async (svc: AiService) =>
    (
      (await svc.getChatModel('ws-1')) as { provider: string }
    ).provider;

  it("'openai-compatible' + baseURL -> openai-compatible provider", async () => {
    expect(
      await providerOf(
        serviceWith({ baseUrl: 'https://api.z.ai/v4', chatApiStyle: 'openai-compatible' }),
      ),
    ).toContain('openai-compatible');
  });

  it("'openai' + baseURL -> official openai provider", async () => {
    expect(
      await providerOf(serviceWith({ baseUrl: 'https://api.z.ai/v4', chatApiStyle: 'openai' })),
    ).toBe('openai.chat');
  });

  it('unset + baseURL -> defaults to openai-compatible', async () => {
    expect(
      await providerOf(serviceWith({ baseUrl: 'https://api.z.ai/v4' })),
    ).toContain('openai-compatible');
  });

  it("'openai-compatible' WITHOUT baseURL -> safe fallback to official openai", async () => {
    expect(
      await providerOf(serviceWith({ chatApiStyle: 'openai-compatible' })),
    ).toBe('openai.chat');
  });
});
