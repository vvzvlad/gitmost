import * as http from 'node:http';
import { Kysely } from 'kysely';
import {
  MockLanguageModelV3,
  convertArrayToReadableStream,
} from 'ai/test';
import { AiChatRepo } from '@docmost/db/repos/ai-chat/ai-chat.repo';
import { AiChatMessageRepo } from '@docmost/db/repos/ai-chat/ai-chat-message.repo';
import { AiChatRunRepo } from '@docmost/db/repos/ai-chat/ai-chat-run.repo';
import { AiChatService } from 'src/core/ai-chat/ai-chat.service';
import { AiChatRunService } from 'src/core/ai-chat/ai-chat-run.service';
import {
  AiChatStreamRegistryService,
  RunStreamCallbacks,
} from 'src/core/ai-chat/ai-chat-stream-registry.service';
import {
  getTestDb,
  destroyTestDb,
  createWorkspace,
  createUser,
  createChat,
} from './db';

/**
 * #184 phase 1.5 — the resumable transport end to end against REAL Postgres,
 * the REAL `streamText` (seeded via MockLanguageModelV3) and a REAL Node
 * ServerResponse, driving the REAL `AiChatService.stream` run-wrapped path with a
 * REAL `AiChatStreamRegistryService`. The run-hooks mirror the controller: they
 * begin a durable run and `open()` the registry entry at begin, and the service
 * tees the SSE frames into it via `consumeSseStream` while stamping the DB row id
 * via `generateMessageId` (both gated on runId + the resumable flag).
 *
 * Proven here (tail-only #491): a finished run attached at its persisted frontier
 * N_final delivers only the TAIL past N (a synthetic `start` carrying the run-fact
 * + the terminal `finish`/`[DONE]`) — the step content below N lives in the seeded
 * DB row, NOT the ring; the anchor check (invariant 6); an attach opened BEFORE the
 * first frame follows the live stream from frame 0; an explicit stop surfaces
 * `{"type":"abort"}` + `[DONE]` + end to the subscriber; and the legacy (non-run)
 * path tees nothing.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(
  cond: () => Promise<boolean> | boolean,
  { timeoutMs = 15_000, stepMs = 25 } = {},
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await sleep(stepMs);
  }
  throw new Error('waitFor: condition not met within timeout');
}

// A real Node ServerResponse wired to a live socket (as in the stream int-spec).
function makeRealResponse(): Promise<{
  res: http.ServerResponse;
  cleanup: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      resolve({
        res,
        cleanup: () =>
          new Promise<void>((done) => {
            try {
              if (!res.writableEnded) res.end();
            } catch {
              /* socket already gone */
            }
            server.close(() => done());
          }),
      });
    });
    server.listen(0, () => {
      const port = (server.address() as any).port;
      const creq = http.request({ port, method: 'GET' }, (cres) => {
        cres.resume();
      });
      creq.on('error', () => undefined);
      creq.end();
    });
  });
}

// A full, successful single-step turn.
function successStream() {
  return convertArrayToReadableStream([
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: 'Hello' },
    { type: 'text-delta', id: 't1', delta: ' there' },
    { type: 'text-end', id: 't1' },
    {
      type: 'finish',
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    },
  ] as any);
}

// A stream the test feeds chunk by chunk (to attach mid-flight / drive a stop).
function makeControlledStream() {
  let controller!: ReadableStreamDefaultController<any>;
  const stream = new ReadableStream<any>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    emit: (chunk: any) => controller.enqueue(chunk),
    close: () => controller.close(),
  };
}

// Collect replay + live frames from an attachment.
function liveSink(): {
  cb: RunStreamCallbacks;
  frames: string[];
  ended: () => boolean;
} {
  const frames: string[] = [];
  let ended = false;
  return {
    frames,
    ended: () => ended,
    cb: {
      onFrame: (f) => frames.push(f),
      onEnd: () => {
        ended = true;
      },
    },
  };
}

// Parse the first `start` frame's JSON out of a `data: {...}` sequence.
function parseStartFrame(
  frames: string[],
): { messageId?: string; messageMetadata?: any } | undefined {
  for (const f of frames) {
    const m = /^data: (\{.*\})\s*$/m.exec(f.trim());
    if (!m) continue;
    try {
      const json = JSON.parse(m[1]);
      if (json.type === 'start') return json;
    } catch {
      /* not this frame */
    }
  }
  return undefined;
}

