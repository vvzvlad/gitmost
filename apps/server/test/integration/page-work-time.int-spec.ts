import { randomUUID } from 'node:crypto';
import { Kysely } from 'kysely';
import { PageHistoryRepo } from '../../src/database/repos/page/page-history.repo';
import { PageHistoryService } from '../../src/core/page/services/page-history.service';
import { computeWorkTime } from '../../src/core/page/work-time';
import {
  getTestDb,
  destroyTestDb,
  createWorkspace,
  createSpace,
  createPage,
  createUser,
  createChat,
} from './db';

/**
 * #395 — real-Postgres coverage for the work-time timeline projection and the
 * service that computes the estimate. The pure sessionizer is unit-tested
 * exhaustively (compute-work-time.spec.ts); this asserts the SQL projection
 * (right rows, ASC, no `content`) and that the service's numbers agree with the
 * pure core over the exact rows the DB returns.
 */
describe('PageHistory work-time [integration]', () => {
  let db: Kysely<any>;
  let repo: PageHistoryRepo;
  let service: PageHistoryService;
  let workspaceId: string;
  let spaceId: string;
  let pageId: string;
  let userId: string;
  let chatId: string;

  const MIN = 60 * 1000;

  beforeAll(async () => {
    db = getTestDb();
    repo = new PageHistoryRepo(db as any);
    service = new PageHistoryService(repo);
    workspaceId = (await createWorkspace(db)).id;
    spaceId = (await createSpace(db, workspaceId)).id;
    pageId = (await createPage(db, { workspaceId, spaceId })).id;
    userId = (await createUser(db, workspaceId)).id;
    chatId = (await createChat(db, { workspaceId, creatorId: userId })).id;
  });

  afterAll(async () => {
    await destroyTestDb();
  });

  async function insertHistory(rows: Array<{
    createdAt: string;
    source: string | null;
    chat?: string | null;
    kind?: string | null;
    content?: unknown;
  }>) {
    for (const r of rows) {
      await db
        .insertInto('pageHistory')
        .values({
          id: randomUUID(),
          pageId,
          spaceId,
          workspaceId,
          title: 'x',
          content: r.content ?? { type: 'doc', content: [] },
          lastUpdatedById: userId,
          lastUpdatedSource: r.source,
          lastUpdatedAiChatId: r.chat ?? null,
          kind: r.kind ?? null,
          createdAt: new Date(r.createdAt),
        })
        .execute();
    }
  }

  it('findTimelineByPageId projects the cheap columns, ASC, without content', async () => {
    await insertHistory([
      { createdAt: '2026-07-04T19:54:00Z', source: 'user', kind: 'manual' },
      { createdAt: '2026-07-04T03:40:00Z', source: 'user', kind: null },
      { createdAt: '2026-07-04T15:43:00Z', source: 'agent', chat: chatId, kind: 'agent' },
    ]);

    const timeline = await repo.findTimelineByPageId(pageId);
    expect(timeline).toHaveLength(3);
    // Sorted oldest → newest.
    const times = timeline.map((r) => new Date(r.createdAt).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    // Projection carries exactly the sessionizer's inputs, and NO content.
    for (const row of timeline) {
      expect(row).toHaveProperty('createdAt');
      expect(row).toHaveProperty('lastUpdatedById');
      expect(row).toHaveProperty('lastUpdatedSource');
      expect(row).toHaveProperty('lastUpdatedAiChatId');
      expect(row).toHaveProperty('kind');
      expect(row).not.toHaveProperty('content');
    }
    // Agent row keeps its provenance.
    const agent = timeline.find((r) => r.lastUpdatedSource === 'agent');
    expect(agent?.lastUpdatedAiChatId).toBe(chatId);
  });

  it('service estimate matches the pure core and satisfies Σ perDay == workMs', async () => {
    const rows = await repo.findTimelineByPageId(pageId);
    const pure = computeWorkTime(rows);

    const result = await service.computeWorkTime(pageId, 'UTC');
    expect(result.workMs).toBe(pure.workMs);
    expect(result.agentOnlyMs).toBe(pure.agentOnlyMs);
    expect(result.tz).toBe('UTC');
    expect(result.config.tGap).toBe(15 * MIN);

    const sumActive = result.perDay.reduce((a, d) => a + d.activeMs, 0);
    expect(sumActive).toBe(result.workMs);

    // The 3 seeded rows sessionize into ≤ their span; not the naive span.
    const naive =
      new Date('2026-07-04T19:54:00Z').getTime() -
      new Date('2026-07-04T03:40:00Z').getTime();
    expect(result.workMs).toBeGreaterThan(0);
    expect(result.workMs).toBeLessThan(naive);
  });

  it('an unknown timezone surfaces as a RangeError (controller maps to 400)', async () => {
    await expect(
      service.computeWorkTime(pageId, 'Not/AZone'),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it('a page with no history → zeros, no days', async () => {
    const emptyPage = (await createPage(db, { workspaceId, spaceId })).id;
    const result = await service.computeWorkTime(emptyPage, 'UTC');
    expect(result.workMs).toBe(0);
    expect(result.agentOnlyMs).toBe(0);
    expect(result.perDay).toEqual([]);
  });
});
