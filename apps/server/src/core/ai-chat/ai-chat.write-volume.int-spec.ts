import { randomBytes } from 'crypto';
import { Client } from 'pg';
import {
  flushAssistant,
  serializeSteps,
  lastAssistantReplayOverflowCount,
} from './ai-chat.service';
import type { AiChatMessage } from '@docmost/db/types/entity.types';

/**
 * #490 write-volume regression — an OBSERVABLE-PROPERTY test on a LIVE Postgres,
 * not "bytes through a mock repo" (a mock measures exactly the thing that does not
 * hurt). It drives a realistic 50-step run where each step returns a ~100 KB tool
 * output and, at every `onStepFinish`, UPDATEs the assistant row the way the
 * service does — then reads the REAL write volume via the `pg_current_wal_lsn()`
 * delta around the run.
 *
 * The property proven: v2 stores each tool OUTPUT only in `metadata.parts`, no
 * longer ALSO in the `tool_calls` trace. So:
 *   1. the trace (`tool_calls`) column's write volume is now O(Σ steps) — tiny,
 *      linear outcome flags — vs the pre-#490 O(N²) that re-persisted every prior
 *      output on every step; and
 *   2. the FULL-row write volume drops sharply (the duplicated output copy is gone).
 *
 * Connects to the local gitmost test Postgres (docker `gitmost-test-pg` on :5432);
 * SKIPS cleanly when that DB is not reachable so it never breaks a DB-less CI.
 */
const CONN =
  process.env.WAL_TEST_DATABASE_URL ??
  'postgresql://docmost:docmost_dev_pw@localhost:5432/docmost';

// A step whose tool output is ~100 KB (a page read), in the SDK StepLike shape.
// The body is INCOMPRESSIBLE random text — a `'x'.repeat()` filler would TOAST-
// compress to nothing and hide the real write volume (a page body does not).
function makeStep(i: number, outputBytes = 100_000) {
  const body = randomBytes(Math.ceil(outputBytes * 0.75)).toString('base64');
  return {
    text: `step ${i} reasoning`,
    toolCalls: [{ toolCallId: `c${i}`, toolName: 'getPage', input: { id: `p${i}` } }],
    toolResults: [
      {
        toolCallId: `c${i}`,
        toolName: 'getPage',
        output: { id: `p${i}`, title: `Page ${i}`, body },
      },
    ],
  };
}

// The pre-#490 (v1) trace: outputs stored a SECOND time in `tool_calls`
// (the duplication #490 removed). Mirrors the OLD serializeSteps shape.
function v1Trace(steps: ReturnType<typeof makeStep>[]): unknown {
  const calls: unknown[] = [];
  for (const s of steps) {
    for (const c of s.toolCalls) calls.push({ toolName: c.toolName, input: c.input });
    for (const r of s.toolResults)
      calls.push({ toolName: r.toolName, output: r.output });
  }
  return calls;
}

async function walDelta(
  client: Client,
  fn: () => Promise<void>,
): Promise<number> {
  const before = (await client.query('SELECT pg_current_wal_lsn() AS l')).rows[0]
    .l as string;
  await fn();
  // NOTE: do NOT pg_switch_wal() here — a segment switch pads the LSN to the next
  // 16 MB boundary and would swamp the actual write delta. The raw LSN advances by
  // the bytes of WAL emitted, which is exactly what we want to measure.
  const after = (await client.query('SELECT pg_current_wal_lsn() AS l')).rows[0]
    .l as string;
  return Number(
    (await client.query('SELECT pg_wal_lsn_diff($1,$2) AS d', [after, before]))
      .rows[0].d,
  );
}

