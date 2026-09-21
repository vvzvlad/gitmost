import { ForbiddenException } from '@nestjs/common';
import { AiChatController } from './ai-chat.controller';
import type {
  RunStreamAttachment,
  RunStreamCallbacks,
} from './ai-chat-stream-registry.service';
import { SUBSCRIBER_MAX_BUFFERED_BYTES } from './ai-chat-stream-registry.service';
import type { User, Workspace } from '@docmost/db/types/entity.types';

/**
 * Wiring spec for the #184 phase 1.5 attach endpoint (tail-only #491)
 * (`GET /ai-chat/runs/:chatId/stream`). Owner-gated via assertOwnedChat; the
 * registry is mocked so this exercises ONLY the controller's tail-write/live/204/
 * cleanup wiring against a fake raw socket. The attach signature is now
 * `(chatId, anchor, n, cb)` — the client hands its persisted step frontier `n`
 * and its assistant row id `anchor`. Constructor order is (aiChatService,
 * aiChatRunService, aiChatRepo, aiChatMessageRepo, aiTranscription, pageRepo,
 * streamRegistry, environment).
 */
describe('AiChatController attach endpoint (#184 phase 1.5)', () => {
  const user = { id: 'u1' } as User;
  const workspace = { id: 'ws1' } as Workspace;

  function makeRawRes() {
    const raw: any = {
      writableEnded: false,
      writableLength: 0,
      destroyed: false,
      written: [] as string[],
      head: null as any,
      write: jest.fn((f: string) => {
        raw.written.push(f);
        return true;
      }),
      writeHead: jest.fn((code: number, headers: any) => {
        raw.head = { code, headers };
        return raw;
      }),
      flushHeaders: jest.fn(),
      end: jest.fn(() => {
        raw.writableEnded = true;
      }),
      destroy: jest.fn(() => {
        raw.destroyed = true;
      }),
      on: jest.fn(),
      once: jest.fn(),
    };
    const res: any = {
      raw,
      status: jest.fn(() => res),
      send: jest.fn(),
      hijack: jest.fn(),
    };
    return { res, raw };
  }

  function makeReq(destroyed = false) {
    const handlers: Record<string, () => void> = {};
    const raw: any = {
      destroyed,
      once: jest.fn((ev: string, fn: () => void) => {
        handlers[ev] = fn;
      }),
    };
    return { req: { raw } as any, raw, fireClose: () => handlers['close']?.() };
  }

  function makeAttachment(
    over: Partial<RunStreamAttachment> = {},
  ): RunStreamAttachment {
    return {
      replay: [],
      finished: false,
      start: jest.fn(),
      unsubscribe: jest.fn(),
      ...over,
    };
  }

  function makeController(opts: {
    chat?: unknown;
    attachment?: RunStreamAttachment | null;
  }) {
    const aiChatRepo = { findById: jest.fn().mockResolvedValue(opts.chat) };
    let capturedCb: RunStreamCallbacks | undefined;
    const streamRegistry = {
      attach: jest.fn(
        (
          _chatId: string,
          _anchor: string | undefined,
          _n: number,
          cb: RunStreamCallbacks,
        ) => {
          capturedCb = cb;
          return Promise.resolve(
            opts.attachment === undefined ? makeAttachment() : opts.attachment,
          );
        },
      ),
    };
    const environment = { isAiChatResumableStreamEnabled: () => true };
    const controller = new AiChatController(
      {} as never, // aiChatService
      {} as never, // aiChatRunService
      aiChatRepo as never,
      {} as never, // aiChatMessageRepo
      {} as never, // aiTranscription
      {} as never, // pageRepo
      streamRegistry as never,
      environment as never,
    );
    return {
      controller,
      aiChatRepo,
      streamRegistry,
      getCb: () => capturedCb!,
    };
  }

  const owned = { id: 'c1', creatorId: 'u1' };

  it('owner-gates: a foreign chat throws ForbiddenException and never attaches', async () => {
    const { controller, streamRegistry } = makeController({
      chat: { id: 'c1', creatorId: 'someone-else' },
    });
    const { res } = makeRawRes();
    const { req } = makeReq();
    await expect(
      controller.attachRunStream(
        'c1',
        undefined,
        undefined,
        req,
        res,
        user,
        workspace,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(streamRegistry.attach).not.toHaveBeenCalled();
  });

  it('answers 204 when the registry has nothing to resume (no entry / finished / anchor-mismatch)', async () => {
    const { controller } = makeController({ chat: owned, attachment: null });
    const { res } = makeRawRes();
    const { req } = makeReq();
    await controller.attachRunStream(
      'c1',
      undefined,
      undefined,
      req,
      res,
      user,
      workspace,
    );
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.send).toHaveBeenCalled();
    expect(res.hijack).not.toHaveBeenCalled();
  });

  it('threads anchor and the numeric frontier n through to the registry', async () => {
    const { controller, streamRegistry } = makeController({
      chat: owned,
      attachment: null,
    });
    const { res } = makeRawRes();
    const { req } = makeReq();
    await controller.attachRunStream(
      'c1',
      'anchor-1',
      '2',
      req,
      res,
      user,
      workspace,
    );
    expect(streamRegistry.attach).toHaveBeenCalledWith(
      'c1',
      'anchor-1',
      2, // parsed to a number
      expect.anything(),
    );
  });

  it('#491: an ABSENT/invalid n passes null (not 0) so a finished run 204s (not-tail-aware)', async () => {
    // Distinguishing a MISSING `n` from `n=0` is the #137/#161 dup guard: a
    // parameterless/legacy tab must be handed null (-> the registry 204s a finished
    // run) rather than frontier 0 (which would serve a finished non-rotated run's
    // whole tail). MUTATION-VERIFY: revert to `Number(n) || 0` and this asserts 0.
    const { controller, streamRegistry } = makeController({
      chat: owned,
      attachment: null,
    });
    for (const bad of [undefined, '', 'abc']) {
      streamRegistry.attach.mockClear();
      const { res } = makeRawRes();
      const { req } = makeReq();
      await controller.attachRunStream(
        'c1',
        undefined,
        bad,
        req,
        res,
        user,
        workspace,
      );
      expect(streamRegistry.attach).toHaveBeenCalledWith(
        'c1',
        undefined,
        null,
        expect.anything(),
      );
    }
  });

  it('#491: a PRESENT n=0 passes 0 (tail-aware, distinct from absent)', async () => {
    const { controller, streamRegistry } = makeController({
      chat: owned,
      attachment: null,
    });
    const { res } = makeRawRes();
    const { req } = makeReq();
    await controller.attachRunStream(
      'c1',
      undefined,
      '0',
      req,
      res,
      user,
      workspace,
    );
    expect(streamRegistry.attach).toHaveBeenCalledWith(
      'c1',
      undefined,
      0,
      expect.anything(),
    );
  });

  it('hijacks, writes headers + replay, registers a close cleanup, then goes live', async () => {
    const start = jest.fn();
    const attachment = makeAttachment({
      replay: ['f1', 'f2'],
      finished: false,
      start,
    });
    const { controller } = makeController({ chat: owned, attachment });
    const { res, raw } = makeRawRes();
    const { req } = makeReq();
    await controller.attachRunStream(
      'c1',
      undefined,
      undefined,
      req,
      res,
      user,
      workspace,
    );
    expect(res.hijack).toHaveBeenCalled();
    expect(raw.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ 'content-type': 'text/event-stream' }),
    );
    expect(raw.written).toEqual(['f1', 'f2']); // replay
    expect(start).toHaveBeenCalled(); // go live after replay
    expect(req.raw.once).toHaveBeenCalledWith('close', expect.any(Function));
  });

  it('finished replay ends the response immediately without going live', async () => {
    const start = jest.fn();
    const attachment = makeAttachment({
      replay: ['f1'],
      finished: true,
      start,
    });
    const { controller } = makeController({ chat: owned, attachment });
    const { res, raw } = makeRawRes();
    const { req } = makeReq();
    await controller.attachRunStream(
      'c1',
      'a1',
      '1',
      req,
      res,
      user,
      workspace,
    );
    expect(raw.written).toEqual(['f1']);
    expect(raw.end).toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled(); // finished -> returns before start()
  });

  it('a close during the awaits (req.raw.destroyed) unsubscribes and writes nothing', async () => {
    const attachment = makeAttachment({ replay: ['f1'] });
    const { controller } = makeController({ chat: owned, attachment });
    const { res, raw } = makeRawRes();
    const { req } = makeReq(true); // destroyed already at registration time
    await controller.attachRunStream(
      'c1',
      undefined,
      undefined,
      req,
      res,
      user,
      workspace,
    );
    expect(attachment.unsubscribe).toHaveBeenCalled();
    expect(raw.writeHead).not.toHaveBeenCalled();
    expect(raw.written).toEqual([]);
  });

  it('the registered close handler unsubscribes the attachment', async () => {
    const attachment = makeAttachment({ replay: [] });
    const { controller } = makeController({ chat: owned, attachment });
    const { res } = makeRawRes();
    const { req, fireClose } = makeReq();
    await controller.attachRunStream(
      'c1',
      undefined,
      undefined,
      req,
      res,
      user,
      workspace,
    );
    expect(attachment.unsubscribe).not.toHaveBeenCalled();
    fireClose(); // socket closed
    expect(attachment.unsubscribe).toHaveBeenCalled();
  });

  it('onFrame destroys the socket when the buffered length exceeds the cap', async () => {
    const attachment = makeAttachment({ replay: [] });
    const { controller, getCb } = makeController({ chat: owned, attachment });
    const { res, raw } = makeRawRes();
    const { req } = makeReq();
    await controller.attachRunStream(
      'c1',
      undefined,
      undefined,
      req,
      res,
      user,
      workspace,
    );
    const cb = getCb();
    // Normal live frame writes.
    raw.writableLength = 0;
    cb.onFrame('live-1');
    expect(raw.written).toContain('live-1');
    // A stalled socket over the cap is destroyed instead of buffering.
    raw.writableLength = SUBSCRIBER_MAX_BUFFERED_BYTES + 1;
    raw.write.mockClear();
    cb.onFrame('too-much');
    expect(raw.destroy).toHaveBeenCalled();
    expect(raw.write).not.toHaveBeenCalled();
  });
});

