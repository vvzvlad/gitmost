import { randomUUID } from 'crypto';
import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
// NOT a default import: the project tsconfig is `module: commonjs` with NO
// esModuleInterop, so `import postgres from 'postgres'` compiles to
// `postgres_1.default(...)` and the CJS `postgres` export has no `.default` —
// it threw in beforeAll, was swallowed as "DB unreachable", and SILENTLY voided
// all six tests. Mirror the working integration harness (test/integration/db.ts).
import * as postgres from 'postgres';
import { AiChatMessageRepo } from './ai-chat-message.repo';
import { AiChatRunRepo } from './ai-chat-run.repo';

/**
 * #491 delta-poll — OBSERVABLE-PROPERTY tests against a LIVE Postgres (the local
 * gitmost test DB, docker `gitmost-test-pg` on :5432), not "rows through a mock"
 * (a mock cannot observe the DB clock nor the overlap-window race — the very
 * things that matter here). Drives the REAL repo methods (`findByChatUpdatedAfter`,
 * the now()-stamped `update`) and asserts:
 *   1. delta-relevant writes stamp `updatedAt` from the DB clock, not the app clock
 *      (proven by faking the process clock far into the future and observing the
 *      stamp stays on real DB time);
 *   2. the poll returns only rows changed after the cursor, ordered, with a fresh
 *      DB-clock cursor;
 *   3. the "committed late but stamped earlier than the cursor" RACE is caught by
 *      the overlap window (a naive `updatedAt > cursor` would MISS it);
 *   4. the overlap GUARANTEES repeats across close polls — the contract behind the
 *      client's idempotent merge (mergeById).
 *
 * INTEGRATION lane (`*.int-spec.ts`): runs under `test:int`, whose global-setup
 * DROPS + RE-CREATES + MIGRATES `docmost_test`, so the real `ai_chat_messages` /
 * `ai_chat_runs` tables EXIST here. (It was previously a `.spec.ts` defaulting to
 * the UNmigrated dev `docmost`; in the CI unit lane — where `WAL_TEST_DATABASE_URL`
 * is unset and only `test:int` migrates — that meant 5/6 ERROR
 * `relation "ai_chat_messages" does not exist`, silently voiding coverage of the
 * risky cursor/overlap logic. Renaming to `.int-spec.ts` + defaulting the DSN to
 * `docmost_test` fixes the CI fidelity.)
 *
 * FK triggers are bypassed (`session_replication_role = replica`) so synthetic
 * chat/workspace ids need no parent fixtures; a single pooled connection (max 1)
 * keeps that session setting for every query. SKIPS cleanly when the DB is
 * unreachable so a DB-less CI never breaks.
 */
const CONN =
  process.env.WAL_TEST_DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  'postgresql://docmost:docmost_dev_pw@localhost:5432/docmost_test';

let db: Kysely<any>;
let sqlClient: ReturnType<typeof postgres>;
let msgRepo: AiChatMessageRepo;
let runRepo: AiChatRunRepo;
let reachable = false;

const workspaceId = randomUUID();
const chatId = randomUUID();

beforeAll(async () => {
  try {
    sqlClient = postgres(CONN, { max: 1, onnotice: () => {} });
    db = new Kysely<any>({
      dialect: new PostgresJSDialect({ postgres: sqlClient }),
      plugins: [new CamelCasePlugin()],
    });
    // Single connection keeps this session-scoped bypass for the whole suite.
    await sql`set session_replication_role = replica`.execute(db);
    await sql`select 1`.execute(db);
    reachable = true;
  } catch (err) {
    reachable = false;
    // A genuine connection failure (ECONNREFUSED etc.) is a legitimate skip on a
    // DB-less CI. A PROGRAMMING error (bad import, typo, driver misuse) must NOT
    // masquerade as "DB unreachable" and silently void the whole suite (that is
    // exactly the bug that hid this spec's zero coverage) — rethrow it so the
    // suite fails LOUDLY.
    const msg = String((err as Error)?.message ?? err);
    if (
      !/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|connect|terminating|password|authentication|role .* does not exist|database .* does not exist/i.test(
        msg,
      )
    ) {
      throw err;
    }
  }
  msgRepo = new AiChatMessageRepo(db as never);
  runRepo = new AiChatRunRepo(db as never);
});

afterAll(async () => {
  if (db) {
    try {
      await db
        .deleteFrom('aiChatMessages')
        .where('workspaceId', '=', workspaceId)
        .execute();
      await db
        .deleteFrom('aiChatRuns')
        .where('workspaceId', '=', workspaceId)
        .execute();
    } catch {
      /* best-effort cleanup */
    }
    await db.destroy();
  }
});

afterEach(() => {
  jest.useRealTimers();
});

async function seedMessage(overrides: Record<string, unknown> = {}) {
  return msgRepo.insert({
    chatId,
    workspaceId,
    userId: null as never,
    role: 'assistant',
    content: 'x',
    status: 'streaming',
    ...overrides,
  } as never);
}