describe('#490 write-volume on a live Postgres (pg_current_wal_lsn delta)', () => {
  let client: Client | undefined;
  let available = false;

  beforeAll(async () => {
    try {
      client = new Client(CONN);
      await client.connect();
      await client.query('SELECT pg_current_wal_lsn()');
      available = true;
    } catch {
      available = false;
      client = undefined;
    }
  });

  afterAll(async () => {
    await client?.end().catch(() => undefined);
  });

  const STEPS = 50;

  it('v2 trace write volume is O(Σ steps) — a tiny fraction of the v1 duplicate', async () => {
    if (!available || !client) {
      console.warn('SKIP: gitmost-test-pg not reachable; skipping WAL test.');
      return;
    }
    const c = client;
    // Isolated table so we measure only the tool_calls (trace) column's writes.
    await c.query('DROP TABLE IF EXISTS _wal_trace');
    await c.query('CREATE TABLE _wal_trace(id int primary key, tool_calls jsonb)');
    await c.query("INSERT INTO _wal_trace VALUES (1, '[]'::jsonb)");

    const steps: ReturnType<typeof makeStep>[] = [];

    // v1: each step re-persists ALL prior outputs into the trace (the O(N²) churn).
    const v1 = await walDelta(c, async () => {
      const acc: ReturnType<typeof makeStep>[] = [];
      for (let i = 0; i < STEPS; i++) {
        acc.push(makeStep(i));
        await c.query('UPDATE _wal_trace SET tool_calls=$1 WHERE id=1', [
          JSON.stringify(v1Trace(acc)),
        ]);
      }
      steps.push(...acc);
    });

    await c.query("UPDATE _wal_trace SET tool_calls='[]'::jsonb WHERE id=1");

    // v2: the REAL serializeSteps — outcome flags only, NO outputs.
    const v2 = await walDelta(c, async () => {
      const acc: ReturnType<typeof makeStep>[] = [];
      for (let i = 0; i < STEPS; i++) {
        acc.push(makeStep(i));
        await c.query('UPDATE _wal_trace SET tool_calls=$1 WHERE id=1', [
          JSON.stringify(serializeSteps(acc)),
        ]);
      }
    });

    await c.query('DROP TABLE IF EXISTS _wal_trace');

    // eslint-disable-next-line no-console
    console.log(
      `[#490 WAL] trace column over ${STEPS} steps: v1=${(v1 / 1e6).toFixed(1)}MB ` +
        `v2=${(v2 / 1e6).toFixed(2)}MB (${(v1 / v2).toFixed(0)}x smaller)`,
    );

    // The trace no longer carries outputs: v2 is a tiny fraction of v1's WAL.
    expect(v2).toBeLessThan(v1 * 0.1);
    // And v2's trace WAL is small in absolute terms — O(Σ steps) of flags, not
    // O(N² × output). 50 steps of ~40-byte flags is well under a few MB of WAL.
    expect(v2).toBeLessThan(5_000_000);
    // v1's duplicate alone is huge (≈ the 100 KB output re-written N² times).
    expect(v1).toBeGreaterThan(50_000_000);
  }, 120_000);

  it('the full assistant row write drops sharply once the duplicate is gone', async () => {
    if (!available || !client) return;
    const c = client;
    await c.query('DROP TABLE IF EXISTS _wal_full');
    await c.query(
      'CREATE TABLE _wal_full(id int primary key, content text, tool_calls jsonb, metadata jsonb, status text)',
    );
    await c.query("INSERT INTO _wal_full VALUES (1, '', '[]'::jsonb, '{}'::jsonb, 'streaming')");

    const writeRow = async (patch: {
      content: string;
      toolCalls: unknown;
      metadata: unknown;
      status: string;
    }) =>
      c.query(
        'UPDATE _wal_full SET content=$1, tool_calls=$2, metadata=$3, status=$4 WHERE id=1',
        [
          patch.content,
          JSON.stringify(patch.toolCalls ?? null),
          JSON.stringify(patch.metadata),
          patch.status,
        ],
      );

    // v2 (real flushAssistant): outputs live once, in metadata.parts.
    const v2 = await walDelta(c, async () => {
      const acc: ReturnType<typeof makeStep>[] = [];
      for (let i = 0; i < STEPS; i++) {
        acc.push(makeStep(i));
        await writeRow(flushAssistant(acc as never, '', 'streaming'));
      }
    });

    await c.query("UPDATE _wal_full SET content='', tool_calls='[]'::jsonb, metadata='{}'::jsonb WHERE id=1");

    // v1: same row PLUS the duplicated outputs in the trace column.
    const v1 = await walDelta(c, async () => {
      const acc: ReturnType<typeof makeStep>[] = [];
      for (let i = 0; i < STEPS; i++) {
        acc.push(makeStep(i));
        const f = flushAssistant(acc as never, '', 'streaming');
        await writeRow({ ...f, toolCalls: v1Trace(acc) });
      }
    });

    await c.query('DROP TABLE IF EXISTS _wal_full');

    // eslint-disable-next-line no-console
    console.log(
      `[#490 WAL] full row over ${STEPS} steps: v1=${(v1 / 1e6).toFixed(1)}MB ` +
        `v2=${(v2 / 1e6).toFixed(1)}MB (saved ${((1 - v2 / v1) * 100).toFixed(0)}%)`,
    );

    // Removing the duplicated trace copy is a large, real write-volume reduction.
    expect(v2).toBeLessThan(v1 * 0.75);
  }, 120_000);
});

