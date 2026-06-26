// `.provider` alone cannot prove the openai-compatible factory was called with
// `includeUsage: true` — a regression dropping it (which zeroes streamed token
// usage / reasoning-token metadata) would still pass. So mock the factory and
// assert the exact args. jest.mock is module-scoped, hence a dedicated file.

const mockCompatibleModel = { provider: 'openai-compatible.chat', modelId: 'm' };
// jest allows `mock`-prefixed vars inside a jest.mock factory.
const mockCreateOpenAICompatible = jest.fn(
  (_settings: unknown) => () => mockCompatibleModel,
);

jest.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: (settings: unknown) =>
    mockCreateOpenAICompatible(settings),
}));

import { AiService } from './ai.service';

describe('AiService.getChatModel openai-compatible factory args', () => {
  function serviceWith(chatApiStyle?: 'openai-compatible' | 'openai') {
    const aiSettings = {
      resolve: jest.fn().mockResolvedValue({
        driver: 'openai',
        chatModel: 'glm-5.2',
        apiKey: 'the-key',
        baseUrl: 'https://api.z.ai/v4',
        chatApiStyle,
      }),
    };
    return new AiService(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aiSettings as any,
      { find: jest.fn() } as never,
      { decryptSecret: jest.fn() } as never,
    );
  }

  beforeEach(() => mockCreateOpenAICompatible.mockClear());

  it('passes includeUsage:true plus baseURL/apiKey/fetch (default style)', async () => {
    await serviceWith().getChatModel('ws-1'); // unset -> openai-compatible
    expect(mockCreateOpenAICompatible).toHaveBeenCalledTimes(1);
    expect(mockCreateOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'openai-compatible',
        baseURL: 'https://api.z.ai/v4',
        apiKey: 'the-key',
        includeUsage: true,
        fetch: expect.any(Function),
      }),
    );
  });

  it("does NOT use the openai-compatible factory for chatApiStyle 'openai'", async () => {
    await serviceWith('openai').getChatModel('ws-1');
    expect(mockCreateOpenAICompatible).not.toHaveBeenCalled();
  });
});