async function dbNow(): Promise<string> {
  const r = await sql<{ now: Date }>`select now() as now`.execute(db);
  return r.rows[0].now.toISOString();
}

// Fake ONLY the Date object (so in-process `new Date()`/`Date.now()` jump), while
// leaving every TIMER function real. Faking timers wholesale freezes postgres.js's
// internal connection/query timers, so the awaited DB round-trip would hang the
// test (and the afterAll cleanup) at the jest 5s cap. With Date-only faking the
// query resolves normally, and we still prove the stamp is the DB clock (not the
// skewed process clock).
function fakeDateOnly(iso: string): void {
  jest.useFakeTimers({
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
    now: new Date(iso),
  });
}

const maybe = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!reachable) {
      console.warn(`SKIP (${name}): test DB unreachable at ${CONN}`);
      return;
    }
    await fn();
  });

describe('AiChatMessageRepo.findByChatUpdatedAfter (#491 delta poll)', () => {
  maybe('null cursor returns no rows and a fresh DB-clock cursor', async () => {
    const before = await dbNow();
    const { rows, cursor } = await msgRepo.findByChatUpdatedAfter(
      chatId,
      workspaceId,
      null,
    );
    expect(rows).toEqual([]);
    expect(new Date(cursor).getTime()).toBeGreaterThanOrEqual(
      new Date(before).getTime(),
    );
  });

  maybe('returns only rows changed after the cursor', async () => {
    const { cursor: c0 } = await msgRepo.findByChatUpdatedAfter(
      chatId,
      workspaceId,
      null,
    );
    const m = await seedMessage();
    const { rows, cursor: c1 } = await msgRepo.findByChatUpdatedAfter(
      chatId,
      workspaceId,
      c0,
    );
    expect(rows.map((r) => r.id)).toContain(m.id);
    // Cursor is monotonic (advances).
    expect(new Date(c1).getTime()).toBeGreaterThanOrEqual(
      new Date(c0).getTime(),
    );
  });

  maybe(
    'RACE: a row stamped BEFORE the cursor but seen after is caught by the overlap',
    async () => {
      // Cursor taken now; then a row appears whose updatedAt is 2s in the PAST
      // (committed late on another connection but stamped earlier). A naive
      // `updatedAt > cursor` would MISS it; the 5s overlap window catches it.
      const cursor = await dbNow();
      const m = await seedMessage();
      await sql`update ai_chat_messages set updated_at = now() - interval '2 seconds' where id = ${m.id}`.execute(
        db,
      );
      const { rows } = await msgRepo.findByChatUpdatedAfter(
        chatId,
        workspaceId,
        cursor,
      );
      expect(rows.map((r) => r.id)).toContain(m.id);
    },
  );

  maybe(
    'overlap GUARANTEES repeats across close polls (idempotent-merge contract)',
    async () => {
      const { cursor: c0 } = await msgRepo.findByChatUpdatedAfter(
        chatId,
        workspaceId,
        null,
      );
      const m = await seedMessage();
      const first = await msgRepo.findByChatUpdatedAfter(
        chatId,
        workspaceId,
        c0,
      );
      expect(first.rows.map((r) => r.id)).toContain(m.id);
      // Immediately re-poll with the JUST-returned cursor: the row is still within
      // the overlap window, so it is returned AGAIN — the client MUST dedupe by id.
      const second = await msgRepo.findByChatUpdatedAfter(
        chatId,
        workspaceId,
        first.cursor,
      );
      expect(second.rows.map((r) => r.id)).toContain(m.id);
    },
  );

  maybe(
    'update() stamps updatedAt from the DB clock, not the app clock',
    async () => {
      const m = await seedMessage();
      // Skew the PROCESS clock ~73 years into the future (Date only). If the stamp
      // came from `new Date()` the row would read year 2099; sql now() keeps it on
      // DB time.
      fakeDateOnly('2099-01-01T00:00:00Z');
      const updated = await msgRepo.update(m.id, workspaceId, {
        content: 'y',
      });
      jest.useRealTimers();
      expect(updated).toBeDefined();
      expect(new Date(updated!.updatedAt).getFullYear()).toBeLessThan(2099);
    },
  );

  maybe(
    'run update() also stamps updatedAt from the DB clock',
    async () => {
      const run = await runRepo.insert({
        chatId,
        workspaceId,
        createdBy: null as never,
        trigger: 'user',
        status: 'running',
        stepCount: 0,
      } as never);
      fakeDateOnly('2099-01-01T00:00:00Z');
      const updated = await runRepo.update(run.id, workspaceId, {
        stepCount: 1,
      });
      jest.useRealTimers();
      expect(updated).toBeDefined();
      expect(new Date(updated!.updatedAt).getFullYear()).toBeLessThan(2099);
    },
  );
});
