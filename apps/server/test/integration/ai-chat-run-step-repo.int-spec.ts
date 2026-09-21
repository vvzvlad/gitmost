import { randomBytes } from 'crypto';
import { Kysely } from 'kysely';
import { AiChatRunStepRepo } from '@docmost/db/repos/ai-chat/ai-chat-run-step.repo';
import { AiChatMessageRepo } from '@docmost/db/repos/ai-chat/ai-chat-message.repo';
import {
  assistantParts,
  reconstructRunParts,
  hydrateAssistantParts,
  stepMarkerMetadata,
  rowHasInlineParts,
} from '../../src/core/ai-chat/ai-chat.service';
import {
  getTestDb,
  destroyTestDb,
  createWorkspace,
  createUser,
  createChat,
} from './db';

/**
 * #492 append-persist — the reconstruct CONTRACT on a live Postgres. Proves that a
 * turn persisted the NEW way (per-step rows in `ai_chat_run_steps`, only a step
 * marker on the message row) reconstructs to the SAME UI parts as a turn persisted
 * the OLD way (full `metadata.parts` inline on the row, no step rows) — so the
 * era-switch is invisible to attach / delta-poll / export. Real repos + real jsonb
 * roundtrip, not a mock (a mock cannot prove the parts survive the jsonb column
 * byte-identical).
 */
type Step = {
  text: string;
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  toolResults: Array<{ toolCallId: string; toolName: string; output: unknown }>;
};

// A realistic step: some text + a getPage tool call whose ~100 KB body is
// INCOMPRESSIBLE random base64 (a 'x'.repeat filler would TOAST away and hide the
// real bytes). Under MAX_TOOL_OUTPUT_BYTES (200 KB) it is stored uncompacted.
function makeStep(i: number, outputBytes = 4_000): Step {
  const body = randomBytes(Math.ceil(outputBytes * 0.75)).toString('base64');
  return {
    text: `step ${i} text`,
    toolCalls: [
      { toolCallId: `c${i}`, toolName: 'getPage', input: { id: `p${i}` } },
    ],
    toolResults: [
      {
        toolCallId: `c${i}`,
        toolName: 'getPage',
        output: { id: `p${i}`, title: `Page ${i}`, body },
      },
    ],
  };
}

describe('AiChatRunStepRepo + reconstruct contract [integration]', () => {
  let db: Kysely<any>;
  let stepRepo: AiChatRunStepRepo;
  let msgRepo: AiChatMessageRepo;
  let workspaceId: string;
  let userId: string;
  let chatId: string;

  beforeAll(async () => {
    db = getTestDb();
    stepRepo = new AiChatRunStepRepo(db as any);
    msgRepo = new AiChatMessageRepo(db as any);
    workspaceId = (await createWorkspace(db)).id;
    userId = (await createUser(db, workspaceId)).id;
    chatId = (await createChat(db, { workspaceId, creatorId: userId })).id;
  });

  afterAll(async () => {
    await destroyTestDb();
  });

  const seedRow = (metadata: unknown, status: string) =>
    msgRepo.insert({
      chatId,
      workspaceId,
      userId,
      role: 'assistant',
      content: '',
      status,
      metadata: metadata as never,
    });

  it('insertStep is idempotent per (message, stepIndex) and reads back in order', async () => {
    const row = await seedRow(stepMarkerMetadata(0), 'streaming');
    const parts0 = assistantParts([makeStep(0)], '');
    const parts1 = assistantParts([makeStep(1)], '');

    expect(await stepRepo.insertStep(row.id, workspaceId, 0, parts0)).toBe(true);
    expect(await stepRepo.insertStep(row.id, workspaceId, 1, parts1)).toBe(true);
    // A retried persist of the SAME step is a no-op (ON CONFLICT DO NOTHING).
    expect(await stepRepo.insertStep(row.id, workspaceId, 0, parts0)).toBe(
      false,
    );

    const steps = await stepRepo.findByMessage(row.id, workspaceId);
    expect(steps.map((s) => s.stepIndex)).toEqual([0, 1]);

    // Batch fetch groups by message id in step order.
    const map = await stepRepo.findByMessageIds([row.id], workspaceId);
    expect(map.get(row.id)!.map((s) => s.stepIndex)).toEqual([0, 1]);
  });

  it('a NEW-style (step-table) run reconstructs identically to an OLD-style (inline) run', async () => {
    const steps = [makeStep(10), makeStep(11)];
    // The inline parts the OLD full-row flush would have written.
    const fullParts = assistantParts(steps, '');

    // OLD-style record: full parts inline on the row, NO step rows.
    const oldRow = await seedRow(
      { parts: fullParts, toolTraceVersion: 2, stepsPersisted: 2 },
      'completed',
    );

    // NEW-style record: only a step marker on the row + per-step rows.
    const newRow = await seedRow(stepMarkerMetadata(2), 'streaming');
    for (let i = 0; i < steps.length; i++) {
      await stepRepo.insertStep(
        newRow.id,
        workspaceId,
        i,
        assistantParts([steps[i]], ''),
      );
    }

    // Re-read both from the DB (proves the jsonb roundtrip).
    const oldFetched = await msgRepo.findById(oldRow.id, workspaceId);
    const newFetched = await msgRepo.findById(newRow.id, workspaceId);
    const oldSteps = await stepRepo.findByMessage(oldRow.id, workspaceId);
    const newSteps = await stepRepo.findByMessage(newRow.id, workspaceId);

    // The discriminator: the old row carries inline parts, the new one does not.
    expect(rowHasInlineParts(oldFetched!)).toBe(true);
    expect(rowHasInlineParts(newFetched!)).toBe(false);
    expect(oldSteps).toHaveLength(0);
    expect(newSteps).toHaveLength(2);

    const oldRecon = reconstructRunParts(oldFetched!, oldSteps);
    const newRecon = reconstructRunParts(newFetched!, newSteps);

    // Both reconstruct to the SAME parts + step count — the era is invisible.
    expect(newRecon.parts).toEqual(fullParts);
    expect(oldRecon.parts).toEqual(fullParts);
    expect(newRecon.parts).toEqual(oldRecon.parts);
    expect(newRecon.stepsPersisted).toBe(2);
    expect(oldRecon.stepsPersisted).toBe(2);

    // hydrateAssistantParts fills the new row's metadata.parts to match the old
    // row's inline parts — so a consumer reading `metadata.parts` off the raw row
    // (the client seed/poll, export) is unchanged across the era.
    const map = await stepRepo.findByMessageIds([newRow.id], workspaceId);
    const [hydrated] = hydrateAssistantParts([newFetched!], map);
    expect((hydrated.metadata as { parts: unknown }).parts).toEqual(fullParts);
    // A row that already has inline parts passes through untouched (same ref-shape).
    const [oldPassThrough] = hydrateAssistantParts([oldFetched!], map);
    expect((oldPassThrough.metadata as { parts: unknown }).parts).toEqual(
      fullParts,
    );
  });
});
