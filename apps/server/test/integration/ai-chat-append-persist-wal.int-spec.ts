import { randomBytes } from 'crypto';
import { Kysely, sql } from 'kysely';
import { AiChatRunStepRepo } from '@docmost/db/repos/ai-chat/ai-chat-run-step.repo';
import { AiChatMessageRepo } from '@docmost/db/repos/ai-chat/ai-chat-message.repo';
import {
  assistantParts,
  flushAssistant,
  stepMarkerMetadata,
} from '../../src/core/ai-chat/ai-chat.service';
import {
  getTestDb,
  destroyTestDb,
  createWorkspace,
  createUser,
  createChat,
} from './db';

/**
 * #492 append-persist — WRITE-VOLUME regression on a LIVE Postgres, measured via
 * the `pg_current_wal_lsn()` delta around a realistic multi-step run driven through
 * the REAL repos (not a mock — a mock cannot observe MVCC/TOAST rewrite volume, the
 * whole point). Proves the core claim:
 *
 *   NEW (per-step INSERT into ai_chat_run_steps + a CHEAP step-marker UPDATE on the
 *   message row) writes O(Σ steps) of WAL — each step writes only its own bytes.
 *
 *   OLD (the pre-#492 full-row rewrite: re-persist the GROWING metadata.parts on
 *   every onStepFinish) writes O(n²) — step k rewrites the whole TOASTed jsonb of
 *   all k prior outputs.
 *
 * The OLD path here IS the reverted behavior, so this doubles as the mutation
 * check: swapping the new path back to `flushAssistant` full-row UPDATEs reddens
 * the assertion (OLD is many times larger).
 */
type Step = {
  text: string;
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  toolResults: Array<{ toolCallId: string; toolName: string; output: unknown }>;
};

// ~100 KB INCOMPRESSIBLE output per step (a page read). Random base64 so TOAST
// cannot compress it away and hide the real write volume.
function makeStep(i: number, outputBytes = 100_000): Step {
  const body = randomBytes(Math.ceil(outputBytes * 0.75)).toString('base64');
  return {
    text: `step ${i} reasoning`,
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

async function walDelta(
  db: Kysely<any>,
  fn: () => Promise<void>,
): Promise<number> {
  const before = (
    await sql<{ l: string }>`select pg_current_wal_lsn() as l`.execute(db)
  ).rows[0].l;
  await fn();
  // NOTE: no pg_switch_wal() — a segment switch pads the LSN to the next 16 MB
  // boundary and would swamp the delta. The raw LSN advances by the WAL bytes.
  const after = (
    await sql<{ l: string }>`select pg_current_wal_lsn() as l`.execute(db)
  ).rows[0].l;
  return Number(
    (
      await sql<{
        d: string;
      }>`select pg_wal_lsn_diff(${after}::pg_lsn, ${before}::pg_lsn) as d`.execute(
        db,
      )
    ).rows[0].d,
  );
}

describe('#492 append-persist write volume (pg_current_wal_lsn delta) [integration]', () => {
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

  const seedRow = () =>
    msgRepo.insert({
      chatId,
      workspaceId,
      userId,
      role: 'assistant',
      content: '',
      status: 'streaming',
      metadata: stepMarkerMetadata(0) as never,
    });

  const STEPS = 40;

  it('NEW per-step INSERT is O(Σ steps); OLD full-row rewrite is O(n²)', async () => {
    const steps: Step[] = [];
    for (let i = 0; i < STEPS; i++) steps.push(makeStep(i));

    // NEW: per-step INSERT of THIS step's parts + a cheap marker UPDATE.
    const newRow = await seedRow();
    const newWal = await walDelta(db, async () => {
      for (let i = 0; i < STEPS; i++) {
        await stepRepo.insertStep(
          newRow.id,
          workspaceId,
          i,
          assistantParts([steps[i]], ''),
        );
        await msgRepo.update(
          newRow.id,
          workspaceId,
          { metadata: stepMarkerMetadata(i + 1) },
          { onlyIfStreaming: true },
        );
      }
    });

    // OLD (the pre-#492 revert): re-persist the GROWING metadata.parts on the
    // message row on every step.
    const oldRow = await seedRow();
    const oldWal = await walDelta(db, async () => {
      const acc: Step[] = [];
      for (let i = 0; i < STEPS; i++) {
        acc.push(steps[i]);
        await msgRepo.update(
          oldRow.id,
          workspaceId,
          flushAssistant(acc as never, '', 'streaming'),
          { onlyIfStreaming: true },
        );
      }
    });

    // eslint-disable-next-line no-console
    console.log(
      `[#492 WAL] ${STEPS} steps ×100KB: new=${(newWal / 1e6).toFixed(1)}MB ` +
        `old=${(oldWal / 1e6).toFixed(1)}MB (${(oldWal / newWal).toFixed(
          1,
        )}x smaller)`,
    );

    // O(Σ steps): ~STEPS × (100KB output + marker) of WAL. 40 × ~100KB parts plus
    // 40 tiny markers is a few tens of MB at most — bounded, linear in step count.
    expect(newWal).toBeLessThan(30_000_000);
    // O(n²): step k rewrites ~k × 100KB. Σ over 40 steps ≈ 80+ MB — far larger.
    expect(oldWal).toBeGreaterThan(30_000_000);
    // The load-bearing claim: the new path writes a small FRACTION of the old.
    expect(newWal).toBeLessThan(oldWal * 0.35);
  }, 120_000);
});
