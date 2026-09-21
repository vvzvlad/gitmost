import { Kysely } from 'kysely';
import { AiChatController } from 'src/core/ai-chat/ai-chat.controller';
import {
  assembleStepParts,
  assistantParts,
  stepMarkerMetadata,
} from 'src/core/ai-chat/ai-chat.service';
import { AiChatRepo } from '@docmost/db/repos/ai-chat/ai-chat.repo';
import { AiChatMessageRepo } from '@docmost/db/repos/ai-chat/ai-chat-message.repo';
import { AiChatRunStepRepo } from '@docmost/db/repos/ai-chat/ai-chat-run-step.repo';
import type { User, Workspace } from '@docmost/db/types/entity.types';
import {
  getTestDb,
  destroyTestDb,
  createWorkspace,
  createUser,
  createChat,
  createMessage,
} from './db';

/**
 * #492 controller hydration (crash-before-finalize RESUME) on a LIVE Postgres.
 * `AiChatController.withReconstructedParts` is wired into getMessages/delta/export/
 * run, but `aiChatRunStepRepo` is OPTIONAL and every controller unit spec passes it
 * as `undefined`, so the hydration branch early-returns and NEVER executes in those
 * tests. This drives the real read path — a mid-run streaming row (marker only,
 * empty inline parts) PLUS its `ai_chat_run_steps` rows — through getMessages WITH
 * the repo present, exercising the `role==='assistant' && !rowHasInlineParts`
 * needy predicate, the workspace-scoped batch step fetch, and the endpoint binding.
 */
describe('#492 controller hydration read path [integration]', () => {
  let db: Kysely<any>;
  let aiChatRepo: AiChatRepo;
  let msgRepo: AiChatMessageRepo;
  let stepRepo: AiChatRunStepRepo;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let userId: string;

  // Build the controller WITH a real AiChatRunStepRepo injected (position 9), the
  // seam the unit specs leave undefined. Only the read-path deps are real.
  function buildController(): AiChatController {
    return new AiChatController(
      {} as any, // aiChatService
      {} as any, // aiChatRunService
      aiChatRepo,
      msgRepo,
      {} as any, // aiTranscription
      {} as any, // pageRepo
      undefined, // streamRegistry
      undefined, // environment
      stepRepo, // #492 aiChatRunStepRepo
    );
  }

  beforeAll(async () => {
    db = getTestDb();
    aiChatRepo = new AiChatRepo(db as any);
    msgRepo = new AiChatMessageRepo(db as any);
    stepRepo = new AiChatRunStepRepo(db as any);
    workspaceId = (await createWorkspace(db)).id;
    otherWorkspaceId = (await createWorkspace(db)).id;
    userId = (await createUser(db, workspaceId)).id;
  });

  afterAll(async () => {
    await destroyTestDb();
  });

  it('getMessages reconstructs a mid-run row from the steps table (finished rows untouched)', async () => {
    const chatId = (
      await createChat(db, { workspaceId, creatorId: userId })
    ).id;
    const user = { id: userId } as User;
    const workspace = { id: workspaceId } as Workspace;

    // A prior FINISHED assistant row that already carries inline parts — the needy
    // predicate must SKIP it (no step fetch), returned untouched.
    const finishedParts = assistantParts(
      [{ text: 'done earlier', toolCalls: [], toolResults: [] } as any],
      '',
    );
    await createMessage(db, {
      workspaceId,
      chatId,
      role: 'assistant',
      content: 'done earlier',
      status: 'completed',
      metadata: { parts: finishedParts, toolTraceVersion: 2, stepsPersisted: 1 },
      createdAt: new Date(Date.now() - 3000),
    });

    // The mid-run row a crash-before-finalize left behind: a step marker only
    // (parts:[] , content:''), status 'streaming'. Its real parts live ONLY in the
    // steps table.
    const midRun = await createMessage(db, {
      workspaceId,
      chatId,
      role: 'assistant',
      content: '',
      status: 'streaming',
      metadata: stepMarkerMetadata(2),
      createdAt: new Date(Date.now() - 1000),
    });

    const step0 = assistantParts(
      [
        {
          text: 'reasoning about the page',
          toolCalls: [
            { toolCallId: 'g1', toolName: 'getPage', input: { id: 'p1' } },
          ],
          toolResults: [
            { toolCallId: 'g1', toolName: 'getPage', output: { id: 'p1', body: 'B' } },
          ],
        } as any,
      ],
      '',
    );
    const step1 = assistantParts(
      [{ text: 'partial synthesis so far', toolCalls: [], toolResults: [] } as any],
      '',
    );
    await stepRepo.insertStep(midRun.id, workspaceId, 0, step0);
    await stepRepo.insertStep(midRun.id, workspaceId, 1, step1);

    // Workspace-scoping guard: a step row for the SAME message id under a DIFFERENT
    // workspace must NEVER leak into this workspace's reconstruction.
    await stepRepo.insertStep(midRun.id, otherWorkspaceId, 99, [
      { type: 'text', text: 'FOREIGN_WORKSPACE_LEAK' },
    ]);

    const res = await buildController().getMessages(
      { chatId } as any,
      { limit: 50 } as any,
      user,
      workspace,
    );

    const items = res.items as any[];
    const finished = items.find((r) => r.status === 'completed');
    const reconstructed = items.find((r) => r.id === midRun.id);

    // The finished row passed through with its inline parts unchanged.
    expect(finished.metadata.parts).toEqual(finishedParts);

    // The mid-run row's parts were reconstructed from the two step rows, in order,
    // exactly as assembleStepParts concatenates them — the client seed sees the
    // persisted progress with no change to itself.
    const expected = assembleStepParts([
      { stepIndex: 0, parts: step0 },
      { stepIndex: 1, parts: step1 },
    ] as any);
    expect(reconstructed.metadata.parts).toEqual(expected);
    // The foreign-workspace step row did NOT leak in.
    expect(JSON.stringify(reconstructed.metadata.parts)).not.toContain(
      'FOREIGN_WORKSPACE_LEAK',
    );
    // Sanity: reconstruction produced real content (text + the paired tool part +
    // the second step's text), not an empty fallback.
    expect(reconstructed.metadata.parts).toContainEqual({
      type: 'text',
      text: 'reasoning about the page',
    });
    expect(
      (reconstructed.metadata.parts as any[]).some((p) => p.type === 'tool-getPage'),
    ).toBe(true);
  }, 60_000);
});
