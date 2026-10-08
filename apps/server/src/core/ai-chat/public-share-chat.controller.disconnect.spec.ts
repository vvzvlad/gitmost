// Break the editor-ext import chain (share.service -> collaboration.util ->
// @docmost/editor-ext), as the sibling public-share specs do; never reached here.
jest.mock('../../collaboration/collaboration.util', () => ({
  jsonToMarkdown: () => '',
}));

import * as http from 'node:http';
import type { Socket } from 'node:net';
import Fastify, { FastifyInstance } from 'fastify';
import { PublicShareChatController } from './public-share-chat.controller';

/**
 * #716 on a REALLY killed socket (invariant #8): an anonymous visitor who leaves
 * aborts the public-share agent loop. Runs the real controller under real
 * Fastify + a real HTTP client, so the test fails if the disconnect listener
 * sits on an event that never fires (the old `req.raw` 'close' did exactly that
 * for a POST with body).
 */
describe('#716 PublicShareChatController.stream — real client disconnect', () => {
  let app: FastifyInstance;
  let handled: Promise<void>;
  let serverSocket: Socket;

  afterEach(async () => {
    await app?.close();
  });

  // Serve the real controller with a funnel that passes; `stream` stands in for
  // PublicShareChatService.stream, `quota` for the last pre-hijack await.
  async function serve(opts: {
    stream: (args: { signal: AbortSignal; res: any }) => Promise<void>;
    quota?: () => Promise<boolean>;
  }) {
    const controller = new PublicShareChatController(
      {
        resolveReadableSharePage: jest.fn().mockResolvedValue({
          share: { id: 's1', pageId: 'p1', spaceId: 'sp1', sharedPage: {} },
        }),
        isSharingAllowed: jest.fn().mockResolvedValue(true),
      } as never,
      {
        isPublicShareAssistantEnabled: jest.fn().mockResolvedValue(true),
      } as never,
      {
        resolveShareRole: jest.fn().mockResolvedValue(null),
        getShareChatModel: jest.fn().mockResolvedValue({}),
        withinShareTokenBudget: jest.fn().mockResolvedValue(true),
        tryConsumeWorkspaceQuota: jest.fn(opts.quota ?? (async () => true)),
        stream: jest.fn(opts.stream),
      } as never,
    );
    app = Fastify();
    app.post('/stream', async (req, reply) => {
      serverSocket = req.raw.socket;
      handled = controller.stream(req, reply, { id: 'ws1' } as never);
      await handled;
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    return (app.server.address() as any).port as number;
  }

  function post(port: number) {
    const req = http.request({
      port,
      host: '127.0.0.1',
      path: '/stream',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    req.on('error', () => undefined);
    req.end(JSON.stringify({ shareId: 's1', pageId: 'p1', messages: [] }));
    return req;
  }

  const closed = (res: any) =>
    new Promise<void>((resolve) => res.raw.once('close', () => resolve()));

  it('aborts the agent loop when the visitor leaves mid-stream', async () => {
    let aborted: boolean | undefined;
    const port = await serve({
      stream: async ({ signal, res }) => {
        res.raw.writeHead(200, { 'content-type': 'text/event-stream' });
        res.raw.write('data: {"type":"start"}\n\n');
        await closed(res);
        aborted = signal.aborted;
      },
    });
    const client = post(port);
    client.on('response', (incoming) =>
      incoming.once('data', () => client.destroy()),
    );
    await new Promise((r) => client.once('close', r));
    await handled;
    expect(aborted).toBe(true);
  });

  it('aborts at once when the visitor left during the pre-stream funnel', async () => {
    let entered!: () => void;
    const enteredP = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    const releaseP = new Promise<void>((r) => (release = r));
    let aborted: boolean | undefined;
    const port = await serve({
      quota: async () => {
        entered();
        await releaseP;
        return true;
      },
      stream: async ({ signal }) => {
        aborted = signal.aborted;
      },
    });
    const client = post(port);
    await enteredP;
    client.destroy();
    await new Promise((r) => serverSocket.once('close', r));
    release();
    await handled;
    expect(aborted).toBe(true);
  });

  it('does not abort a turn that completed normally', async () => {
    let signalRef: AbortSignal | undefined;
    const port = await serve({
      stream: async ({ signal, res }) => {
        signalRef = signal;
        res.raw.writeHead(200, { 'content-type': 'text/event-stream' });
        res.raw.end('data: [DONE]\n\n');
      },
    });
    const client = post(port);
    await new Promise<void>((resolve) =>
      client.on('response', (incoming) => {
        incoming.resume();
        incoming.once('end', () => resolve());
      }),
    );
    await handled;
    await new Promise((r) => setImmediate(r));
    expect(signalRef?.aborted).toBe(false);
  });
});
