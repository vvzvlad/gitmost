import * as http from 'node:http';
import Fastify, { FastifyInstance } from 'fastify';
import { AiChatController } from './ai-chat.controller';
import type { User, Workspace } from '@docmost/db/types/entity.types';

/**
 * #714 on a REALLY killed socket (invariant #8): a NEW chat whose client goes
 * away before the first frame (which carries the chat id) gets its run stopped
 * by the server. Runs the real controller under real Fastify + a real HTTP
 * client, so the test fails if the disconnect listener sits on an event that
 * never fires (the old `req.raw` 'close' was exactly that for a POST with body).
 */
describe('#714 AiChatController.stream — real client disconnect', () => {
  const user = { id: 'u1' } as User;
  const workspace = {
    id: 'ws1',
    settings: { ai: { chat: true } },
  } as unknown as Workspace;

  let app: FastifyInstance;
  let handled: Promise<void>;
  let serverSocket: import('node:net').Socket;

  afterEach(async () => {
    await app?.close();
  });

  // Serve the real controller; `stream` stands in for AiChatService.stream and
  // `getChatModel` for the pre-hijack model resolution.
  async function serve(opts: {
    stream: (args: { runHooks: any; res: any }) => Promise<void>;
    getChatModel?: () => Promise<unknown>;
  }) {
    const requestStop = jest.fn().mockResolvedValue(true);
    const controller = new AiChatController(
      {
        resolveRoleForRequest: jest.fn().mockResolvedValue(null),
        getChatModel: jest.fn(opts.getChatModel ?? (async () => ({}))),
        stream: jest.fn(opts.stream),
      } as never,
      {
        beginRun: jest.fn().mockResolvedValue({
          runId: 'run-new',
          signal: new AbortController().signal,
        }),
        requestStop,
      } as never,
      {} as never, // aiChatRepo
      {} as never, // aiChatMessageRepo
      {} as never, // aiTranscription
      {} as never, // pageRepo
    );
    app = Fastify();
    app.post('/stream', async (req, reply) => {
      (req.raw as any).sessionId = 'sess';
      serverSocket = req.raw.socket;
      handled = controller.stream(req, reply, user, workspace);
      await handled;
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    return { requestStop, port: (app.server.address() as any).port };
  }

  // POST a new-chat turn (no chatId); returns the client request.
  function post(port: number) {
    const req = http.request({
      port,
      host: '127.0.0.1',
      path: '/stream',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    req.on('error', () => undefined);
    req.end('{}');
    return req;
  }

  const closed = (res: any) =>
    new Promise<void>((resolve) => res.raw.once('close', () => resolve()));

  it('stops the run when the client leaves after begin, before any frame', async () => {
    let begun!: () => void;
    const beganP = new Promise<void>((r) => (begun = r));
    const { requestStop, port } = await serve({
      stream: async ({ runHooks, res }) => {
        await runHooks.begin('c-new');
        begun();
        await closed(res);
      },
    });
    const client = post(port);
    await beganP;
    client.destroy();
    await handled;
    expect(requestStop).toHaveBeenCalledTimes(1);
    expect(requestStop).toHaveBeenCalledWith('run-new', 'ws1');
  });

  it('stops the run at begin when the client left during the pre-hijack awaits', async () => {
    let entered!: () => void;
    const enteredP = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    const releaseP = new Promise<void>((r) => (release = r));
    const { requestStop, port } = await serve({
      getChatModel: async () => {
        entered();
        await releaseP;
        return {};
      },
      stream: async ({ runHooks }) => {
        await runHooks.begin('c-new');
      },
    });
    const client = post(port);
    await enteredP;
    client.destroy();
    // Let the server observe the disconnect before the handler moves on.
    await new Promise((r) => serverSocket.once('close', r));
    release();
    await handled;
    expect(requestStop).toHaveBeenCalledTimes(1);
    expect(requestStop).toHaveBeenCalledWith('run-new', 'ws1');
  });

  it('keeps the run when the client leaves after the first frame', async () => {
    const { requestStop, port } = await serve({
      stream: async ({ runHooks, res }) => {
        await runHooks.begin('c-new');
        res.raw.writeHead(200, { 'content-type': 'text/event-stream' });
        res.raw.write('data: {"type":"start"}\n\n');
        await closed(res);
      },
    });
    const client = post(port);
    client.on('response', (incoming) =>
      incoming.once('data', () => client.destroy()),
    );
    await new Promise((r) => client.once('close', r));
    await handled;
    expect(requestStop).not.toHaveBeenCalled();
  });
});
