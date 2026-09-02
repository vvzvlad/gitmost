# Reading the AI dialog logs (how agents call tools, and where they fail)

How to inspect the agent conversation history in the database — and, more
importantly, the **one non-obvious trap that will make you report the wrong
answer**: the persisted history *silently hides hard tool failures*. Written from
real pain (a "which tools fail most?" analysis that confidently answered
"patchNode: 0 errors" while the UI was visibly full of red `patchNode` failures).

Read the **Gotchas** section before you trust any error count.

> **TWO ERAS — check the marker first.** The `tool_calls` shape changed in **#490
> (trace v2)**. A row written by v2 carries `metadata.toolTraceVersion = 2`; older
> rows have no such key. The two shapes store DIFFERENT things (v2 dropped the tool
> OUTPUT from the trace), so **every query below is dual-shape** — branch on the
> marker. **Never compare an aggregate or trend across the era boundary**: a metric
> jump on the cut-over week is an artifact of the shape change, not a behavior
> change.

## TL;DR

- Agent chats live in Postgres, DB `docmost`, tables `ai_chat_*`.
- **Era marker:** `metadata.toolTraceVersion = 2` ⇒ v2 (#490) row; absent ⇒ legacy row.
- Each tool invocation is stored as **two** consecutive array elements — a
  `tool-call` part then an OUTCOME part — so naive counting double-counts.
  - **v2 (#490):** outcome is `{toolName, ok: true}` on success, or
    `{toolName, error, kind: 'thrown'|'interrupted'}` on failure. The tool **OUTPUT
    is NOT in `tool_calls`** any more — it lives once in `metadata.parts` (this
    removed a hundreds-of-MB-per-run write duplication). Soft-failure analysis
    therefore reads `metadata.parts`, not `tool_calls`.
  - **legacy:** outcome is `{toolName, output}` on success; a **thrown** failure is
    a `{toolName, error}` element **only on rows after #407**, and is dropped
    entirely (silent orphan) on pre-#407 rows.
- **A tool that *throws* writes no result part.** In v2 it is a
  `{error, kind:'thrown'}` element; an interrupted/aborted call is a distinct
  `{error, kind:'interrupted'}`. `isError`/`success=false` scans read the *output*
  and so under-report thrown failures in every era.
- To find where agents fail: (1) soft-failure markers in `metadata.parts` outputs
  (v2) / `tool_calls` outputs (legacy), (2) the `error`/`kind` fields for thrown
  failures (v2 + post-#407), (3) server logs / the live UI for full stack traces.

## Where the data lives

On the host that runs the wiki (its name and address are on the
`gitmost_vvzvlad wiki/документация стек` page in the Netmap wiki): container
`gitmost-postgresql` (`pgvector/pgvector:pg18`), database `docmost`.

```bash
# Host: Netmap -> `gitmost_vvzvlad wiki/документация стек`. That wiki runs on this
# same host, so when it is down, take the host from your ~/.ssh/config instead.
ssh <host>
# one-off query:
docker exec gitmost-postgresql psql -U docmost -d docmost -P pager=off -c "SELECT ..."
# interactive:
docker exec -it gitmost-postgresql psql -U docmost -d docmost
```

The main app container is `gitmost` (`DATABASE_URL=postgresql://docmost:...@db:5432/docmost`).
All workspaces (vvzvlad / wb / asakusa / …) share this **single** database — they
are rows in `workspaces`, not separate deployments.

### Relevant tables

| Table | What it holds |
| --- | --- |
| `ai_chats` | one row per conversation (`title`, `role_id`, `page_id`, `creator_id`) |
| `ai_chat_messages` | every message; tool calls live in `tool_calls` jsonb |
| `ai_chat_runs` | one row per agent run (turn): `status`, `error`, `step_count` |
| `ai_agent_roles` | agent definitions (`instructions`, `model_config`) |
| `ai_mcp_servers` | configured MCP tool servers per workspace |

`ai_chat_messages` columns that matter: `role` (`user` | `assistant` — there is **no**
separate `tool` role), `content` (text), `tool_calls` (jsonb array), `metadata`
(jsonb, holds run `error` + rendered `parts`), `status`, `tsv` (full-text index).

## Era marker — check this before every query

```sql
-- how many rows are in each era?
SELECT COALESCE((metadata->>'toolTraceVersion'), 'legacy') AS era, count(*)
FROM ai_chat_messages
WHERE role = 'assistant' AND jsonb_typeof(tool_calls) = 'array'
GROUP BY 1 ORDER BY 2 DESC;
```

- `toolTraceVersion = '2'` → **v2** (#490): outcome flags, **no output in the trace**.
- `NULL` (`'legacy'`) → pre-#490: outcome carries the tool `output` inline.

**Do not trend a metric across the cut-over.** The shape change alone shifts counts
(e.g. "elements with `output`" collapses to zero for v2), so a week that straddles
the boundary shows an artifact, not a behavior change. Segment by era, or restrict to
one era, before comparing.

## How tool calls are stored — READ THIS

Tool calls are **not** one-object-per-call. Each logical invocation is split into
two consecutive elements of the `tool_calls` array — a **call** then an **outcome**.
The outcome shape is era-dependent:

```text
# v2 (#490) — metadata.toolTraceVersion = 2
index 0: { "toolName":"getPage", "input":{...} }                       ← call     (has input)
index 1: { "toolName":"getPage", "ok":true }                          ← success  (NO output here)
   or  : { "toolName":"getPage", "error":"…", "kind":"thrown" }       ← threw
   or  : { "toolName":"getPage", "error":"…", "kind":"interrupted" }  ← aborted mid-step

# legacy — no toolTraceVersion
index 0: { "toolName":"getPage", "input":{...} }                       ← call     (has input, NO output)
index 1: { "toolName":"getPage", "output":{...} }                     ← success  (has output)
   or  : { "toolName":"getPage", "error":"…" }                        ← threw (post-#407 only)
```

The keys that can appear: `toolName`, `input` (call), and on the outcome — **v2:**
`ok` **or** `error`+`kind`; **legacy:** `output` **or** (post-#407) `error`. There is
no `state`, no `errorText`, no `type` in `tool_calls` (those live on `metadata.parts`).
Consequences:

1. **Real invocation count** — count the OUTCOME elements, not every element (else you
   double-count): **v2** = elements with `ok` or `error`; **legacy** = elements with
   `output` or `error`.
2. **Pairing:** a call (`input`) is followed by its outcome. `toolName` is on both, so
   you can group by tool on either. In v2 the `kind` field separates a real hard-fail
   (`thrown`) from an aborted call (`interrupted`) — a distinction legacy rows cannot
   make (both are orphans; see below).
3. **The tool OUTPUT is only in `metadata.parts` on v2 rows.** To inspect what a tool
   returned (soft-error markers, page bodies) on a v2 row, read the parts
   (`part->>'type' LIKE 'tool-%'`, `part->>'state' = 'output-available'`, `part->'output'`),
   not `tool_calls`.

## The two classes of failure (and which the DB can see)

### 1. Soft failures — tool RAN and returned an error-shaped result → PERSISTED ✅

These are visible in the tool `output` — **on v2 rows in `metadata.parts`** (the
`output-available` part's `output`), on **legacy rows in the `tool_calls` outcome
element's `output`**. The marker differs per tool:

| Tool(s) | Error marker in `output` |
| --- | --- |
| `editPageText` | `failed` is a **non-empty** array of `{find, reason}` (e.g. `text not found in the document`, `matches N times — provide a longer fragment or set replaceAll`). Also a soft `warning` when the `find` string contained markdown that only matched after stripping. |
| `semanticSearch` | `{ "unavailable": true, "reason": "semantic search unavailable" }` (feature/infra, not the agent's fault) |
| MCP passthrough (`Habr_*`, some `Search_*`) | `output` is an **array** (raw MCP content) whose text starts with `Error executing tool … validation error …` |
| generic | `output.isError = true` or `output.success = false` |

Note `editPageText` returns `failed: []` on success — filtering on the *presence*
of the key gives false positives; filter on **non-empty**.

### 2. Hard failures — tool THREW → PERSISTED ✅

When a tool throws (the classic one is `patchNode` / `insertNode` / `tableUpdateCell`
→ `Failed to encode document to Yjs (fromJSON): Unknown node type: undefined`), the
runtime writes **no `tool-result` part** — the failure is an ai@6 `tool-error` content
part. How that lands in `tool_calls` depends on the era:

- **v2 (#490):** a `{toolName, error, kind:'thrown'}` outcome element. An interrupted /
  aborted mid-step call is a **distinct** `{toolName, error:'Tool call did not
  complete.', kind:'interrupted'}` element — so you can tell a real hard-fail from an
  abort **directly, without the orphan heuristic**. Query `kind = 'thrown'`.
- **post-#407 legacy:** a `{toolName, error}` element (no `kind`) right after the call.
- **pre-#407 legacy:** the error is **dropped** — a silent **orphan** (a `call` with no
  `output` *and* no `error`).

The same real error text is replayed to the model on the next turn (an `output-error`
part with the real `errorText`, from `metadata.parts`), in every era.

**Cutover caveat.** Only pre-#407 legacy rows need the orphan proxy: an orphan is a
`tool-call` with no matching outcome. Orphans there also appear when a run is **aborted**
mid-flight (server restart), so a high-volume tool (`createComment`, `searchInPage`,
`Search_web_search`) shows orphans from aborts, not real errors. Treat the orphan gap as
an *upper bound* and cross-check the tool: a gap on a structural editor (`patchNode`,
`insertNode`, `updatePageJson`, `transformPage`) is almost certainly a thrown Yjs-encode
error; a gap on `createComment` is mostly aborts. **On v2 rows this ambiguity is gone**
— `kind` labels each outcome.

### 3. Run-level failures → `ai_chat_runs`

`status` ∈ `succeeded | aborted | failed | running`; `error` holds the text. Seen in
the wild: `Run interrupted by a server restart.` (aborts) and
`Failed after N attempts. Last error: The service may be temporarily overloaded`
(LLM provider 529). These are infra/provider, not agent tool misuse.

## Ready-to-use queries

Run all of these via `docker exec gitmost-postgresql psql -U docmost -d docmost -P pager=off -c "…"`.

**Real invocation count per tool** (outcome parts only — the correct denominator).
Dual-shape: a v2 outcome has `ok` or `error`; a legacy outcome has `output` or `error`:

```sql
SELECT elem->>'toolName' AS tool, count(*) AS calls
FROM ai_chat_messages m, jsonb_array_elements(m.tool_calls) elem
WHERE jsonb_typeof(m.tool_calls) = 'array'
  AND (elem ? 'ok' OR elem ? 'output' OR elem ? 'error')
GROUP BY 1 ORDER BY 2 DESC;
```

**Soft errors per tool.** The soft-error marker lives in the tool OUTPUT — which on
**v2 rows is in `metadata.parts`**, on **legacy rows is in the `tool_calls` outcome
element**. This query UNIONs both eras, projecting each output as `o`:

```sql
WITH res AS (
  -- v2 (#490): output is in metadata.parts (output-available tool parts)
  SELECT part->>'type' AS tool, part->'output' AS o
  FROM ai_chat_messages m, jsonb_array_elements(m.metadata->'parts') part
  WHERE (m.metadata->>'toolTraceVersion') = '2'
    AND part->>'type' LIKE 'tool-%' AND part->>'state' = 'output-available'
  UNION ALL
  -- legacy: output is inline in the tool_calls outcome element
  SELECT elem->>'toolName' AS tool, elem->'output' AS o
  FROM ai_chat_messages m, jsonb_array_elements(m.tool_calls) elem
  WHERE (m.metadata->>'toolTraceVersion') IS NULL
    AND jsonb_typeof(m.tool_calls) = 'array' AND elem ? 'output'
)
SELECT tool, count(*) AS calls,
       sum(COALESCE(
         (o->>'isError') = 'true'
         OR (o->>'success') = 'false'
         OR (jsonb_typeof(o->'failed') = 'array' AND o->'failed' <> '[]'::jsonb)
         OR (o->>'unavailable') = 'true'
         OR o::text ~* 'error executing tool|validation error'
       , false)::int) AS soft_errors
FROM res GROUP BY tool HAVING sum(COALESCE(
         (o->>'isError') = 'true' OR (o->>'success') = 'false'
         OR (jsonb_typeof(o->'failed') = 'array' AND o->'failed' <> '[]'::jsonb)
         OR (o->>'unavailable') = 'true' OR o::text ~* 'error executing tool|validation error'
       , false)::int) > 0
ORDER BY soft_errors DESC;
```

Note the v2 `tool` label is the part type (`tool-editPageText`); strip the `tool-`
prefix if you join it against the legacy `toolName`.

**`editPageText` failure reasons** (the most common real agent mistake — bad `find`).
Same dual-shape output source:

```sql
WITH res AS (
  SELECT part->'output' AS o
  FROM ai_chat_messages m, jsonb_array_elements(m.metadata->'parts') part
  WHERE (m.metadata->>'toolTraceVersion') = '2'
    AND part->>'type' = 'tool-editPageText' AND part->>'state' = 'output-available'
  UNION ALL
  SELECT elem->'output' AS o
  FROM ai_chat_messages m, jsonb_array_elements(m.tool_calls) elem
  WHERE (m.metadata->>'toolTraceVersion') IS NULL
    AND jsonb_typeof(m.tool_calls) = 'array'
    AND elem->>'toolName' = 'editPageText' AND elem ? 'output'
)
SELECT f->>'reason' AS reason, count(*)
FROM res, jsonb_array_elements(o->'failed') f
WHERE jsonb_typeof(o->'failed') = 'array'
GROUP BY 1 ORDER BY 2 DESC;
```

**Hard errors — persisted `error` field per tool (v2 + post-#407 rows)** — thrown tool
failures carry their real reason, so query them directly. On **v2** rows exclude the
`interrupted` kind so an aborted call is not counted as a hard-fail:

```sql
SELECT elem->>'toolName' AS tool, count(*) AS thrown_errors,
       min(elem->>'error') AS sample_error
FROM ai_chat_messages m, jsonb_array_elements(m.tool_calls) elem
WHERE jsonb_typeof(m.tool_calls) = 'array' AND elem ? 'error'
  -- v2 rows label the kind; a legacy error element has no kind (count it).
  AND COALESCE(elem->>'kind', 'thrown') = 'thrown'
GROUP BY 1 ORDER BY 2 DESC;
```

Aborted mid-step calls on v2 rows are a distinct, directly countable population:

```sql
SELECT elem->>'toolName' AS tool, count(*) AS interrupted
FROM ai_chat_messages m, jsonb_array_elements(m.tool_calls) elem
WHERE jsonb_typeof(m.tool_calls) = 'array' AND elem->>'kind' = 'interrupted'
GROUP BY 1 ORDER BY 2 DESC;
```

**Hard-error proxy for OLD rows (pre-#407) — orphan gap per tool, WITH a spread column**
(call parts minus outcome parts, plus how many distinct chats the gap is spread across).
This is needed ONLY for pre-#407 legacy rows (v2 and post-#407 rows carry the error /
`kind` directly — use the queries above). The `WHERE` restricts to the legacy era so v2
rows (where an `ok` outcome is not an `output`) never produce phantom orphans:

```sql
WITH parts AS (
  SELECT m.chat_id, elem->>'toolName' AS tool,
         (elem ? 'input' AND NOT (elem ? 'output') AND NOT (elem ? 'ok')) AS is_call,
         (elem ? 'output' OR elem ? 'error' OR elem ? 'ok')               AS is_result
  FROM ai_chat_messages m, jsonb_array_elements(m.tool_calls) elem
  WHERE jsonb_typeof(m.tool_calls) = 'array' AND m.role = 'assistant'
    AND (m.metadata->>'toolTraceVersion') IS NULL
),
per_chat AS (
  SELECT tool, chat_id, sum(is_call::int) - sum(is_result::int) AS gap
  FROM parts GROUP BY tool, chat_id
)
SELECT tool,
       sum(gap) FILTER (WHERE gap > 0)   AS missing_results,
       count(*) FILTER (WHERE gap > 0)   AS chats_spread,   -- disambiguates!
       max(gap)                          AS worst_single_chat
FROM per_chat GROUP BY tool
HAVING sum(gap) FILTER (WHERE gap > 0) > 0
ORDER BY missing_results DESC;
```

The `is_result` predicate counts an `error` element as a paired result too, so on new
rows a persisted thrown error no longer inflates the orphan gap; a remaining gap is an
aborted/interrupted call.

**On OLD rows, `missing_results` mixes thrown errors AND aborted/interrupted runs — you
cannot split them from `output` alone** (a positional "what follows the orphan" heuristic
breaks on parallel tool batches, which persist as `call,call,…,result,result`). Use
`chats_spread` to disambiguate:

- **spread across many chats** (e.g. `createComment` 96 over 29 chats) → a **systemic
  real error** (here: inline-comment anchor text not found on the page).
- **concentrated in one chat** (e.g. `searchInPage` 55, of which 51 in a single chat)
  → **one runaway/aborted session**, not a real per-call error — discount it.
- a gap on a **structural editor** (`patchNode`, `insertNode`, `tableUpdateCell`,
  `updatePageJson`, `transformPage`) is almost always a thrown Yjs-encode error.

**Run-level failures:**

```sql
SELECT status, count(*), min(error) AS sample_error
FROM ai_chat_runs GROUP BY status ORDER BY 2 DESC;
```

**Full-text search across messages.** The `tsv` GIN index is built as
`to_tsvector('english', unaccent(content))` — so it **stems English** but **not
Russian** (Russian lexemes are stored unstemmed, so only exact word forms match).
Most content here is Russian, so prefer `ILIKE` for substring search:

```sql
-- Russian / substring — reliable:
SELECT chat_id, left(content, 120)
FROM ai_chat_messages WHERE content ILIKE '%иранск%' LIMIT 20;

-- English phrase — can use the index:
SELECT chat_id, left(content, 120)
FROM ai_chat_messages
WHERE tsv @@ websearch_to_tsquery('english', 'some phrase') LIMIT 20;
```

## Don't blow up your context

Tool outputs embed full page content and search payloads (hundreds of KB per row).
On **legacy** rows they are in `tool_calls`; on **v2** rows they moved to
`metadata->'parts'` (the `tool_calls` trace itself is now small). Never `SELECT
tool_calls` / `metadata` (or `jsonb_pretty(...)`) raw — project just the keys you need
and truncate:

```sql
-- v2: outputs live in metadata.parts
SELECT part->>'type',
       left(regexp_replace((part->'output')::text, '\s+', ' ', 'g'), 200)
FROM ai_chat_messages m, jsonb_array_elements(m.metadata->'parts') part
WHERE (m.metadata->>'toolTraceVersion') = '2'
  AND part->>'state' = 'output-available' LIMIT 5;

-- legacy: outputs live in tool_calls
SELECT elem->>'toolName',
       left(regexp_replace((elem->'output')::text, '\s+', ' ', 'g'), 200)
FROM ai_chat_messages m, jsonb_array_elements(m.tool_calls) elem
WHERE elem ? 'output' LIMIT 5;
```

## Server logs & live UI (for the error text the DB drops)

```bash
docker logs -f --tail=100 gitmost            # main app
docker compose -p gitmost logs -f --tail=100 # whole stack
```

Logging is `json-file`, `max-size=10m max-file=5` → ~50 MB retained, then rotated,
and **wiped on container recreate**. Thrown-tool error text is **persisted** — in the
`error` field of `tool_calls` (v2 `kind:'thrown'` / post-#407 legacy) — so you no longer
depend on live logs for it. Logs/live UI remain useful for **pre-#407 rows** (whose
thrown errors were dropped) and for full stack traces beyond the truncated stored
message. A per-tool `tool_calls_total{tool,status}` metric to VictoriaMetrics is still a
possible future add for aggregate dashboards.

## Gotchas checklist

- [ ] **Check `metadata.toolTraceVersion` first.** v2 (`= 2`) has no output in `tool_calls`; legacy has it inline. Never trend a metric across the era boundary.
- [ ] Counting every `tool_calls` element → **overcount**. Count OUTCOME elements — v2: `ok` or `error`; legacy: `output` or `error` — never both call+outcome as invocations.
- [ ] `isError` / `success=false` ≈ 0 does **not** mean "no errors" — thrown errors are an `error` element (v2 `kind:'thrown'` / post-#407), not in the output.
- [ ] **v2:** soft-error markers (the tool output) are in `metadata.parts`, NOT `tool_calls`. Legacy: they are in the `tool_calls` outcome `output`.
- [ ] **v2:** `kind` splits a real hard-fail (`thrown`) from an aborted call (`interrupted`) directly — no orphan heuristic needed. The orphan gap is a pre-#407-legacy-only proxy.
- [ ] `editPageText.failed` is `[]` on success — test for **non-empty**, not presence.
- [ ] `aborted` runs = server restarts, `failed` runs = provider overload — not agent mistakes.
- [ ] Never dump a raw `tool_calls` **or** `metadata.parts` cell — outputs are hundreds of KB.
- [ ] Logs are ephemeral (≤50 MB, wiped on recreate) — grab pre-#407 hard-error text live.

## Snapshot (2026-07-07, illustrative — rerun the queries for current numbers)

> All rows in this snapshot predate #490, so they are **legacy-era** (outputs inline in
> `tool_calls`, orphan proxy for thrown errors). Do not trend these numbers against v2
> rows — segment by `toolTraceVersion` first.


- 226 chats, 732 messages, 46 runs; ~4 400 real tool invocations.
- Soft errors (persisted): `editPageText` 4/79 (bad/non-unique `find`) + 9 markdown-in-`find` warnings; `semanticSearch` 3/4 (`unavailable`); `Habr_update_draft_from_docmost` 1/2 (`doc` sent as object, not string).
- Missing-result proxy, read WITH the spread column:
  - **Systemic (spread) → real errors:** `createComment` 96 over **29 chats** (comment anchor text not found — the biggest real error hotspot); `editPageText` 31 over 12 chats (+ the 4 soft above); structural-editor Yjs throws `insertNode` 10 / `updatePageContent` 9 / `tableUpdateCell` 6 / `patchNode` 5 / `updatePageJson` 2 / `transformPage` 2.
  - **Concentrated → NOT real errors:** `searchInPage` 55 (51 in one chat); `Search_web_search` 15 & `Search_searxng_web_search` 6 (timeouts/aborts in long research sessions).
- Runs: 34 succeeded, 10 aborted (server restart), 1 failed (provider overload).