/**
 * The begin-hook `open()` flag gate (#184 phase 1.5). `open()` lives ONLY in the
 * stream() begin-hook, gated on the resumable flag. If it regressed, a flag-off
 * turn would create an EMPTY registry entry (never bound, never finished) and a
 * later attach would find a non-null paused attachment -> a hung SSE that never
 * gets a frame and never ends, instead of a clean 204. These drive stream() only
 * far enough to capture the runHooks it hands to the service, then invoke the
 * begin-hook and assert whether the registry was opened.
 */
describe('AiChatController begin-hook open() flag gate (#184 phase 1.5)', () => {
  const user = { id: 'u1' } as User;
  const workspace = {
    id: 'ws1',
    settings: { ai: { chat: true, autonomousRuns: true } },
  } as unknown as Workspace;

  function makeController(opts: { resumable: boolean }) {
    let capturedArgs: any;
    const aiChatService = {
      resolveRoleForRequest: jest.fn(async () => null),
      getChatModel: jest.fn(async () => ({})),
      stream: jest.fn(async (args: any) => {
        capturedArgs = args;
      }),
    };
    const aiChatRunService = {
      getActiveForChat: jest.fn(async () => undefined),
      beginRun: jest.fn(async () => ({
        runId: 'run-1',
        signal: new AbortController().signal,
      })),
    };
    const streamRegistry = { open: jest.fn(), attach: jest.fn() };
    const environment = {
      isAiChatResumableStreamEnabled: () => opts.resumable,
    };
    const controller = new AiChatController(
      aiChatService as never,
      aiChatRunService as never,
      {} as never, // aiChatRepo
      {} as never, // aiChatMessageRepo
      {} as never, // aiTranscription
      {} as never, // pageRepo
      streamRegistry as never,
      environment as never,
    );
    return {
      controller,
      streamRegistry,
      aiChatRunService,
      getRunHooks: () => capturedArgs?.runHooks,
    };
  }

  function makeReqRes() {
    const req: any = {
      raw: { sessionId: 'sess-1', once: jest.fn() },
      body: {
        messages: [
          { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        ],
      },
    };
    const res: any = {
      raw: { once: jest.fn(), on: jest.fn(), headersSent: false, writableEnded: false },
      hijack: jest.fn(),
    };
    return { req, res };
  }

  it('flag OFF: the begin-hook does NOT open a registry entry (no hung empty entry)', async () => {
    const { controller, streamRegistry, aiChatRunService, getRunHooks } =
      makeController({ resumable: false });
    const { req, res } = makeReqRes();
    await controller.stream(req, res, user, workspace);

    const runHooks = getRunHooks();
    expect(runHooks).toBeDefined();
    const handle = await runHooks.begin('chat-1');
    // The run still begins (the durable-run feature is independent of resume)...
    expect(aiChatRunService.beginRun).toHaveBeenCalled();
    expect(handle).toEqual({ runId: 'run-1', signal: expect.anything() });
    // ...but with the flag off the registry entry is NEVER opened.
    expect(streamRegistry.open).not.toHaveBeenCalled();
  });

  it('flag ON: the begin-hook opens the registry entry with (chatId, runId)', async () => {
    const { controller, streamRegistry, getRunHooks } = makeController({
      resumable: true,
    });
    const { req, res } = makeReqRes();
    await controller.stream(req, res, user, workspace);

    const runHooks = getRunHooks();
    await runHooks.begin('chat-1');
    expect(streamRegistry.open).toHaveBeenCalledWith('chat-1', 'run-1');
  });
});
