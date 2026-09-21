// Break the editor-ext import chain (share.service -> collaboration.util ->
// @docmost/editor-ext -> @tiptap/core) that is unresolvable in this jest env and
// pre-existingly breaks these specs. jsonToMarkdown is never reached in these
// tests (the tools fail before rendering markdown).
jest.mock('../../collaboration/collaboration.util', () => ({
  jsonToMarkdown: () => '',
}));

import { Logger } from '@nestjs/common';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { PublicShareChatService } from './public-share-chat.service';
import { PublicShareChatToolsService } from './tools/public-share-chat-tools.service';

/**
 * SECURITY integration guard for #394 (commit 5): a tool's or the provider's raw
 * error text must NOT leak to an anonymous public-share reader.
 *
 * The render gate (ToolCallCard showErrors=false) hides the text in the DOM but
 * NOT on the wire, so this test asserts on the RAW SSE BYTES the server writes —
 * exactly the channel the render gate masks. We drive the real
 * PublicShareChatService.stream() with a real share toolset (its underlying
 * services mocked to fail) and a mock model, then inspect every byte piped to the
 * fake socket.
 */

// A minimal ServerResponse stand-in that records every written chunk.
class FakeSocket {
  chunks: string[] = [];
  statusCode = 200;
  writableEnded = false;
  destroyed = false;
  headersSent = false;
  writeHead(): this {
    this.headersSent = true;
    return this;
  }
  setHeader(): void {}
  removeHeader(): void {}
  getHeader(): undefined {
    return undefined;
  }
  flushHeaders(): void {}
  write(chunk: unknown): boolean {
    this.chunks.push(
      typeof chunk === 'string' ? chunk : Buffer.from(chunk as never).toString('utf8'),
    );
    return true;
  }
  end(chunk?: unknown): void {
    if (chunk) this.write(chunk);
    this.writableEnded = true;
  }
  on(): this {
    return this;
  }
  once(): this {
    return this;
  }
  get body(): string {
    return this.chunks.join('');
  }
}

/** Mock model that issues one getSharePage tool call, then finishes with text. */
function toolCallingModel(): MockLanguageModelV3 {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      call++;
      if (call === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start' as const, warnings: [] },
              { type: 'tool-input-start' as const, id: 't1', toolName: 'getSharePage' },
              { type: 'tool-input-end' as const, id: 't1' },
              {
                type: 'tool-call' as const,
                toolCallId: 't1',
                toolName: 'getSharePage',
                input: '{"pageId":"secret-page"}',
              },
              {
                type: 'finish' as const,
                finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
                usage: {
                  inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
                  outputTokens: { total: 1, text: 1, reasoning: undefined },
                },
              },
            ],
          }),
        };
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start' as const, warnings: [] },
            { type: 'text-start' as const, id: '1' },
            { type: 'text-delta' as const, id: '1', delta: 'Sorry.' },
            { type: 'text-end' as const, id: '1' },
            {
              type: 'finish' as const,
              finishReason: { unified: 'stop' as const, raw: 'stop' },
              usage: {
                inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 1, text: 1, reasoning: undefined },
              },
            },
          ],
        }),
      };
    },
  });
}

/** Mock model whose stream emits a provider error carrying an internal secret. */
function providerErrorModel(secret: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start' as const, warnings: [] },
          {
            type: 'error' as const,
            error: {
              statusCode: 503,
              message: 'Service Unavailable',
              responseBody: `upstream ${secret} model=internal-gpt`,
            },
          },
        ],
      }),
    }),
  });
}

function makeService(toolsService: PublicShareChatToolsService): {
  svc: PublicShareChatService;
  logSpy: jest.SpyInstance;
} {
  const svc = Object.create(PublicShareChatService.prototype);
  const logger = new Logger('test');
  const logSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  svc.tools = toolsService;
  svc.logger = logger;
  svc.tokenBudget = { record: jest.fn().mockResolvedValue(undefined) };
  return { svc, logSpy };
}

async function runStream(
  svc: PublicShareChatService,
  model: MockLanguageModelV3,
): Promise<FakeSocket> {
  const socket = new FakeSocket();
  await svc.stream({
    workspaceId: 'ws1',
    shareId: 'share1',
    share: { id: 'share1', pageId: 'p1', sharedPage: { id: 'p1', title: 'Docs' } },
    openedPage: null,
    messages: [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'read the page' }] } as never,
    ],
    res: { raw: socket } as never,
    signal: new AbortController().signal,
    model: model as never,
    role: null,
  });
  // Wait for the piped stream to drain fully. pipeUIMessageStreamToResponse
  // calls res.end() on completion, which sets FakeSocket.writableEnded — poll
  // for that instead of a fixed sleep, which raced the tool round-trip on a
  // loaded CI runner and flaked (#652). Bounded so a stream that never ends
  // fails the assertion rather than hanging the suite.
  const deadline = Date.now() + 5000;
  while (!socket.writableEnded && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return socket;
}

describe('public share chat error leak (#394)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('does NOT leak a tool\'s raw internal error to the SSE bytes (generic classified string instead)', async () => {
    const SECRET = 'INTERNAL_baseUrl_http://provider.internal:8080/v1';
    const shareService = {
      // The canonical boundary throws a RAW internal error (with a secret).
      resolveReadableSharePage: jest
        .fn()
        .mockRejectedValue(new Error(`db failed at ${SECRET} stack@line42`)),
    };
    const tools = new PublicShareChatToolsService(
      shareService as never,
      {} as never,
      {} as never,
    );
    const { svc } = makeService(tools);

    const socket = await runStream(svc, toolCallingModel());

    // The tool-output-error frame is present on the wire...
    expect(socket.body).toContain('tool-output-error');
    // ...but it carries ONLY the generic classified string — never the secret,
    // the raw driver message, or a stack fragment.
    expect(socket.body).toContain('The tool could not complete the request.');
    expect(socket.body).not.toContain(SECRET);
    expect(socket.body).not.toContain('stack@line42');
    expect(socket.body).not.toContain('db failed');
  });

  it('passes a SAFE ShareToolError message (page not available) through to the bytes', async () => {
    const shareService = {
      // Not found in this share -> the tool throws the classified SAFE message.
      resolveReadableSharePage: jest.fn().mockResolvedValue(null),
    };
    const tools = new PublicShareChatToolsService(
      shareService as never,
      {} as never,
      {} as never,
    );
    const { svc } = makeService(tools);

    const socket = await runStream(svc, toolCallingModel());
    expect(socket.body).toContain('tool-output-error');
    expect(socket.body).toContain('not available in this share');
  });

  it('does NOT leak a provider error (statusCode + response body) to the SSE bytes', async () => {
    const SECRET = 'http://provider.internal:8080';
    const tools = new PublicShareChatToolsService(
      {} as never,
      {} as never,
      {} as never,
    );
    const { svc, logSpy } = makeService(tools);

    const socket = await runStream(svc, providerErrorModel(SECRET));

    // The anon sees a fixed classified string, not the provider body/baseUrl/model.
    expect(socket.body).toContain('temporarily unavailable');
    expect(socket.body).not.toContain(SECRET);
    expect(socket.body).not.toContain('internal-gpt');
    // The FULL provider detail is logged server-side only.
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain(SECRET);
  });
});
