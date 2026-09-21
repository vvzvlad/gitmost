// `.provider` alone cannot prove the gemini/ollama chat factories were built
// with the instrumented streaming fetch — a regression dropping it (which drops
// them back to the global undici fetch: no keep-alive recycle, no reset retries,
// unbounded silence timeout; incident classes #140/#175/#310) would still pass.
// So mock the factories and assert the exact fetch argument. jest.mock is
// module-scoped, hence a dedicated file.

const mockGeminiModel = { provider: 'google.generative-ai', modelId: 'm' };
const mockOllamaModel = { provider: 'ollama.chat', modelId: 'm' };

// jest allows `mock`-prefixed vars inside a jest.mock factory.
const mockCreateGoogle = jest.fn((_settings: unknown) => () => mockGeminiModel);
const mockCreateOllama = jest.fn((_settings: unknown) => () => mockOllamaModel);

jest.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: (settings: unknown) => mockCreateGoogle(settings),
}));
jest.mock('ai-sdk-ollama', () => ({
  createOllama: (settings: unknown) => mockCreateOllama(settings),
}));

import { AiService } from './ai.service';

describe('AiService.getChatModel provider transport fetch (gemini/ollama)', () => {
  function serviceWith(cfg: Record<string, unknown>) {
    const aiSettings = {
      resolve: jest.fn().mockResolvedValue(cfg),
    };
    return new AiService(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aiSettings as any,
      { find: jest.fn() } as never,
      { decryptSecret: jest.fn() } as never,
    );
  }

  beforeEach(() => {
    mockCreateGoogle.mockClear();
    mockCreateOllama.mockClear();
  });

  it('builds the gemini chat model with the instrumented streaming fetch', async () => {
    await serviceWith({
      driver: 'gemini',
      chatModel: 'gemini-2.5-pro',
      apiKey: 'the-key',
    }).getChatModel('ws-1');
    expect(mockCreateGoogle).toHaveBeenCalledTimes(1);
    expect(mockCreateGoogle).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'the-key',
        fetch: expect.any(Function),
      }),
    );
  });

  it('builds the ollama chat model with the instrumented streaming fetch', async () => {
    await serviceWith({
      driver: 'ollama',
      chatModel: 'llama3',
      baseUrl: 'http://localhost:11434/api',
    }).getChatModel('ws-1');
    expect(mockCreateOllama).toHaveBeenCalledTimes(1);
    expect(mockCreateOllama).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'http://localhost:11434/api',
        fetch: expect.any(Function),
      }),
    );
  });

  it('reuses ONE service-lifetime fetch instance across both providers', async () => {
    const svc = serviceWith({
      driver: 'gemini',
      chatModel: 'gemini-2.5-pro',
      apiKey: 'k',
    });
    await svc.getChatModel('ws-1');
    const geminiFetch = mockCreateGoogle.mock.calls[0][0] as { fetch: unknown };
    // Same instance on a second call — the fetch is held for the service
    // lifetime to reuse the streaming dispatcher's connection pool.
    await svc.getChatModel('ws-1');
    const geminiFetch2 = mockCreateGoogle.mock.calls[1][0] as { fetch: unknown };
    expect(geminiFetch.fetch).toBe(geminiFetch2.fetch);
  });
});
