import { Kysely, sql } from 'kysely';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { getTestDb, destroyTestDb, createWorkspace } from './db';

/**
 * #599 (review F4) — the ATOMIC POINTER FLIP, against a REAL Postgres.
 *
 * `WorkspaceRepo.setEmbeddingGeneration` is the crown of the fingerprint lifecycle:
 * ONE `UPDATE workspaces SET settings = ...` whose jsonb expression must
 *
 *   (a) write all five `settings.ai.embedding.*` keys TOGETHER (a reader must never
 *       see the new fingerprint next to the previous run's coverage numbers — the
 *       flip is all-or-nothing);
 *   (b) preserve every sibling namespace, both under `settings.ai` (provider /
 *       search / chat / mcp) and at the top level of `settings`; and
 *   (c) SELF-HEAL a `settings.ai` or `settings.ai.embedding` that is not an object
 *       (the D6 `jsonb_typeof = 'object'` CASE): `'"x"'::jsonb || '{...}'::jsonb`
 *       raises `cannot concatenate a non-object jsonb`, which would make every flip
 *       of that workspace fail FOREVER.
 *
 * None of that was covered by a test: the unit spec mocks `setEmbeddingGeneration`
 * wholesale and the lifecycle spec mocks the whole EmbeddingGenerationService, so a
 * regression that dropped the CASE, clobbered a sibling or split the write into two
 * statements would have passed green. It is raw SQL — only a real database can
 * check it, so this runs against one.
 */