describe('AiChatService run-stream attach [integration]', () => {
  let db: Kysely<any>;
  let aiChatRepo: AiChatRepo;
  let msgRepo: AiChatMessageRepo;
  let runRepo: AiChatRunRepo;
  let workspaceId: string;
  let userId: string;

  const mcpClients = {
    toolsFor: async () => ({
      tools: {},
      clients: [],
      outcomes: [],
      instructions: [],
    }),
  };

  // Build the service with the run-stream registry wired and the resumable flag
  // ON (the property under test). Deferred tools OFF (irrelevant here).
  function buildService(registry: AiChatStreamRegistryService): AiChatService {
    return new AiChatService(
      { getChatModel: async () => null } as any,
      aiChatRepo,
      msgRepo,
      {} as any,
      { resolve: async () => null } as any,
      { forUser: async () => ({}) } as any,
      mcpClients as any,
      {} as any,
      {} as any,
      {} as any,
      {
        isAiChatDeferredToolsEnabled: () => false,
        isAiChatResumableStreamEnabled: () => true,
        isAiChatFinalStepLockdownEnabled: () => false,
        isAiChatViewImageEnabled: () => false,
      } as any,
      registry,
    );
  }

  // Run-hooks mirroring the controller: begin the durable run AND open() the
  // registry entry at begin. Captures the runId so a test can stop it.
  function makeRunHooks(
    runService: AiChatRunService,
    registry: AiChatStreamRegistryService,
    box: { runId?: string },
  ) {
    return {
      begin: async (chatId: string) => {
        const handle = await runService.beginRun({
          chatId,
          workspaceId,
          userId,
          trigger: 'user',
        });
        box.runId = handle.runId;
        registry.open(chatId, handle.runId);
        return handle;
      },
      onAssistantSeeded: (runId: string, messageId: string) =>
        runService.linkAssistantMessage(runId, workspaceId, messageId),
      onStep: (runId: string, n: number) =>
        void runService.recordStep(runId, workspaceId, n),
      onSettled: (runId: string, status: any, error?: string) =>
        runService.finalizeRun(runId, workspaceId, status, error),
    };
  }

  function userUiMessage(text: string) {
    return {
      id: `u-${Math.random()}`,
      role: 'user',
      parts: [{ type: 'text', text }],
    };
  }

  async function startRun(opts: {
    registry: AiChatStreamRegistryService;
    runService?: AiChatRunService;
    model: MockLanguageModelV3;
    chatId: string;
    body: any;
    box?: { runId?: string };
  }): Promise<{ res: http.ServerResponse; cleanup: () => Promise<void> }> {
    const service = buildService(opts.registry);
    const { res, cleanup } = await makeRealResponse();
    const runHooks = opts.runService
      ? makeRunHooks(opts.runService, opts.registry, opts.box ?? {})
      : undefined;
    await service.stream({
      user: { id: userId, workspaceId } as any,
      workspace: { id: workspaceId, name: 'WS' } as any,
      sessionId: 'sess-1',
      body: opts.body,
      res: { raw: res } as any,
      signal: new AbortController().signal,
      model: opts.model as any,
      role: null,
      runHooks,
    } as any);
    return { res, cleanup };
  }

  async function assistantRowId(chatId: string): Promise<string> {
    const rows = await msgRepo.findAllByChat(chatId, workspaceId);
    const row = rows.find((r: any) => r.role === 'assistant');
    return row!.id as string;
  }

  beforeAll(async () => {
    db = getTestDb();
    aiChatRepo = new AiChatRepo(db as any);
    msgRepo = new AiChatMessageRepo(db as any);
    runRepo = new AiChatRunRepo(db as any);
    workspaceId = (await createWorkspace(db)).id;
    userId = (await createUser(db, workspaceId)).id;
  });

  afterAll(async () => {
    await destroyTestDb();
  });

  it('run-wrapped, tail-only: a finished run at N_final delivers the run-fact start + finish/[DONE]; the step content lives in the seeded row', async () => {
    const chatId = (await createChat(db, { workspaceId, creatorId: userId })).id;
    const registry = new AiChatStreamRegistryService();
    const runService = new AiChatRunService(runRepo, {
      isCloud: () => false,
    } as never);
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: successStream() }),
    } as any);

    const box: { runId?: string } = {};
    const { cleanup } = await startRun({
      registry,
      runService,
      model,
      chatId,
      body: { chatId, messages: [userUiMessage('Hi')] },
      box,
    });
    try {
      // Wait for the assistant row to settle (terminal callbacks run async).
      await waitFor(async () => {
        const rows = await msgRepo.findAllByChat(chatId, workspaceId);
        return rows.some(
          (r: any) =>
            r.role === 'assistant' &&
            ['completed', 'error', 'aborted'].includes(r.status),
        );
      });
      const rowId = await assistantRowId(chatId);
      // The client reads its persisted step frontier N from the seeded row.
      const row: any = await msgRepo.findById(rowId, workspaceId);
      const nFinal = row.metadata.stepsPersisted as number;
      expect(nFinal).toBe(1); // a single finished step
      // The step content is in the SEEDED row (parts/content), not the ring.
      expect(JSON.stringify(row.metadata.parts)).toContain('Hello');

      // Attach at N_final with the correct anchor: the tail past step 1 is just
      // the terminal frames; step 0's 'Hello' is BELOW the frontier (seeded).
      const sink = liveSink();
      const att = await registry.attach(chatId, rowId, nFinal, sink.cb);
      expect(att).not.toBeNull();
      expect(att!.finished).toBe(true);
      // The synthetic start frame carries the run-fact (runId/chatId), the source
      // of the run-fact on re-attach.
      const start = parseStartFrame(att!.replay);
      expect(start?.messageMetadata).toMatchObject({
        runId: box.runId,
        chatId,
      });
      // The terminal marker is delivered so the client's SDK closes the stream.
      expect(att!.replay.some((f) => f.includes('[DONE]'))).toBe(true);
      // 'Hello' (step 0, below the frontier) is NOT re-streamed — it is seeded.
      expect(att!.replay.some((f) => f.includes('Hello'))).toBe(false);
    } finally {
      registry.onModuleDestroy();
      await cleanup();
    }
  });

  it('anchor mismatch returns null (invariant 6)', async () => {
    const chatId = (await createChat(db, { workspaceId, creatorId: userId })).id;
    const registry = new AiChatStreamRegistryService();
    const runService = new AiChatRunService(runRepo, {
      isCloud: () => false,
    } as never);
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: successStream() }),
    } as any);

    const { cleanup } = await startRun({
      registry,
      runService,
      model,
      chatId,
      body: { chatId, messages: [userUiMessage('Hi')] },
    });
    try {
      await waitFor(async () => {
        const rows = await msgRepo.findAllByChat(chatId, workspaceId);
        return rows.some(
          (r: any) => r.role === 'assistant' && r.status === 'completed',
        );
      });
      const sink = liveSink();
      // A foreign anchor must NOT replay this run's transcript.
      expect(
        await registry.attach(chatId, 'a-different-run-row', 1, sink.cb),
      ).toBeNull();
    } finally {
      registry.onModuleDestroy();
      await cleanup();
    }
  });

  it('an attach opened BEFORE the first frame follows the live stream from frame 0', async () => {
    const chatId = (await createChat(db, { workspaceId, creatorId: userId })).id;
    const registry = new AiChatStreamRegistryService();
    const runService = new AiChatRunService(runRepo, {
      isCloud: () => false,
    } as never);
    const controlled = makeControlledStream();
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: controlled.stream }),
    } as any);

    const { cleanup } = await startRun({
      registry,
      runService,
      model,
      chatId,
      body: { chatId, messages: [userUiMessage('Slow please')] },
    });
    try {
      // Attach while the entry exists (opened at begin) but before any frame.
      const sink = liveSink();
      const att = (await registry.attach(chatId, undefined, 0, sink.cb))!;
      // Nothing streamed yet -> the tail is just the synthetic start frame; the
      // whole live stream (start..DONE) follows via onFrame after start().
      expect(att.replay).toHaveLength(1);
      expect(att.replay[0]).toContain('"type":"start"');
      att.start(); // go live (drains nothing, then follows)

      // Now emit the whole turn.
      controlled.emit({ type: 'stream-start', warnings: [] });
      controlled.emit({ type: 'text-start', id: 't1' });
      controlled.emit({ type: 'text-delta', id: 't1', delta: 'Zero' });
      controlled.emit({ type: 'text-end', id: 't1' });
      controlled.emit({
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      });
      controlled.close();

      await waitFor(() => sink.frames.some((f) => f.includes('[DONE]')));
      // The subscriber saw the stream from the very first frame (`start`) through
      // the terminal marker, with the streamed text present.
      expect(sink.frames.some((f) => f.includes('"type":"start"'))).toBe(true);
      expect(sink.frames.join('')).toContain('Zero');
      expect(sink.frames[sink.frames.length - 1]).toContain('[DONE]');
      expect(sink.ended()).toBe(true);
    } finally {
      registry.onModuleDestroy();
      await cleanup();
    }
  });

  it('requestStop surfaces {"type":"abort"} + [DONE] + end to the attached subscriber', async () => {
    const chatId = (await createChat(db, { workspaceId, creatorId: userId })).id;
    const registry = new AiChatStreamRegistryService();
    const runService = new AiChatRunService(runRepo, {
      isCloud: () => false,
    } as never);
    // An abort-AWARE model: it streams some partial output, then errors the model
    // stream with an AbortError when the run signal aborts — exactly as a real
    // provider network stream is torn down on abort (a plain in-memory stream
    // would just stall, so streamText would never observe the stop).
    const model = new MockLanguageModelV3({
      doStream: async ({ abortSignal }: any) => {
        const stream = new ReadableStream<any>({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 't1' });
            controller.enqueue({ type: 'text-delta', id: 't1', delta: 'partial' });
            abortSignal?.addEventListener('abort', () => {
              try {
                controller.error(
                  new DOMException('Aborted', 'AbortError'),
                );
              } catch {
                /* already errored/closed */
              }
            });
          },
        });
        return { stream };
      },
    } as any);

    const box: { runId?: string } = {};
    const { cleanup } = await startRun({
      registry,
      runService,
      model,
      chatId,
      body: { chatId, messages: [userUiMessage('Start then stop')] },
      box,
    });
    try {
      const sink = liveSink();
      const att = (await registry.attach(chatId, undefined, 0, sink.cb))!;
      att.start();

      // Give streamText a beat to begin consuming the partial output.
      await sleep(250);
      // User presses Stop -> the run signal aborts -> the SDK emits an abort chunk.
      await runService.requestStop(box.runId!, workspaceId);

      await waitFor(() => sink.ended());
      expect(sink.frames.some((f) => f.includes('"type":"abort"'))).toBe(true);
      expect(sink.frames.some((f) => f.includes('[DONE]'))).toBe(true);
      expect(sink.ended()).toBe(true);
    } finally {
      registry.onModuleDestroy();
      await cleanup();
    }
  });

  it('the outer catch calls abortEntry so an open entry is released (finished)', async () => {
    const chatId = (await createChat(db, { workspaceId, creatorId: userId })).id;
    const registry = new AiChatStreamRegistryService();
    const runService = new AiChatRunService(runRepo, {
      isCloud: () => false,
    } as never);
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: successStream() }),
    } as any);

    // A msgRepo whose user-row insert throws: the turn fails AFTER begin (the
    // entry is already open) but BEFORE the pipe, exercising the outer catch.
    const throwingMsgRepo = {
      insert: async () => {
        throw new Error('db boom');
      },
      findAllByChat: (...a: any[]) => (msgRepo as any).findAllByChat(...a),
      update: (...a: any[]) => (msgRepo as any).update(...a),
      findById: (...a: any[]) => (msgRepo as any).findById(...a),
    };
    const service = new AiChatService(
      { getChatModel: async () => null } as any,
      aiChatRepo,
      throwingMsgRepo as any,
      {} as any,
      { resolve: async () => null } as any,
      { forUser: async () => ({}) } as any,
      mcpClients as any,
      {} as any,
      {} as any,
      {} as any,
      {
        isAiChatDeferredToolsEnabled: () => false,
        isAiChatResumableStreamEnabled: () => true,
        isAiChatFinalStepLockdownEnabled: () => false,
        isAiChatViewImageEnabled: () => false,
      } as any,
      registry,
    );
    const { res, cleanup } = await makeRealResponse();
    const box: { runId?: string } = {};
    try {
      await expect(
        service.stream({
          user: { id: userId, workspaceId } as any,
          workspace: { id: workspaceId, name: 'WS' } as any,
          sessionId: 'sess-1',
          body: { chatId, messages: [userUiMessage('will throw')] },
          res: { raw: res } as any,
          signal: new AbortController().signal,
          model: model as any,
          role: null,
          runHooks: makeRunHooks(runService, registry, box),
        } as any),
      ).rejects.toThrow();
      // The entry opened at begin was terminated by abortEntry (from the catch),
      // so it is finished and a plain attach returns null instead of hanging.
      const entry = (registry as any).entries.get(chatId);
      expect(entry).toBeDefined();
      expect(entry.finished).toBe(true);
      const sink = liveSink();
      // Finished with an EMPTY ring (aborted before any frame) -> null -> the
      // client degrades to poll instead of hanging on an empty stream.
      expect(await registry.attach(chatId, undefined, 0, sink.cb)).toBeNull();
    } finally {
      registry.onModuleDestroy();
      await cleanup();
    }
  });

  it('legacy (no run-hooks): the registry is never populated', async () => {
    const chatId = (await createChat(db, { workspaceId, creatorId: userId })).id;
    const registry = new AiChatStreamRegistryService();
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: successStream() }),
    } as any);

    // No runHooks -> runId undefined -> the run-wrapped tee is never wired.
    const { cleanup } = await startRun({
      registry,
      model,
      chatId,
      body: { chatId, messages: [userUiMessage('Legacy hi')] },
    });
    try {
      await waitFor(async () => {
        const rows = await msgRepo.findAllByChat(chatId, workspaceId);
        return rows.some(
          (r: any) => r.role === 'assistant' && r.status === 'completed',
        );
      });
      const sink = liveSink();
      // No entry was ever opened; attach always yields null.
      expect(await registry.attach(chatId, undefined, 0, sink.cb)).toBeNull();
      expect(await registry.attach(chatId, 'anything', 1, sink.cb)).toBeNull();
    } finally {
      registry.onModuleDestroy();
      await cleanup();
    }
  });
});