/**
 * #520 reactive-recovery COUNTER lifecycle on a LIVE Postgres — proves the
 * consecutive-overflow count survives a real jsonb metadata round-trip (the persist
 * path), not just an in-memory object. flushAssistant BUILDS the row metadata, we
 * WRITE it to a jsonb column, READ it back, then reconstruct the assistant row and
 * run lastAssistantReplayOverflowCount over it — exactly the read the next turn does.
 *
 * The lifecycle proven end-to-end through pg:
 *   - consecutive overflows INCREMENT k (1 -> 2 -> 3);
 *   - a CLEAN finalize omits the field, which the reader treats as a RESET to 0;
 *   - a legacy boolean row (`replayOverflow: true`) reads back as k=1 (back-compat).
 */
describe('#520 overflow-counter lifecycle on a live Postgres (jsonb round-trip)', () => {
  let client: Client | undefined;
  let available = false;

  beforeAll(async () => {
    try {
      client = new Client(CONN);
      await client.connect();
      await client.query('SELECT 1');
      available = true;
    } catch {
      available = false;
      client = undefined;
    }
  });

  afterAll(async () => {
    await client?.end().catch(() => undefined);
  });

  // Round-trip an arbitrary metadata object through a real jsonb column and read it
  // back as the reconstructed assistant row the next turn would load.
  async function roundTrip(
    c: Client,
    metadata: unknown,
  ): Promise<AiChatMessage> {
    await c.query('UPDATE _wal_counter SET metadata=$1 WHERE id=1', [
      JSON.stringify(metadata),
    ]);
    const back = (await c.query('SELECT metadata FROM _wal_counter WHERE id=1'))
      .rows[0].metadata as Record<string, unknown>;
    return { role: 'assistant', metadata: back } as unknown as AiChatMessage;
  }

  it('increments across consecutive overflows, resets on a clean turn, and honors the legacy boolean', async () => {
    if (!available || !client) {
      console.warn('SKIP: gitmost-test-pg not reachable; skipping counter test.');
      return;
    }
    const c = client;
    await c.query('DROP TABLE IF EXISTS _wal_counter');
    await c.query('CREATE TABLE _wal_counter(id int primary key, metadata jsonb)');
    await c.query("INSERT INTO _wal_counter VALUES (1, '{}'::jsonb)");

    // Turn 1 overflow: prior streak 0 -> stamp k=1 (as the service does: prior+1).
    let prior = lastAssistantReplayOverflowCount([]); // fresh chat
    expect(prior).toBe(0);
    let row = await roundTrip(
      c,
      flushAssistant([], '', 'error', {
        error: 'ctx',
        replayOverflowCount: prior + 1,
      }).metadata,
    );
    prior = lastAssistantReplayOverflowCount([row]);
    expect(prior).toBe(1);

    // Turn 2 overflow: prior 1 -> stamp k=2.
    row = await roundTrip(
      c,
      flushAssistant([], '', 'error', {
        error: 'ctx',
        replayOverflowCount: prior + 1,
      }).metadata,
    );
    prior = lastAssistantReplayOverflowCount([row]);
    expect(prior).toBe(2);

    // Turn 3 overflow: prior 2 -> stamp k=3.
    row = await roundTrip(
      c,
      flushAssistant([], '', 'error', {
        error: 'ctx',
        replayOverflowCount: prior + 1,
      }).metadata,
    );
    prior = lastAssistantReplayOverflowCount([row]);
    expect(prior).toBe(3);

    // Turn 4 CLEAN finalize: no overflow -> the field is omitted -> reset to 0.
    row = await roundTrip(
      c,
      flushAssistant([], 'all good', 'completed', { finishReason: 'stop' })
        .metadata,
    );
    expect('replayOverflowCount' in (row.metadata as object)).toBe(false);
    expect(lastAssistantReplayOverflowCount([row])).toBe(0);

    // Back-compat: a row persisted by the pre-#520 boolean stamp reads back as k=1.
    row = await roundTrip(c, { replayOverflow: true });
    expect(lastAssistantReplayOverflowCount([row])).toBe(1);

    await c.query('DROP TABLE IF EXISTS _wal_counter');
  }, 60_000);
});