describe('WorkspaceRepo.setEmbeddingGeneration — the atomic flip [integration]', () => {
  let db: Kysely<any>;
  let repo: WorkspaceRepo;

  // A working cache double: bustWorkspaceCache is best-effort (try/catch), but a
  // `{}` stub makes its `del` throw into that catch, so the flip would be exercised
  // with the invalidation silently disabled.
  const cache = {
    get: async () => undefined,
    set: async () => undefined,
    del: async () => undefined,
  };

  const GEN = {
    activeFingerprint: 'a'.repeat(64),
    activeModel: 'intfloat/multilingual-e5-base',
    coverageTotal: 98,
    coverageEmbeddable: 100,
    coverageAt: new Date('2026-07-01T12:34:56.000Z'),
  };

  const readSettings = async (id: string) =>
    (
      await db
        .selectFrom('workspaces')
        .select(['settings'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).settings as any;

  beforeAll(() => {
    db = getTestDb();
    repo = new WorkspaceRepo(db as any, cache as any);
  });

  afterAll(async () => {
    await destroyTestDb();
  });

  it('writes all five embedding keys in one flip and preserves every ai.* sibling', async () => {
    const ws = await createWorkspace(db, {
      settings: {
        ai: {
          provider: { driver: 'openai', chatModel: 'gpt-4o' },
          search: { hybrid: true },
          chat: { enabled: true },
          mcp: { servers: ['x'] },
        },
        sharing: { allowInvite: true },
        htmlEmbed: true,
      },
    });

    await repo.setEmbeddingGeneration(ws.id, GEN);

    const settings = await readSettings(ws.id);

    // (a) the four generation keys + the coverage timestamp all landed.
    expect(settings.ai.embedding).toEqual({
      activeFingerprint: GEN.activeFingerprint,
      activeModel: GEN.activeModel,
      // Counts are persisted as TEXT (jsonb_build_object over ::text) and parsed
      // back by getEmbeddingGeneration.
      coverageTotal: '98',
      coverageEmbeddable: '100',
      coverageAt: '2026-07-01T12:34:56.000Z',
    });

    // (b) every sibling survived — under `ai`...
    expect(settings.ai.provider).toEqual({
      driver: 'openai',
      chatModel: 'gpt-4o',
    });
    expect(settings.ai.search).toEqual({ hybrid: true });
    expect(settings.ai.chat).toEqual({ enabled: true });
    expect(settings.ai.mcp).toEqual({ servers: ['x'] });
    // ...and at the top level of `settings`.
    expect(settings.sharing).toEqual({ allowInvite: true });
    expect(settings.htmlEmbed).toBe(true);
  });

  it('round-trips through getEmbeddingGeneration (numbers and the timestamp parse back)', async () => {
    const ws = await createWorkspace(db, { settings: { ai: { chat: true } } });

    await repo.setEmbeddingGeneration(ws.id, GEN);

    await expect(repo.getEmbeddingGeneration(ws.id)).resolves.toEqual({
      activeFingerprint: GEN.activeFingerprint,
      activeModel: GEN.activeModel,
      coverageTotal: 98,
      coverageEmbeddable: 100,
      coverageAt: GEN.coverageAt,
    });
  });

  /**
   * D6 — the jsonb_typeof CASE. `COALESCE` only guards a NULL; a SCALAR `ai` makes
   * the `||` merge raise `cannot concatenate a non-object jsonb`, and every flip of
   * that workspace fails forever (the workspace can never leave its swap window).
   *
   * NON-VACUITY: drop the `CASE WHEN jsonb_typeof(settings->'ai') = 'object'`
   * wrapper and this test throws that very Postgres error instead of self-healing.
   */
  it('D6 — self-heals a SCALAR settings.ai (the flip succeeds, all keys land)', async () => {
    const ws = await createWorkspace(db, { settings: {} });
    // Force the pathological shape a hand-edit / bad migration could leave.
    await sql`UPDATE workspaces SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{ai}', '"x"'::jsonb) WHERE id = ${ws.id}`.execute(
      db,
    );
    expect((await readSettings(ws.id)).ai).toBe('x');

    await repo.setEmbeddingGeneration(ws.id, GEN);

    const settings = await readSettings(ws.id);
    // The scalar was replaced by a well-formed object carrying the generation.
    expect(settings.ai.embedding.activeFingerprint).toBe(GEN.activeFingerprint);
    expect(settings.ai.embedding.activeModel).toBe(GEN.activeModel);
    expect(settings.ai.embedding.coverageTotal).toBe('98');
    expect(settings.ai.embedding.coverageEmbeddable).toBe('100');
    expect(settings.ai.embedding.coverageAt).toBe('2026-07-01T12:34:56.000Z');
  });

  it('D6 — self-heals a SCALAR settings.ai.embedding while keeping the ai.* siblings', async () => {
    const ws = await createWorkspace(db, {
      settings: { ai: { provider: { driver: 'ollama' }, embedding: 'x' } },
    });
    expect((await readSettings(ws.id)).ai.embedding).toBe('x');

    await repo.setEmbeddingGeneration(ws.id, GEN);

    const settings = await readSettings(ws.id);
    expect(settings.ai.embedding.activeFingerprint).toBe(GEN.activeFingerprint);
    // The sibling under `ai` must survive the embedding self-heal.
    expect(settings.ai.provider).toEqual({ driver: 'ollama' });
  });

  it('initializes a NULL settings column via COALESCE (a fresh workspace can flip)', async () => {
    const ws = await createWorkspace(db, { settings: undefined });

    await repo.setEmbeddingGeneration(ws.id, GEN);

    const settings = await readSettings(ws.id);
    expect(settings.ai.embedding.activeFingerprint).toBe(GEN.activeFingerprint);
  });

  it('a SECOND flip replaces the generation wholesale and still keeps the siblings', async () => {
    const ws = await createWorkspace(db, {
      settings: { ai: { provider: { driver: 'openai' } } },
    });

    await repo.setEmbeddingGeneration(ws.id, GEN);
    const next = {
      activeFingerprint: 'b'.repeat(64),
      activeModel: 'BAAI/bge-m3',
      coverageTotal: 500,
      coverageEmbeddable: 512,
      coverageAt: new Date('2026-07-02T00:00:00.000Z'),
    };
    await repo.setEmbeddingGeneration(ws.id, next);

    // No stale key from the previous generation may survive next to the new one:
    // the whole point of the single write is that the pointer and ITS numbers move
    // together (a reader that saw fp-B with fp-A's coverage would mis-report).
    const settings = await readSettings(ws.id);
    expect(settings.ai.embedding).toEqual({
      activeFingerprint: next.activeFingerprint,
      activeModel: next.activeModel,
      coverageTotal: '500',
      coverageEmbeddable: '512',
      coverageAt: '2026-07-02T00:00:00.000Z',
    });
    expect(settings.ai.provider).toEqual({ driver: 'openai' });
  });

  it('negative / fractional counts are floored and clamped at 0 before they are stored', async () => {
    const ws = await createWorkspace(db, { settings: {} });

    await repo.setEmbeddingGeneration(ws.id, {
      ...GEN,
      coverageTotal: -5,
      coverageEmbeddable: 10.9,
    });

    const settings = await readSettings(ws.id);
    expect(settings.ai.embedding.coverageTotal).toBe('0');
    expect(settings.ai.embedding.coverageEmbeddable).toBe('10');
  });
});
