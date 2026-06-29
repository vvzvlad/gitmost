import { PageRepo } from './page.repo';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';

/**
 * F6 regression guard for the embeddable-page predicate.
 *
 * The predicate is shared by `countEmbeddablePages` (the "Indexed N of M" coverage
 * denominator) and `getEmbeddablePageIds` (the exact set a full reindex iterates).
 * It MUST select pages whose `text_content` was never backfilled (null/empty) but
 * whose ProseMirror `content` JSON still carries body text — `reindexPage` builds
 * its chunks straight from `content`, so without a content clause such a page is
 * silently SKIPPED by a mass reindex even though it is fully embeddable.
 *
 * The content clause keys on the structural text-node marker `"type":"text"`, NOT
 * a bare `"text":` key. The bare key also appears as the `attrs.text` of atom
 * nodes that carry NO extractable text — notably math (`mathBlock`/`mathInline`),
 * whose LaTeX lives in `attrs.text` and has no `generateText` serializer. A
 * math-ONLY page therefore yields empty `text_content` and zero embeddings; if the
 * predicate matched its `attrs.text` it would land in the denominator but
 * `reindexPage` would no-op on it, pinning "Indexed N of M" below 100% forever —
 * the exact bug this feature fixes. The `"type":"text"` marker matches only real
 * text nodes (what `jsonToText` extracts), keeping the predicate consistent with
 * what gets indexed.
 *
 * There is no real Postgres here: a recording Kysely (DummyDriver wired to the
 * Postgres query compiler) compiles the queries to SQL so we can assert the WHERE
 * predicate ORs in the narrowed content clause alongside the existing text_content
 * and stored-embeddings clauses — and that BOTH callers compile the identical
 * clause (denominator and reindex set can never diverge).
 */
function makeRecordingDb() {
  const sqls: string[] = [];
  const db = new Kysely<any>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () =>
        new (class extends DummyDriver {
          async acquireConnection() {
            return {
              executeQuery: async (compiled: { sql: string }) => {
                sqls.push(compiled.sql);
                return { rows: [] };
              },
              // eslint-disable-next-line @typescript-eslint/no-empty-function
              streamQuery: async function* () {},
            } as any;
          }
        })(),
      createIntrospector: (d: Kysely<any>) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, sqls };
}

// The narrowed content clause, as it appears in the compiled SQL. Keying on the
// structural `"type":"text"` marker (not a bare `"text":` key) is what excludes
// math-only pages whose only `"text"` key is the atom node's `attrs.text`.
const NARROWED_CLAUSE = `"type"[[:space:]]*:[[:space:]]*"text"`;
const BARE_TEXT_KEY = `"text"[[:space:]]*:`;

describe('PageRepo embeddable predicate — content-bearing pages (F6)', () => {
  it('selects content-bearing pages via the narrowed "type":"text" node marker', async () => {
    const { db, sqls } = makeRecordingDb();
    const repo = new PageRepo(db as any, {} as any, { emit: jest.fn() } as any);

    await repo.getEmbeddablePageIds('ws-1');

    expect(sqls).toHaveLength(1);
    const sql = sqls[0];

    // Clause 1 (existing): pages with extractable text_content.
    expect(sql).toContain('text_content');
    // Clause 3 (the F6 fix, now narrowed): a page whose content JSON carries a
    // real text node is selected even when text_content is null/empty, so a full
    // reindex visits it instead of silently skipping it.
    expect(sql).toContain('content::text');
    expect(sql).toContain(NARROWED_CLAUSE);
    // It must NOT use the old bare `"text":` key, which also matches the
    // `attrs.text` of math-only atom pages (false-positive denominator inflation).
    expect(sql).not.toContain(BARE_TEXT_KEY);
    // Clause 2 (existing): pages that already have stored embeddings stay in the
    // set so a reindex can clear their stale rows.
    expect(sql.toLowerCase()).toContain('embeddings');
  });

  it('countEmbeddablePages compiles the SAME narrowed clause as getEmbeddablePageIds', async () => {
    // Consistency is the core requirement: the denominator (countEmbeddablePages)
    // and the reindex set (getEmbeddablePageIds) MUST share the identical
    // predicate, else the live "done" counter and the steady-state total diverge.
    const { db, sqls } = makeRecordingDb();
    const repo = new PageRepo(db as any, {} as any, { emit: jest.fn() } as any);

    await repo.countEmbeddablePages('ws-1');
    await repo.getEmbeddablePageIds('ws-1');

    expect(sqls).toHaveLength(2);
    const [countSql, idsSql] = sqls;

    // Both carry the narrowed content clause...
    expect(countSql).toContain(NARROWED_CLAUSE);
    expect(idsSql).toContain(NARROWED_CLAUSE);
    // ...neither carries the bare key...
    expect(countSql).not.toContain(BARE_TEXT_KEY);
    expect(idsSql).not.toContain(BARE_TEXT_KEY);
    // ...and the full OR predicate (text_content + content node + embeddings
    // EXISTS) is byte-identical between the two queries, so they can't drift.
    const where = (s: string) => s.slice(s.indexOf('where'));
    expect(where(countSql)).toEqual(where(idsSql));
  });

  it('the content regex matches a text-bearing doc but NOT a math-only doc', () => {
    // Semantic check of the predicate against sample `content::text` payloads.
    // Note: `jsonb::text` is NOT identical to JSON.stringify — Postgres renders a
    // space after each colon (`"type": "text"`), which is exactly why the POSIX
    // clause uses `[[:space:]]*`. The clause `"type"[[:space:]]*:[[:space:]]*"text"`
    // maps to the JS regex below (`[[:space:]]` -> `\s`, tolerating both forms);
    // we evaluate it the way Postgres would.
    const re = /"type"\s*:\s*"text"/;

    // A real paragraph with a text node -> embeddable.
    const textDoc = JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'hello world' }],
        },
      ],
    });
    // A doc whose ONLY node is a math atom. Its LaTeX is in `attrs.text`, there is
    // no text node, and `jsonToText`/`generateText` has no serializer for it -> it
    // yields empty text_content and zero embeddings, so it must NOT qualify.
    const mathOnlyDoc = JSON.stringify({
      type: 'doc',
      content: [
        { type: 'mathBlock', attrs: { text: 'E = mc^2' } },
        { type: 'mathInline', attrs: { text: '\\alpha' } },
      ],
    });
    // An empty doc has no text node either.
    const emptyDoc = JSON.stringify({ type: 'doc', content: [] });

    expect(re.test(textDoc)).toBe(true);
    expect(re.test(mathOnlyDoc)).toBe(false);
    expect(re.test(emptyDoc)).toBe(false);
    // Sanity: the OLD bare-key regex WOULD have wrongly matched the math-only doc,
    // which is precisely the false positive the narrowing removes.
    expect(/"text"\s*:/.test(mathOnlyDoc)).toBe(true);

    // A user literally TYPING `"type":"text"` in prose can't false-positive on an
    // otherwise text-less page: in `content::text` the typed value's quotes are
    // escaped (`\"type\":\"text\"`), so the literal-quote regex does not match the
    // escaped form. (And such a page is a genuine text node anyway.)
    const escapedLiteral = JSON.stringify({
      type: 'doc',
      content: [{ type: 'someAtom', attrs: { note: '"type":"text"' } }],
    });
    expect(re.test(escapedLiteral)).toBe(false);
  });
});
