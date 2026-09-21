import * as http from 'node:http';
import { Kysely } from 'kysely';
import { tool } from 'ai';
import { z } from 'zod';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { AiChatRepo } from '@docmost/db/repos/ai-chat/ai-chat.repo';
import { AiChatMessageRepo } from '@docmost/db/repos/ai-chat/ai-chat-message.repo';
import { AiChatRunStepRepo } from '@docmost/db/repos/ai-chat/ai-chat-run-step.repo';
import {
  AiChatService,
  assembleStepParts,
  assistantParts,
  rowHasInlineParts,
  stepMarkerMetadata,
} from 'src/core/ai-chat/ai-chat.service';
import {
  getTestDb,
  destroyTestDb,
  createWorkspace,
  createUser,
  createChat,
  createMessage,
} from './db';

/**
 * #492 append-persist — the REAL onStep WRITE path (F2) and the model-REPLAY
 * hydration path (F1), driven through `AiChatService.stream` against a LIVE
 * Postgres with a REAL `AiChatRunStepRepo` INJECTED. The existing append-persist
 * int-specs hand-roll the insert+marker cycle via the repos directly and build
 * the service with `aiChatRunStepRepo: undefined` (only the legacy-fallback branch
 * is covered), so an off-by-one on `stepsPersisted-1`, a wrong `capturedSteps`
 * slice, or a broken marker payload would pass all of them. These tests exercise
 * the actual `updateStreaming` append-persist branch end to end.
 *
 * The seam is the injected `model` (a seeded `MockLanguageModelV3` from `ai/test`)
 * plus a REAL Node `ServerResponse` as the hijacked socket — mirrors
 * ai-chat-stream.int-spec.ts.
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

// A real Node ServerResponse wired to a live socket (identical helper to the
// stream int-spec) so the SDK's pipe/heartbeat writes behave as in prod.
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

// Stream parts for a normal, successful single-step turn.
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

// A THREE-step turn: steps 0 and 1 each emit text + an `echo` tool call (the SDK
// runs the tool and continues); step 2 answers and stops. Three steps is
// deliberate: the LAST finished step's append-persist write races the terminal
// finalize (which writes the full inline parts anyway, so a lost last-step row is
// by design), but the NON-final steps 0 and 1 always drain to the steps table
// before finalize — so those are what the test asserts on deterministically.
function threeStepModel(): MockLanguageModelV3 {
  let step = 0;
  const toolStep = (i: number) => ({
    stream: convertArrayToReadableStream([
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: `s${i}` },
      { type: 'text-delta', id: `s${i}`, delta: `step ${i} ` },
      { type: 'text-end', id: `s${i}` },
      {
        type: 'tool-call',
        toolCallId: `c${i}`,
        toolName: 'echo',
        input: JSON.stringify({ msg: `m${i}` }),
      },
      {
        type: 'finish',
        finishReason: 'tool-calls',
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      },
    ] as any),
  });
  return new MockLanguageModelV3({
    doStream: async () => {
      const n = step++;
      // Realistic inter-step latency. A real model spends seconds per step, so the
      // fire-and-forget per-step write chain drains to the steps table BETWEEN
      // steps; the mock otherwise collapses all steps into microseconds and the
      // terminal finalize wins the race before any but the first step persists.
      if (n > 0) await sleep(200);
      if (n < 2) return toolStep(n);
      return {
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 's2' },
          { type: 'text-delta', id: 's2', delta: 'final answer' },
          { type: 'text-end', id: 's2' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 },
          },
        ] as any),
      };
    },
  } as any);
}

describe('#492 append-persist service paths [integration]', () => {
  let db: Kysely<any>;
  let aiChatRepo: AiChatRepo;
  let msgRepo: AiChatMessageRepo;
  let stepRepo: AiChatRunStepRepo;
  let workspaceId: string;
  let userId: string;

  let closeCalls: number;
  const mcpClients = {
    toolsFor: async () => ({
      tools: {},
      clients: [
        {
          close: async () => {
            closeCalls += 1;
          },
        },
      ],
      outcomes: [],
      instructions: [],
    }),
  };

  // Build the service WITH a REAL AiChatRunStepRepo injected (the property under
  // test) — unlike the legacy-fallback harness that passes it as undefined.
  const echoTool = tool({
    description: 'echo the message back',
    inputSchema: z.object({ msg: z.string() }),
    execute: async ({ msg }) => ({ echoed: msg }),
  });

  function buildService(): AiChatService {
    return new AiChatService(
      { getChatModel: async () => null } as any,
      aiChatRepo,
      msgRepo,
      {} as any, // aiChatPageSnapshotRepo
      { resolve: async () => null } as any, // aiSettings
      { forUser: async () => ({ echo: echoTool }) } as any, // tools
      mcpClients as any,
      {} as any, // aiAgentRoleRepo
      {} as any, // pageRepo
      {} as any, // pageAccess
      {
        isAiChatDeferredToolsEnabled: () => false,
        isAiChatFinalStepLockdownEnabled: () => false,
        isAiChatViewImageEnabled: () => false,
      } as any, // environment (deferred OFF -> all tools active every step)
      undefined, // streamRegistry
      undefined, // aiChatRunService
      stepRepo, // #492 aiChatRunStepRepo — the append-persist backend
    );
  }

  function userUiMessage(text: string) {
    return {
      id: `u-${Math.random()}`,
      role: 'user',
      parts: [{ type: 'text', text }],
    };
  }

  async function runStream(opts: {
    model: MockLanguageModelV3;
    chatId: string;
    body: any;
  }): Promise<void> {
    closeCalls = 0;
    const service = buildService();
    const { res, cleanup } = await makeRealResponse();
    try {
      await service.stream({
        user: { id: userId, workspaceId } as any,
        workspace: { id: workspaceId, name: 'WS' } as any,
        sessionId: 'sess-1',
        body: opts.body,
        res: { raw: res } as any,
        signal: new AbortController().signal,
        model: opts.model as any,
        role: null,
      } as any);
      await waitFor(async () => {
        const rows = await msgRepo.findAllByChat(opts.chatId, workspaceId);
        return rows.some(
          (r) =>
            r.role === 'assistant' &&
            ['completed', 'error', 'aborted'].includes(r.status as string),
        );
      });
      await waitFor(() => closeCalls > 0, { timeoutMs: 5_000 });
    } finally {
      await cleanup();
    }
  }

  beforeAll(async () => {
    db = getTestDb();
    aiChatRepo = new AiChatRepo(db as any);
    msgRepo = new AiChatMessageRepo(db as any);
    stepRepo = new AiChatRunStepRepo(db as any);
    workspaceId = (await createWorkspace(db)).id;
    userId = (await createUser(db, workspaceId)).id;
  });

  afterAll(async () => {
    await destroyTestDb();
  });

  // --- F2: the real onStep append-persist WRITE branch -----------------------
  it('drives steps through the real onStep path: per-step rows + marker match a single-row flush', async () => {
    const chatId = (await createChat(db, { workspaceId, creatorId: userId })).id;
    const model = threeStepModel();

    // Capture the mid-run step-marker UPDATEs the append-persist branch writes on
    // the assistant row (a { parts: [], toolTraceVersion, stepsPersisted } patch).
    const updateSpy = jest.spyOn(msgRepo, 'update');
    try {
      await runStream({
        model,
        chatId,
        body: { chatId, messages: [userUiMessage('call the tool then answer')] },
      });

      const rows = await msgRepo.findAllByChat(chatId, workspaceId);
      const assistant = rows.find((r) => r.role === 'assistant')!;
      expect(assistant).toBeDefined();
      expect(assistant.status).toBe('completed');
      // The turn finalizes with the FULL inline parts assembled by a single-row
      // flush (assistantParts over every step) — the baseline the per-step slices
      // must reproduce.
      expect(rowHasInlineParts(assistant)).toBe(true);
      const finalParts = (assistant.metadata as { parts: any[] }).parts;

      // The two NON-final finished steps each landed their own row, in stepIndex
      // order. (The fire-and-forget write chain drains before the next step, so
      // poll until both are on disk; the LAST step's write may lose the finalize
      // race, which is by design — its parts are already in `finalParts`.)
      await waitFor(async () => {
        const s = await stepRepo.findByMessage(assistant.id, workspaceId);
        return s.length >= 2;
      });
      const steps = await stepRepo.findByMessage(assistant.id, workspaceId);
      expect(steps[0].stepIndex).toBe(0);
      expect(steps[1].stepIndex).toBe(1);

      // Each per-step row carries a NON-trivial slice: this step's text part + its
      // paired tool part (guards a mutation that persists empty/whole-turn parts).
      const s0 = steps[0].parts as any[];
      expect(s0).toContainEqual({ type: 'text', text: 'step 0 ' });
      expect(s0.some((p) => p.type === 'tool-echo')).toBe(true);

      // The per-step slices are EXACTLY the corresponding prefix of the single-row
      // flush: assembleStepParts([step0, step1]) === finalParts[0 .. len0+len1].
      // This is what an off-by-one on `stepsPersisted-1` (a wrong `capturedSteps`
      // slice) or a shifted stepIndex breaks — the prefix no longer aligns.
      const prefixLen =
        (steps[0].parts as any[]).length + (steps[1].parts as any[]).length;
      expect(assembleStepParts([steps[0], steps[1]] as any)).toEqual(
        finalParts.slice(0, prefixLen),
      );

      // The mid-run step markers advanced 1 -> 2 -> ... (the resume frontier), each
      // a shape-stable empty-parts marker equal to a single-row flush's marker.
      const markerCounts = updateSpy.mock.calls
        .map((c) => (c[2] as any)?.metadata)
        .filter(
          (m) =>
            m &&
            Array.isArray(m.parts) &&
            m.parts.length === 0 &&
            typeof m.stepsPersisted === 'number',
        )
        .map((m) => m.stepsPersisted);
      // Monotonic from 1, covering at least the two non-final steps.
      expect(markerCounts.slice(0, 2)).toEqual([1, 2]);
      expect(
        updateSpy.mock.calls
          .map((c) => (c[2] as any)?.metadata)
          .find((m) => m && m.stepsPersisted === 2),
      ).toEqual(stepMarkerMetadata(2));
    } finally {
      updateSpy.mockRestore();
    }
  }, 60_000);

  // --- F1: model-REPLAY hydrates a hard-crashed mid-run turn from the steps table
  it('replays a hard-crashed mid-run turn WITH its partial steps hydrated from the steps table', async () => {
    const chatId = (await createChat(db, { workspaceId, creatorId: userId })).id;

    // Prior turn: a genuine user question...
    await createMessage(db, {
      workspaceId,
      chatId,
      userId,
      role: 'user',
      content: 'What is in the design doc?',
      createdAt: new Date(Date.now() - 3000),
    });
    // ...and an assistant row that a HARD crash (SIGKILL/OOM) left mid-run: only a
    // step marker on the row (metadata.parts:[] , content:''), NO terminal
    // callback ever fired, so its real parts live ONLY in ai_chat_run_steps.
    const crashed = await createMessage(db, {
      workspaceId,
      chatId,
      role: 'assistant',
      content: '',
      status: 'aborted',
      metadata: stepMarkerMetadata(1),
      createdAt: new Date(Date.now() - 2000),
    });
    // The durable partial step: some reasoning text + a completed getPage tool
    // call (input + output), exactly what #183 step-granular durability preserves.
    await stepRepo.insertStep(
      crashed.id,
      workspaceId,
      0,
      assistantParts(
        [
          {
            text: 'HYDRATED_PARTIAL_STEP the doc says',
            toolCalls: [
              { toolCallId: 'g1', toolName: 'getPage', input: { id: 'p1' } },
            ],
            toolResults: [
              {
                toolCallId: 'g1',
                toolName: 'getPage',
                output: { id: 'p1', body: 'PARTIAL_TOOL_OUTPUT budget section' },
              },
            ],
          } as any,
        ],
        '',
      ),
    );

    // The NEXT turn: the model just answers. The service must REPLAY the crashed
    // assistant turn with its partial parts hydrated from the steps table.
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: successStream() }),
    } as any);
    await runStream({
      model,
      chatId,
      body: { chatId, messages: [userUiMessage('Continue please')] },
    });

    expect(model.doStreamCalls.length).toBeGreaterThan(0);
    const prompt = JSON.stringify(model.doStreamCalls[0].prompt);
    // The partial step's TEXT reached the model context (it would be an empty text
    // part without hydration — rowToUiMessage falls back to `content:''`).
    expect(prompt).toContain('HYDRATED_PARTIAL_STEP');
    // The partial TOOL RESULT survived too (durable in the steps table, replayed).
    expect(prompt).toContain('PARTIAL_TOOL_OUTPUT');
    // The genuine prior user turn is present as well (sanity: real history replay).
    expect(prompt).toContain('What is in the design doc?');
  }, 60_000);
});
