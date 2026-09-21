import { randomUUID } from 'node:crypto';
import { Kysely, sql } from 'kysely';
import { Logger } from '@nestjs/common';
import { SearchService } from 'src/core/search/search.service';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageEmbeddingRepo } from '@docmost/db/repos/ai-chat/page-embedding.repo';
import { AiEmbeddingNotConfiguredException } from 'src/integrations/ai/ai-embedding-not-configured.exception';
import {
  getTestDb,
  destroyTestDb,
  createWorkspace,
  createSpace,
} from './db';

/**
 * #529 Phase A — the lexical overhaul, on the REAL migrated schema (ru_en config).
 *
 * Covers every acceptance criterion of the issue: RU+EN morphology + OR default,
 * match=auto identifier routing, "phrase"/+/- operators, RRF ordering, exact
 * permission-filtered total (fail-closed) + pagination, only-negation / garbage
 * short-circuits, the A8 path fix, the response superset, and the RAG lockstep
 * config (acceptance #13).
 *
 * The tsv column is populated by the pages_tsvector_trigger (now ru_en), so the
 * FTS branch is exercised end to end.
 */
describe('SearchService #529 lexical overhaul [integration]', () => {
  let db: Kysely<any>;
  let workspaceId: string;
  let spaceId: string;

  async function insertPage(args: {
    title: string;
    textContent?: string;
    parentPageId?: string | null;
    spaceId?: string;
    deletedAt?: Date | null;
  }): Promise<string> {
    const id = randomUUID();
    await db
      .insertInto('pages')
      .values({
        id,
        slugId: `slug-${id.slice(0, 12)}`,
        title: args.title,
        textContent: args.textContent ?? null,
        parentPageId: args.parentPageId ?? null,
        spaceId: args.spaceId ?? spaceId,
        workspaceId,
        deletedAt: args.deletedAt ?? null,
      })
      .execute();
    return id;
  }

  // Service wired to the real DB + real PageRepo (recursive descendants) with
  // stubbed space-membership + permission repos so a test controls scope and the
  // permission filter explicitly. `accessibleIds` (when set) is the KEEP list.
  // #530: a FAKE AiService whose embedQuery is fully controlled per test. By
  // DEFAULT it throws AiEmbeddingNotConfiguredException, so the semantic arm is
  // omitted and every Phase-A case runs the BYTE-IDENTICAL lexical path — the
  // semantic layer must never change lexical behaviour on degrade. Semantic cases
  // pass `embedVector` (a deterministic 384-dim query vector) or `embedThrows`.
  function buildService(opts?: {
    userSpaceIds?: string[];
    accessibleIds?: string[] | null;
    filterThrows?: boolean;
    embedVector?: number[];
    embedFingerprint?: string;
    embedThrows?: 'no-provider' | 'degraded';
    slowVectorArm?: boolean;
  }): SearchService {
    const pageRepo = new PageRepo(db as any, null as any, null as any);
    const spaceMemberRepo = {
      getUserSpaceIds: async () => opts?.userSpaceIds ?? [spaceId],
    };
    const pagePermissionRepo = {
      hasRestrictedAncestor: async () => false,
      filterAccessiblePageIds: async ({ pageIds }: { pageIds: string[] }) => {
        if (opts?.filterThrows) throw new Error('permission query failed');
        return opts?.accessibleIds
          ? pageIds.filter((id) => opts.accessibleIds!.includes(id))
          : pageIds;
      },
    };
    const aiService = {
      embedQuery: async () => {
        if (opts?.embedVector) {
          return {
            vector: opts.embedVector,
            fingerprint: opts.embedFingerprint ?? ACTIVE_FP,
          };
        }
        if (opts?.embedThrows === 'degraded') {
          const err = new Error('embedding request timed out after 1ms');
          err.name = 'TimeoutError';
          throw err;
        }
        // Default (and explicit 'no-provider'): no embedding provider resolved.
        throw new AiEmbeddingNotConfiguredException();
      },
    };
    // Real repo on the migrated test DB — exercises the actual vector-candidate
    // SQL (pgvector <=>, fingerprint + dimension filters). When slowVectorArm is
    // set, wrap the arm so it sleeps well past the (tiny, test-set) statement
    // timeout, forcing a 57014 cancellation to exercise the degrade-to-lexical net.
    const realRepo = new PageEmbeddingRepo(db as any);
    const pageEmbeddingRepo = opts?.slowVectorArm
      ? {
          vectorCandidateArm: (p: any) => {
            const inner = realRepo.vectorCandidateArm(p);
            return sql`SELECT * FROM (${inner}) AS slowarm WHERE (SELECT true FROM pg_sleep(0.5))`;
          },
        }
      : realRepo;
    // #599: the reader funnel. It wraps the SAME fake embedQuery above and reports
    // the generation the vector arm must filter by. These Phase-B PR-1 cases run at
    // the steady state (no swap in flight: active === target), and coverage is
    // reported `full` so the semantic block keeps its PR-1 shape — the lifecycle's
    // own states (stale/swap/flip/GC) are covered by the unit specs.
    const embeddingGeneration = {
      embedQueryForActiveGeneration: async () => {
        const { vector, fingerprint } = await aiService.embedQuery();
        return {
          vector,
          fingerprint,
          generation: { active: fingerprint, target: fingerprint, swapping: false },
        };
      },
      getCoverage: async () => ({ indexed: 1, total: 1, state: 'full' as const }),
    };
    return new SearchService(
      db as any,
      pageRepo as any,
      {} as any,
      spaceMemberRepo as any,
      pagePermissionRepo as any,
      pageEmbeddingRepo as any,
      embeddingGeneration as any,
    );
  }

  // Active embedding fingerprint used by planted rows + the fake query embed.
  const ACTIVE_FP = 'fp-active-530';

  // A deterministic unit-ish 384-dim vector with a single 1 at `concept`. Two
  // vectors of the same concept have cosine distance 0; different concepts are
  // orthogonal (distance 1), so nearest-neighbour ordering is fully controlled.
  function conceptVec(concept: number): number[] {
    const v = new Array(384).fill(0);
    v[concept % 384] = 1;
    return v;
  }

  // Plant one chunk embedding for a page via the REAL repo (exercises the #530
  // fingerprint insert path). Dimension is fixed at 384 to match conceptVec.
  async function plantEmbedding(
    pageId: string,
    vector: number[],
    fingerprint: string = ACTIVE_FP,
    planSpaceId: string = spaceId,
  ): Promise<void> {
    const repo = new PageEmbeddingRepo(db as any);
    await repo.insertChunks([
      {
        pageId,
        workspaceId,
        spaceId: planSpaceId,
        attachmentId: null,
        chunkIndex: 0,
        chunkStart: 0,
        chunkLength: 1,
        content: 'planted chunk',
        modelName: 'test-model',
        modelDimensions: 384,
        fingerprint,
        embedding: vector,
      },
    ]);
  }

  const search = (service: SearchService, params: any) =>
    service.searchPage(params, { userId: 'u-1', workspaceId }) as any;

  beforeAll(async () => {
    db = getTestDb();
    workspaceId = (await createWorkspace(db)).id;
    spaceId = (await createSpace(db, workspaceId)).id;
  });

  afterAll(async () => {
    await destroyTestDb();
  });

  // 1. RU morphology + OR: «ресторанов москвы» finds «ресторан в москве».
  it('#1 russian morphology + OR: finds «ресторан в москве» for «ресторанов москвы»', async () => {
    const page = await insertPage({
      title: 'ресторан в москве',
      textContent: 'Лучший ресторан столицы.',
    });
    const res = await search(buildService(), {
      query: 'ресторанов москвы',
      spaceId,
    });
    expect(res.items.map((i: any) => i.id)).toContain(page);
    expect(res.total).toBeGreaterThanOrEqual(1);
  });

  // 2. OR non-empty: «Стамбул Роснефть».
  it('#2 OR yields a hit when only one term matches', async () => {
    const page = await insertPage({ title: 'Роснефть отчёт', textContent: 'x' });
    const res = await search(buildService(), {
      query: 'Стамбул Роснефть',
      spaceId,
    });
    expect(res.items.map((i: any) => i.id)).toContain(page);
  });

  // 3. Multi-word OR: a page matching >=1 term is returned.
  it('#3 «3D принтер» returns pages that matched at least one term', async () => {
    const models = await insertPage({
      title: 'Модели для печати 3D',
      textContent: 'коллекция моделей',
    });
    const wish = await insertPage({
      title: 'Хотеть напечатать на принтере',
      textContent: 'очередь печати',
    });
    const res = await search(buildService(), { query: '3D принтер', spaceId });
    const ids = res.items.map((i: any) => i.id);
    expect(ids).toContain(models); // matched "3D"
    expect(ids).toContain(wish); // matched "принтер"
    // matchedTerms is populated per hit.
    const hit = res.items.find((i: any) => i.id === wish);
    expect(hit.matchedTerms).toContain('принтер');
  });

  // 4. match=auto FTS stemming: «печат» must NOT drag in «впечатления».
  it('#4 «печат» (auto) matches «печать» but NOT «впечатления»', async () => {
    const good = await insertPage({
      title: 'Печать документов',
      textContent: 'настройка печати',
    });
    const bad = await insertPage({
      title: 'Впечатления от поездки',
      textContent: 'много впечатлений',
    });
    const res = await search(buildService(), { query: 'печат', spaceId });
    const ids = res.items.map((i: any) => i.id);
    expect(ids).toContain(good);
    expect(ids).not.toContain(bad);
  });

  // 5. Identifier → substring branch.
  it('#5 `192.0.2` (auto→substring) finds the page with that IP', async () => {
    const page = await insertPage({
      title: 'Сетевой узел',
      textContent: 'Адрес устройства: 192.0.2.7 в сети.',
    });
    const res = await search(buildService(), { query: '192.0.2', spaceId });
    const hit = res.items.find((i: any) => i.id === page);
    expect(hit).toBeDefined();
    expect(hit.matchedFields).toContain('text');
  });

  // 6. +required / -excluded.
  it('#6 `+кофейня -архив`: keeps «кофейня», drops pages with «архив»', async () => {
    const keep = await insertPage({ title: 'Кофейня в центре', textContent: 'уют' });
    const drop = await insertPage({
      title: 'Кофейня старый архив',
      textContent: 'архивные записи',
    });
    const res = await search(buildService(), { query: '+кофейня -архив', spaceId });
    const ids = res.items.map((i: any) => i.id);
    expect(ids).toContain(keep);
    expect(ids).not.toContain(drop);
  });

  // 7. Phrase operator: only adjacent phrase hits survive.
  it('#7 `+"воздушный шар" кофе`: every hit contains the adjacent phrase', async () => {
    const adjacent = await insertPage({
      title: 'Воздушный шар и кофе',
      textContent: 'воздушный шар над городом, чашка кофе',
    });
    const nonAdjacent = await insertPage({
      title: 'Красный воздушный большой шар',
      textContent: 'воздушный красный шар и кофе рядом',
    });
    const res = await search(buildService(), {
      query: '+"воздушный шар" кофе',
      spaceId,
    });
    const ids = res.items.map((i: any) => i.id);
    expect(ids).toContain(adjacent);
    // The non-adjacent page (words separated) must NOT match the phrase.
    expect(ids).not.toContain(nonAdjacent);
  });

  // 8. Pagination determinism + exact total.
  it('#8 >50 matches: total>50, hasMore, and offset paginates without dupes', async () => {
    const svc = buildService();
    const created: string[] = [];
    for (let i = 0; i < 60; i++) {
      created.push(
        await insertPage({
          title: `паджинация запись ${i}`,
          textContent: 'общий паджинационный маркер',
        }),
      );
    }
    const p1 = await search(svc, {
      query: 'паджинационный',
      spaceId,
      limit: 25,
      offset: 0,
    });
    expect(p1.total).toBeGreaterThanOrEqual(60);
    expect(p1.hasMore).toBe(true);
    const p2 = await search(svc, {
      query: 'паджинационный',
      spaceId,
      limit: 25,
      offset: 25,
    });
    const p3 = await search(svc, {
      query: 'паджинационный',
      spaceId,
      limit: 25,
      offset: 50,
    });
    const ids = [
      ...p1.items.map((i: any) => i.id),
      ...p2.items.map((i: any) => i.id),
      ...p3.items.map((i: any) => i.id),
    ];
    // No duplicates across the three pages.
    expect(new Set(ids).size).toBe(ids.length);
    // Deterministic: same query twice → identical order.
    const p1b = await search(svc, {
      query: 'паджинационный',
      spaceId,
      limit: 25,
      offset: 0,
    });
    expect(p1b.items.map((i: any) => i.id)).toEqual(p1.items.map((i: any) => i.id));
  });

  // 9. Only-negation.
  it('#9 `-архив` only-negation: total 0, reason only-negation, no throw', async () => {
    const res = await search(buildService(), { query: '-архив', spaceId });
    expect(res.total).toBe(0);
    expect(res.items).toEqual([]);
    expect(res.query.parsed.reason).toBe('only-negation');
  });

  // 10. Garbage input.
  it('#10 garbage `%` / `_` / empty: total 0, does not match everything', async () => {
    await insertPage({ title: 'какая-то страница', textContent: 'текст' });
    for (const q of ['%', '_', '   ', '%%__']) {
      const res = await search(buildService(), { query: q, spaceId });
      expect(res.total).toBe(0);
      expect(res.items).toEqual([]);
    }
  });

  // 11. Permission-filtered total (fail-closed) + mutation guard.
  it('#11 a permission-hidden page is absent from items AND total', async () => {
    const visible = await insertPage({
      title: 'разрешённая пермишен-страница',
      textContent: 'пермишенмаркер',
    });
    const hidden = await insertPage({
      title: 'скрытая пермишен-страница',
      textContent: 'пермишенмаркер',
    });
    // Filter keeps only the visible page.
    const filtered = buildService({ accessibleIds: [visible] });
    const res = await search(filtered, { query: 'пермишенмаркер', spaceId });
    const ids = res.items.map((i: any) => i.id);
    expect(ids).toContain(visible);
    expect(ids).not.toContain(hidden);
    // total is the POST-permission count — the hidden page does not leak into it.
    expect(res.total).toBe(1);

    // MUTATION: disable the guard (passthrough) → the hidden page reappears in
    // BOTH items and total. If this did NOT change, the guard is not load-bearing.
    const open = buildService({ accessibleIds: null });
    const res2 = await search(open, { query: 'пермишенмаркер', spaceId });
    expect(res2.items.map((i: any) => i.id)).toContain(hidden);
    expect(res2.total).toBe(2);
  });

  it('#11b a permission-query error PROPAGATES (fail-closed, never empty)', async () => {
    await insertPage({ title: 'failclosed маркер', textContent: 'failclosedmarker' });
    const svc = buildService({ filterThrows: true });
    await expect(
      search(svc, { query: 'failclosedmarker', spaceId }),
    ).rejects.toThrow(/permission query failed/);
  });

  // A8 path fix.
  it('#11c path: a soft-deleted / cross-space ancestor title does not leak', async () => {
    const otherSpace = (await createSpace(db, workspaceId)).id;
    const root = await insertPage({ title: 'Живой корень' });
    const deletedMid = await insertPage({
      title: 'УдалённыйПредок',
      parentPageId: root,
      deletedAt: new Date(),
    });
    const leaf = await insertPage({
      title: 'a8leaf уникальный',
      parentPageId: deletedMid,
      textContent: 'a8leafmarker',
    });
    const res = await search(buildService(), { query: 'a8leafmarker', spaceId });
    const hit = res.items.find((i: any) => i.id === leaf);
    expect(hit).toBeDefined();
    // The walk stops at the deleted ancestor — no deleted title in the path.
    expect(hit.path).not.toContain('УдалённыйПредок');
    expect(hit.path).not.toContain('Живой корень');

    // Cross-space parent must also not leak.
    const foreignParent = await insertPage({
      title: 'ЧужойСпейс',
      spaceId: otherSpace,
    });
    const crossLeaf = await insertPage({
      title: 'crossleaf узел',
      parentPageId: foreignParent,
      textContent: 'crossleafmarker',
    });
    const res2 = await search(buildService(), {
      query: 'crossleafmarker',
      spaceId,
    });
    const hit2 = res2.items.find((i: any) => i.id === crossLeaf);
    expect(hit2).toBeDefined();
    expect(hit2.path).not.toContain('ЧужойСпейс');
  });

  // 12. Web-UI superset.
  it('#12 web path (no flags) returns the OR result with the icon/space/highlight superset', async () => {
    const page = await insertPage({
      title: 'веб суперсет страница',
      textContent: 'суперсетмаркер контент',
    });
    const res = await search(buildService(), { query: 'суперсетмаркер', spaceId });
    const hit = res.items.find((i: any) => i.id === page);
    expect(hit).toBeDefined();
    // Superset fields the web-UI relies on.
    expect('icon' in hit).toBe(true);
    expect('space' in hit).toBe(true);
    expect('highlight' in hit).toBe(true);
    expect('rank' in hit).toBe(true);
    // Plus the new fields.
    expect('path' in hit).toBe(true);
    expect('snippet' in hit).toBe(true);
    expect('score' in hit).toBe(true);
    // FTS hit carries a non-null rank + highlight.
    expect(hit.rank).not.toBeNull();
  });

  // 13. RAG lockstep: the page_embeddings.fts generated column is ru_en.
  it('#13 page_embeddings.fts uses ru_en (cyrillic stemming) — RAG lockstep', async () => {
    const pageId = await insertPage({
      title: 'rag страница',
      textContent: 'ресторанов много',
    });
    // Insert a chunk row; the generated fts column is computed by Postgres.
    await sql`
      INSERT INTO page_embeddings
        (id, page_id, workspace_id, space_id, attachment_id, chunk_index,
         chunk_start, chunk_length, content, model_name, model_dimensions, embedding)
      VALUES
        (${randomUUID()}, ${pageId}, ${workspaceId}, ${spaceId}, NULL, 0,
         0, 20, ${'ресторанов москвы много'}, 'test-model', 3, '[0.1,0.2,0.3]'::vector)
    `.execute(db);
    // A ru_en query stems «москва» → «москв», matching the stored «москвы».
    // Under the old `english` config the cyrillic word would not stem and this
    // inflected-form query would miss — so this asserts the ru_en lockstep.
    const row = await sql<{ m: boolean }>`
      SELECT fts @@ to_tsquery('ru_en', f_unaccent('москва')) AS m
      FROM page_embeddings WHERE page_id = ${pageId}
    `.execute(db);
    expect(row.rows[0].m).toBe(true);
  });

  // W4 — substring-tier dominance under RRF: title-exact (tier 3) > title-
  // substring (tier 2) > text-only (tier 1). The engine encodes this via
  // sub_tier DESC → rn_sub → RRF; no test asserted the end-to-end ordering, so
  // this restores that guarantee. match:'substring' routes the term to the
  // substring branch (no FTS leg), so sub_tier alone drives the order.
  it('W4 tier dominance: title-exact > title-substring > text-only', async () => {
    const exact = await insertPage({ title: 'tierdomxyz' }); // tier 3
    const titleSub = await insertPage({
      title: 'prefix tierdomxyz suffix', // tier 2
    });
    const textOnly = await insertPage({
      title: 'w4 unrelated heading',
      textContent: 'body has tierdomxyz here', // tier 1
    });
    const res = await search(buildService(), {
      query: 'tierdomxyz',
      match: 'substring',
      spaceId,
    });
    const ids = res.items.map((i: any) => i.id);
    expect(ids).toContain(exact);
    expect(ids).toContain(titleSub);
    expect(ids).toContain(textOnly);
    // Strict tier order.
    expect(ids.indexOf(exact)).toBeLessThan(ids.indexOf(titleSub));
    expect(ids.indexOf(titleSub)).toBeLessThan(ids.indexOf(textOnly));
  });

  // S3 — an exact-title hit must NOT be lost when the match set exceeds
  // CANDIDATE_CAP: it ranks first under RRF (tier 3) so it lands in the reachable
  // window even with a tiny cap. Restores a guarantee the old lookup suite gave.
  it('S3 exact-title survives the CANDIDATE_CAP window', async () => {
    const exact = await insertPage({ title: 'capmarkerxyz' }); // tier 3
    for (let i = 0; i < 6; i++) {
      await insertPage({
        title: `cap filler ${i}`,
        textContent: 'noise capmarkerxyz noise', // tier 1
      });
    }
    process.env.SEARCH_CANDIDATE_CAP = '2';
    try {
      const res = await search(buildService(), {
        query: 'capmarkerxyz',
        match: 'substring',
        spaceId,
        limit: 25,
      });
      // More matches than the cap → truncated, but the exact-title survives.
      expect(res.total).toBeGreaterThan(2);
      expect(res.truncatedAtCap).toBe(true);
      expect(res.items.length).toBe(2); // the reachable window
      expect(res.items.map((i: any) => i.id)).toContain(exact);
    } finally {
      delete process.env.SEARCH_CANDIDATE_CAP;
    }
  });

  // S1 — a required-only query (`+term`, no bare positive) really matches, so its
  // hits must report matchedFields / rank / highlight, not [] / null. Before the
  // fix these detail exprs were built from parsed.positive only.
  it('S1 required-only query populates matchedFields + rank on a title match', async () => {
    const page = await insertPage({
      title: 'Кофейня s1маркер центр',
      textContent: 'обычный текст без ключевого слова',
    });
    const res = await search(buildService(), { query: '+кофейня', spaceId });
    const hit = res.items.find((i: any) => i.id === page);
    expect(hit).toBeDefined();
    // The title matches the required term → matchedFields includes 'title'.
    expect(hit.matchedFields).toContain('title');
    // FTS rank is populated (was null before the S1 fix).
    expect(hit.rank).not.toBeNull();
    // matchedTerms already echoed the required term; still true.
    expect(hit.matchedTerms).toContain('кофейня');
  });

  // F1 — stack-depth guard: a pasted text block (thousands of FTS terms) used to
  // nest the combined tsquery so deep that Postgres raised `stack depth limit
  // exceeded` → HTTP 500 for the caller. The parser now caps terms at
  // MAX_PARSED_TERMS, so a huge query returns 200 and the leading (in-cap) term
  // still matches. Mutation: remove the cap → this reddens (500 / stack depth).
  it('F1 a huge multi-term query returns 200, not a stack-depth 500', async () => {
    const page = await insertPage({
      title: 'qfonemarker заголовок',
      textContent: 'тело страницы',
    });
    // Purely-alphabetic filler words → FTS branch (the branch that nests in
    // combineTsq). A digit-bearing token would route to substring and not nest.
    const alphaWord = (i: number): string => {
      let s = '';
      let n = i + 1;
      while (n > 0) {
        s = String.fromCharCode(97 + (n % 26)) + s;
        n = Math.floor(n / 26);
      }
      return 'q' + s;
    };
    const words = [
      'qfonemarker',
      ...Array.from({ length: 5000 }, (_, i) => alphaWord(i)),
    ];
    const res = await search(buildService(), {
      query: words.join(' '),
      spaceId,
    });
    // Bounded nesting → no 500; the leading in-cap term still recalls the page.
    expect(res.items.map((i: any) => i.id)).toContain(page);
  });

  // F2 — titleOnly leak-guard (restores coverage the deleted lookup spec gave).
  // A term present ONLY in text_content must NOT match under titleOnly, and a
  // title hit must carry NO body snippet. Uses match:'substring' because titleOnly
  // gates the substring branch (the FTS `pages.tsv` already spans title+body).
  it('F2 titleOnly does not match text_content and yields no body snippet', async () => {
    // Marker lives only in the body, never in the title.
    const bodyOnly = await insertPage({
      title: 'нейтральный заголовок f2',
      textContent: 'секрет titleonlybody конец',
    });
    const res = await search(buildService(), {
      query: 'titleonlybody',
      match: 'substring',
      spaceId,
      titleOnly: true,
    });
    // titleOnly must NOT leak a body-substring match.
    expect(res.items.map((i: any) => i.id)).not.toContain(bodyOnly);

    // Sanity: WITHOUT titleOnly the same term DOES find it via the body.
    const resOpen = await search(buildService(), {
      query: 'titleonlybody',
      match: 'substring',
      spaceId,
    });
    expect(resOpen.items.map((i: any) => i.id)).toContain(bodyOnly);

    // A page that hits on its TITLE: the snippet must be empty (no body leaks in).
    const titleHit = await insertPage({
      title: 'titleonlytitle страница',
      textContent: 'какой-то текст тела здесь для сниппета',
    });
    const res2 = await search(buildService(), {
      query: 'titleonlytitle',
      match: 'substring',
      spaceId,
      titleOnly: true,
    });
    const hit = res2.items.find((i: any) => i.id === titleHit);
    expect(hit).toBeDefined();
    expect(hit.snippet).toBe('');
  });

  // F3 — parentPageId subtree scoping (restores coverage the deleted lookup spec
  // gave). Two sibling subtrees share one term; scoping to ONE root returns only
  // that subtree's hits INCLUDING the root/parent page itself, and NONE of the
  // sibling subtree. Mutation: drop the ANY(descendantIds) filter → this reddens.
  it('F3 parentPageId scopes to one subtree incl. the parent, excludes siblings', async () => {
    const rootA = await insertPage({
      title: 'subtreeA корень',
      textContent: 'f3marker в корне A',
    });
    const childA = await insertPage({
      title: 'subtreeA потомок',
      textContent: 'f3marker в потомке A',
      parentPageId: rootA,
    });
    const rootB = await insertPage({
      title: 'subtreeB корень',
      textContent: 'f3marker в корне B',
    });
    const childB = await insertPage({
      title: 'subtreeB потомок',
      textContent: 'f3marker в потомке B',
      parentPageId: rootB,
    });
    const res = await search(buildService(), {
      query: 'f3marker',
      spaceId,
      parentPageId: rootA,
    });
    const ids = res.items.map((i: any) => i.id);
    expect(ids).toContain(rootA); // the parent/root page itself
    expect(ids).toContain(childA);
    expect(ids).not.toContain(rootB); // sibling subtree cut off
    expect(ids).not.toContain(childB);
  });

  // F4 — positive path + snippet content asserts (the #11c test only asserts what
  // must NOT be in path). (a) a nested hit's path is root→parent ordered and a
  // root-level hit's path is []; (b) a text-body hit returns a NON-empty snippet.
  it('F4 path is root→parent ordered ([] at root) and body hits carry a snippet', async () => {
    const root = await insertPage({ title: 'F4Root' });
    const parent = await insertPage({ title: 'F4Parent', parentPageId: root });
    const leaf = await insertPage({
      title: 'f4leaf лист',
      parentPageId: parent,
      textContent: 'f4leafmarker тело с содержимым для сниппета',
    });
    const res = await search(buildService(), {
      query: 'f4leafmarker',
      spaceId,
    });
    const hit = res.items.find((i: any) => i.id === leaf);
    expect(hit).toBeDefined();
    // Positive ancestry: root → direct parent, hit's own title excluded.
    expect(hit.path).toEqual(['F4Root', 'F4Parent']);
    // Snippet content: a text-body hit returns a non-empty snippet with the term.
    expect(hit.snippet.length).toBeGreaterThan(0);
    expect(hit.snippet).toContain('f4leafmarker');

    // A root-level hit (no parent) → empty path.
    const rootHit = await insertPage({
      title: 'f4rootlevel уникальный',
      textContent: 'f4rootmarker в теле',
    });
    const res2 = await search(buildService(), {
      query: 'f4rootmarker',
      spaceId,
    });
    const hit2 = res2.items.find((i: any) => i.id === rootHit);
    expect(hit2).toBeDefined();
    expect(hit2.path).toEqual([]);
  });

  // === #530 Phase B (PR-1): semantic fusion ==================================
  // Deterministic fake embedder (no live model) + real PageEmbeddingRepo on the
  // migrated DB with planted vectors + the active fingerprint, so cosine ordering
  // is fully controlled. Each case runs in its OWN space so planted rows never
  // leak across tests.
  describe('#530 semantic fusion', () => {
    // 1. Vector-only hit: nearest to a page that has NO lexical match for the
    //    query term — it appears via the vector arm, and a pure-lexical run does
    //    not return it. Mutation (a): drop the vector arm -> this reddens.
    it('#530-1 a vector-only hit appears; a pure-lexical run would not return it', async () => {
      const s = (await createSpace(db, workspaceId)).id;
      const page = await insertPage({
        title: 'нейтральный вект заголовок',
        textContent: 'содержимое без искомого термина',
        spaceId: s,
      });
      await plantEmbedding(page, conceptVec(1), ACTIVE_FP, s);

      const svc = buildService({ embedVector: conceptVec(1), userSpaceIds: [s] });
      const res = await search(svc, { query: 'квазонимикс', spaceId: s });
      expect(res.items.map((i: any) => i.id)).toContain(page);
      expect(res.semantic.available).toBe(true);
      expect(res.semantic.state).toBe('full');

      // Pure-lexical (default degrade): the vector-only page is absent.
      const lex = buildService({ userSpaceIds: [s] });
      const res2 = await search(lex, { query: 'квазонимикс', spaceId: s });
      expect(res2.items.map((i: any) => i.id)).not.toContain(page);
      expect(res2.semantic.available).toBe(false);
    });

    // 2. Sidecar down: embedQuery throws -> results = the lexical set; semantic
    //    unavailable; the fixed 'search.semantic.degraded' event is logged.
    it('#530-2 sidecar-down degrades to lexical and logs search.semantic.degraded', async () => {
      const s = (await createSpace(db, workspaceId)).id;
      const lexHit = await insertPage({
        title: 'семдвамаркер лексический',
        textContent: 'обычный текст',
        spaceId: s,
      });
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined as any);
      try {
        const svc = buildService({ embedThrows: 'degraded', userSpaceIds: [s] });
        const res = await search(svc, { query: 'семдвамаркер', spaceId: s });
        expect(res.items.map((i: any) => i.id)).toContain(lexHit);
        expect(res.semantic.available).toBe(false);
        expect(res.semantic.reason).toBe('degraded');
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('search.semantic.degraded'),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    // 3. No provider: resolveEmbeddingProvider yields none -> lexical results,
    //    reason no-provider, no 500.
    it('#530-3 no-provider yields lexical results with reason no-provider', async () => {
      const s = (await createSpace(db, workspaceId)).id;
      const hit = await insertPage({
        title: 'семтримаркер тема',
        textContent: 'текст',
        spaceId: s,
      });
      const svc = buildService({ embedThrows: 'no-provider', userSpaceIds: [s] });
      const res = await search(svc, { query: 'семтримаркер', spaceId: s });
      expect(res.items.map((i: any) => i.id)).toContain(hit);
      expect(res.semantic.available).toBe(false);
      expect(res.semantic.reason).toBe('no-provider');
    });

    // 4. Permission over the union: a restricted vector-only hit is dropped from
    //    items AND total; with the permission filter throwing the call rejects
    //    (fail-closed, never fail-open). Mutation (b): move filterAccessiblePageIds
    //    inside the semantic try/catch -> the reject assertion reddens.
    it('#530-4 permission filters a vector-only hit from items AND total (fail-closed)', async () => {
      const s = (await createSpace(db, workspaceId)).id;
      const visibleLex = await insertPage({
        title: 'семчетмаркер видимый',
        textContent: 'доступный текст',
        spaceId: s,
      });
      const hiddenVec = await insertPage({
        title: 'скрытая вект страница',
        textContent: 'содержимое без искомого термина',
        spaceId: s,
      });
      await plantEmbedding(hiddenVec, conceptVec(4), ACTIVE_FP, s);

      // Query hits visibleLex lexically; hiddenVec only via the vector arm.
      const svc = buildService({
        embedVector: conceptVec(4),
        accessibleIds: [visibleLex],
        userSpaceIds: [s],
      });
      const res = await search(svc, { query: 'семчетмаркер', spaceId: s });
      const ids = res.items.map((i: any) => i.id);
      expect(ids).toContain(visibleLex);
      expect(ids).not.toContain(hiddenVec);
      // The hidden vector hit does not leak into total either.
      expect(res.total).toBe(1);
      expect(ids).toHaveLength(res.total);

      // A permission-query error PROPAGATES (never a fail-open empty result).
      const boom = buildService({
        embedVector: conceptVec(4),
        filterThrows: true,
        userSpaceIds: [s],
      });
      await expect(
        search(boom, { query: 'семчетмаркер', spaceId: s }),
      ).rejects.toThrow(/permission query failed/);
    });

    // 5. Hung sidecar under a short embed timeout: graceful degrade (never a 500).
    it('#530-5 a hung sidecar under a short timeout degrades gracefully', async () => {
      const s = (await createSpace(db, workspaceId)).id;
      const hit = await insertPage({
        title: 'семпятьмаркер тема',
        textContent: 'текст',
        spaceId: s,
      });
      process.env.SEARCH_EMBED_TIMEOUT_MS = '1';
      try {
        const svc = buildService({ embedThrows: 'degraded', userSpaceIds: [s] });
        const res = await search(svc, { query: 'семпятьмаркер', spaceId: s });
        expect(res.items.map((i: any) => i.id)).toContain(hit);
        expect(res.semantic.available).toBe(false);
        expect(res.semantic.reason).toBe('degraded');
      } finally {
        delete process.env.SEARCH_EMBED_TIMEOUT_MS;
      }
    });

    // 6. A page matched BOTH lexically and by vector is fused (de-duped), not
    //    returned twice — the agg CTE collapses it to one row.
    it('#530-6 a page matched lexically AND by vector appears once', async () => {
      const s = (await createSpace(db, workspaceId)).id;
      const both = await insertPage({
        title: 'семшестьмаркер общий',
        textContent: 'и лексика и вектор',
        spaceId: s,
      });
      await plantEmbedding(both, conceptVec(6), ACTIVE_FP, s);
      const svc = buildService({ embedVector: conceptVec(6), userSpaceIds: [s] });
      const res = await search(svc, { query: 'семшестьмаркер', spaceId: s });
      const ids = res.items.map((i: any) => i.id);
      expect(ids.filter((id: string) => id === both)).toHaveLength(1);
      expect(res.total).toBe(1);
    });

    // 7. Fingerprint isolation: a planted row under a DIFFERENT fingerprint is not
    //    a vector candidate for the active-fingerprint query (guards mixing
    //    generations). It only appears if it also matches lexically (it does not).
    it('#530-7 a stale-fingerprint vector row is not fused into results', async () => {
      const s = (await createSpace(db, workspaceId)).id;
      const stale = await insertPage({
        title: 'нейтральный семь заголовок',
        textContent: 'без искомого термина совсем',
        spaceId: s,
      });
      // Same concept vector as the query, but an OLD generation fingerprint.
      await plantEmbedding(stale, conceptVec(7), 'fp-stale-old', s);
      const svc = buildService({ embedVector: conceptVec(7), userSpaceIds: [s] });
      const res = await search(svc, { query: 'квазонимиксseven', spaceId: s });
      expect(res.items.map((i: any) => i.id)).not.toContain(stale);
    });

    // 8. Stale embedding space_id (moved page): a page currently in space B whose
    //    embedding rows still carry space A (movePageToSpace does NOT reindex) is
    //    STILL a vector hit when searching B — space scoping is enforced only by
    //    the pages join (pages.space_id, always current), NOT by a stale
    //    page_embeddings.space_id. Guards against re-adding that predicate (which
    //    would wrongly drop the moved page's vector-only hit).
    it('#530-8 a vector hit with a STALE embedding space_id (moved page) is still returned', async () => {
      const newSpace = (await createSpace(db, workspaceId)).id;
      const oldSpace = (await createSpace(db, workspaceId)).id;
      // The page currently lives in newSpace (as after a move into newSpace).
      const page = await insertPage({
        title: 'перемещённая вект страница',
        textContent: 'содержимое без искомого термина',
        spaceId: newSpace,
      });
      // Its embedding was stamped with the OLD space and never reindexed.
      await plantEmbedding(page, conceptVec(8), ACTIVE_FP, oldSpace);
      const svc = buildService({
        embedVector: conceptVec(8),
        userSpaceIds: [newSpace],
      });
      const res = await search(svc, {
        query: 'квазонимиксeight',
        spaceId: newSpace,
      });
      // Survives despite page_embeddings.space_id (oldSpace) != pages.space_id.
      expect(res.items.map((i: any) => i.id)).toContain(page);
      expect(res.semantic.available).toBe(true);
    });

    // 9. Statement-timeout safety net: a pathologically slow vector scan is
    //    cancelled (SQLSTATE 57014) and search degrades to lexical-only — the
    //    lexical hit survives, the vector-only hit vanishes, no 500/hang, and the
    //    degraded event is logged. Mutation: make the fallback re-throw instead of
    //    degrading -> this test reds (the call rejects with 57014).
    it('#530-9 a vector-query timeout degrades to lexical (57014), never 500', async () => {
      const s = (await createSpace(db, workspaceId)).id;
      const lexHit = await insertPage({
        title: 'семдевятьмаркер лексический',
        textContent: 'обычный текст',
        spaceId: s,
      });
      const vecOnly = await insertPage({
        title: 'нейтральный девять заголовок',
        textContent: 'без искомого термина',
        spaceId: s,
      });
      await plantEmbedding(vecOnly, conceptVec(9), ACTIVE_FP, s);

      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined as any);
      // Tiny per-statement timeout so the 0.5s sleeping arm is cancelled.
      process.env.SEARCH_VECTOR_STATEMENT_TIMEOUT_MS = '50';
      try {
        const svc = buildService({
          embedVector: conceptVec(9),
          slowVectorArm: true,
          userSpaceIds: [s],
        });
        const res = await search(svc, { query: 'семдевятьмаркер', spaceId: s });
        // Lexical result survives; the vector-only page does NOT (arm cancelled).
        const ids = res.items.map((i: any) => i.id);
        expect(ids).toContain(lexHit);
        expect(ids).not.toContain(vecOnly);
        expect(res.semantic.available).toBe(false);
        expect(res.semantic.reason).toBe('degraded');
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('search.semantic.degraded'),
        );
      } finally {
        delete process.env.SEARCH_VECTOR_STATEMENT_TIMEOUT_MS;
        warnSpy.mockRestore();
      }
    });

    // 10. SET LOCAL scoping: the search's statement timeout must NOT leak onto a
    //     later query on the same pooled connection. After a search that set a
    //     tiny timeout, a deliberately-slow standalone query still completes.
    it('#530-10 the per-query statement timeout does not leak to later queries', async () => {
      const s = (await createSpace(db, workspaceId)).id;
      await insertPage({
        title: 'семдесятьмаркер тема',
        textContent: 'текст',
        spaceId: s,
      });
      process.env.SEARCH_VECTOR_STATEMENT_TIMEOUT_MS = '50';
      try {
        const svc = buildService({
          embedVector: conceptVec(10),
          slowVectorArm: true,
          userSpaceIds: [s],
        });
        // This search trips + resets the local timeout (via SET LOCAL semantics).
        await search(svc, { query: 'семдесятьмаркер', spaceId: s });
        // A subsequent query that sleeps 200ms must NOT be cancelled — proving the
        // 50ms search timeout did not persist on the connection (it would raise
        // 57014 if it had leaked). SET LOCAL auto-resets at the search tx end.
        await expect(sql`SELECT pg_sleep(0.2)`.execute(db)).resolves.toBeDefined();
      } finally {
        delete process.env.SEARCH_VECTOR_STATEMENT_TIMEOUT_MS;
      }
    });

    // 11. COMMIT-path no-leak (locks is_local=true). #530-10 only covers the
    //     ROLLBACK path (a timed-out search rolls back — a plain session SET would
    //     ALSO be undone on rollback, so it would NOT catch is_local true->false).
    //     Here a NORMAL, FAST semantic search COMMITs its transaction; a leaked
    //     session-level statement_timeout would then persist on the pooled
    //     connection and cancel later queries. We prove it does NOT: after the
    //     committing search (bounded at a small 100ms), a 300ms query succeeds.
    //     Because postgres.js pools, we run several sequential slow queries so at
    //     least one reuses the connection the committed search ran on (which is
    //     where a leaked timeout would live); ALL must succeed. Mutation: flip
    //     is_local true->false -> the committed 100ms timeout leaks and the
    //     follow-up pg_sleep is cancelled (57014), reddening this test.
    it('#530-11 a COMMITTED search does not leak its statement timeout (is_local)', async () => {
      const s = (await createSpace(db, workspaceId)).id;
      const page = await insertPage({
        title: 'семодиннадцать вект страница',
        textContent: 'содержимое без искомого термина',
        spaceId: s,
      });
      await plantEmbedding(page, conceptVec(11), ACTIVE_FP, s);
      // Small bound: the fast vector arm still completes (<100ms) so the search
      // COMMITs, but small enough that a LEAKED timeout would cancel the 300ms
      // follow-ups below.
      process.env.SEARCH_VECTOR_STATEMENT_TIMEOUT_MS = '100';
      try {
        const svc = buildService({
          embedVector: conceptVec(11),
          userSpaceIds: [s],
        });
        const res = await search(svc, { query: 'семодиннадцать', spaceId: s });
        // The (committing) vector path actually ran.
        expect(res.semantic.available).toBe(true);
        // Each 300ms query must SUCCEED — a leaked 100ms timeout would cancel the
        // one that reuses the committed search's connection. 8 sweeps cover the
        // whole pool (max 5 conns), so a leak on any connection is caught.
        for (let i = 0; i < 8; i++) {
          await expect(
            sql`SELECT pg_sleep(0.3)`.execute(db),
          ).resolves.toBeDefined();
        }
      } finally {
        delete process.env.SEARCH_VECTOR_STATEMENT_TIMEOUT_MS;
      }
    });
  });
});
