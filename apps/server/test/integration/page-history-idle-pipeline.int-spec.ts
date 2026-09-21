import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { PersistenceExtension } from '../../src/collaboration/extensions/persistence.extension';

/**
 * #370 — integration property of the idle-snapshot pipeline against REAL BullMQ.
 *
 * This is deliberately NOT a unit test of computeHistoryJob (that lives in
 * compute-history-job.spec.ts). The point here is the OBSERVABLE end-to-end
 * behaviour of the production `enqueuePageHistory` remove-then-add debounce
 * driving a real Redis-backed delayed queue + worker (the #431→#439 class: a
 * locally-correct function whose queue/timer property was never exercised):
 *
 *   - a CONTINUOUS burst of stores lasting several caps yields periodic idle
 *     snapshots — at least one per max-wait cap, NOT one-per-store; and
 *   - an INTERMITTENT burst (a few stores, then quiet) yields exactly ONE
 *     trailing snapshot.
 *
 * We shrink the idle windows to milliseconds (jest.mock of collaboration
 * constants) so real BullMQ delayed jobs actually promote within the test —
 * fake timers cannot advance Redis's own delayed-set clock, so the intervals
 * must be real but tiny. The production method under test is called verbatim.
 */

// NOTE: jest.mock is hoisted above the module's const initializers, so its
// factory cannot close over MAX_WAIT_MS/INTERVAL_MS — the literals are inlined
// here and MUST stay in sync with the consts below (a single source of truth is
// impossible across the hoist boundary).
jest.mock('../../src/collaboration/constants', () => {
  const actual = jest.requireActual('../../src/collaboration/constants');
  return {
    ...actual,
    IDLE_MAX_WAIT_USER: 300,
    IDLE_MAX_WAIT_AGENT: 300,
    IDLE_INTERVAL_USER: 1000,
    IDLE_INTERVAL_AGENT: 1000,
  };
});

// Mirrors the mocked IDLE_MAX_WAIT_* above (IDLE_INTERVAL_* is 1000 > this, so
// the max-wait ceiling is what actually governs the trailing delay).
const MAX_WAIT_MS = 300;

const REDIS_CONNECTION = {
  host: process.env.TEST_REDIS_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_REDIS_PORT ?? 6379),
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('#370 idle-snapshot pipeline (real BullMQ)', () => {
  let queue: Queue;
  let worker: Worker;
  let extension: PersistenceExtension;
  // Every processed snapshot, tagged by pageId so the two scenarios stay isolated.
  const processed: Array<{ pageId: string; kind: string; at: number }> = [];
  const queueName = `history-idle-int-${randomUUID()}`;

  beforeAll(async () => {
    queue = new Queue(queueName, {
      connection: REDIS_CONNECTION,
      // Mirror the production default (BullModule.forRoot removeOnComplete): the
      // enqueue idiom relies on the jobId being freed once a job completes so the
      // next burst can re-arm the same id.
      defaultJobOptions: { removeOnComplete: true, removeOnFail: true },
    });
    await queue.waitUntilReady();

    worker = new Worker(
      queueName,
      async (job) => {
        processed.push({
          pageId: job.data?.pageId,
          kind: job.data?.kind,
          at: Date.now(),
        });
      },
      { connection: REDIS_CONNECTION },
    );
    await worker.waitUntilReady();

    // Construct the real extension; only historyQueue (5th ctor arg) and the
    // internal idleBurstStart map are exercised by enqueuePageHistory, so the
    // other collaborators can be null — the constructor only assigns fields.
    extension = new PersistenceExtension(
      null as any, // pageRepo
      null as any, // pageHistoryRepo
      null as any, // db
      null as any, // aiQueue
      queue as any, // historyQueue
      null as any, // notificationQueue
      null as any, // collabHistory
      null as any, // transclusionService
    );
  });

  afterAll(async () => {
    // Force-close and fully drain so no BullMQ background activity (delayed-set
    // polling, blocking BRPOPLPUSH) bleeds into later suites in this single
    // shared jest worker (maxWorkers: 1).
    await worker?.close(true).catch(() => undefined);
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await queue?.close();
    // Let the redis sockets settle before the next suite starts.
    await sleep(150);
  });

  const arm = (pageId: string) =>
    (extension as any).enqueuePageHistory({ id: pageId }, 'user');

  it('continuous burst over several caps → periodic idle snapshots (≥1 per cap, not one-per-store)', async () => {
    const pageId = randomUUID();
    const runMs = 6 * MAX_WAIT_MS; // ~6 caps of unbroken editing
    // Store cadence that does NOT evenly divide the cap: real hocuspocus stores
    // are not aligned to cap boundaries, so a boundary job promotes in the gap
    // before the next store's remove(). A cap-aligned cadence would instead land
    // a store exactly on every boundary and lose the snapshot to the documented
    // remove-vs-active race — an artefact of the test clock, not the pipeline.
    const stepMs = 70;
    const stores = Math.floor(runMs / stepMs);

    const start = Date.now();
    let count = 0;
    while (Date.now() - start < runMs) {
      await arm(pageId);
      count++;
      await sleep(stepMs);
    }
    // Let the final armed job flush.
    await sleep(2 * MAX_WAIT_MS);

    const snaps = processed.filter((p) => p.pageId === pageId);

    // Every autosnapshot is an idle-kind row.
    expect(snaps.every((s) => s.kind === 'idle')).toBe(true);
    // Periodic: at least one per cap over a multi-cap burst (lower-bounded loosely
    // to stay robust; the property is "fires at least every cap", not a single
    // trailing snapshot).
    expect(snaps.length).toBeGreaterThanOrEqual(3);
    // But NOT one-per-store: ~`stores` stores were issued; the debounce must
    // collapse them to a small multiple of the cap count, nowhere near per-store.
    expect(snaps.length).toBeLessThanOrEqual(Math.ceil(stores / 2));
  });

  it('intermittent burst (a few stores, then quiet) → exactly ONE trailing snapshot', async () => {
    const pageId = randomUUID();

    // A short burst well within a single cap window, then silence.
    await arm(pageId);
    await sleep(40);
    await arm(pageId);
    await sleep(40);
    await arm(pageId);

    // Wait comfortably past the cap so the single pending trailing job fires.
    await sleep(4 * MAX_WAIT_MS);

    const snaps = processed.filter((p) => p.pageId === pageId);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].kind).toBe('idle');
  });
});
