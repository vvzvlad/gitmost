import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SearchDTO, SearchSuggestionDTO } from './dto/search.dto';
import {
  SearchResponseDto,
  SearchResultDto,
  SearchSemanticDto,
} from './dto/search-response.dto';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { RawBuilder, sql } from 'kysely';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { ShareRepo } from '@docmost/db/repos/share/share.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { PageEmbeddingRepo } from '@docmost/db/repos/ai-chat/page-embedding.repo';
import { ShareService } from '../share/share.service';
// Every semantic read goes through EmbeddingGenerationService, which embeds the
// query with the CURRENT
// provider but reports the ACTIVE generation's fingerprint to filter rows by.
import { EmbeddingGenerationService } from '../../integrations/ai/embedding-generation.service';
import { AiEmbeddingNotConfiguredException } from '../../integrations/ai/ai-embedding-not-configured.exception';
import { isStatementTimeout } from '@docmost/db/utils';
import {
  ParsedQuery,
  ParsedTerm,
  parseSearchQuery,
  SearchBooleanMode,
  SearchMatchMode,
  hasPositiveRecall,
} from './search-query-parser';

// The FTS text-search configuration used on BOTH the stored side (pages.tsv via
// its trigger, see migration 20260707T130000) and the query side here. #529
// acceptance #13 invariant: column config and query config always change as a
// pair — flip this only alongside the migration.
const TS_CONFIG = 'ru_en';

// RRF constant (Cormack et al. 2009; the Elasticsearch/OpenSearch default). RRF
// fuses RANKS (not raw scores) so the incomparable ts_rank_cd (lexical) and the
// substring tier scales never need normalizing — that is the whole point.
const RRF_K = 60;

// Escape the LIKE metacharacters (`%`, `_`, `\`) so every character is matched
// LITERALLY by a `col LIKE '%' || q || '%'` predicate. Without this a query of
// `%` or `_` would match every row.
//
// Escaping is intentionally SYMMETRIC on `%` and `_`, so a bare `%` (or `_`)
// cannot be searched as a literal character: such a query parses to no positive
// recall and returns total:0 rather than matching everything.
export function escapeLikePattern(raw: string): string {
  return (raw ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

// Env-tunable fusion window: the top-N candidates (by RRF) that pagination can
// reach. The tail beyond it is unreachable (truncatedAtCap:true). Default 500.
function getCandidateCap(): number {
  const raw = Number(process.env.SEARCH_CANDIDATE_CAP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 500;
}

// Global AND/OR toggle: SEARCH_MODE overrides the request `mode` default. Both
// are valid on the ru_en tsv — this is a parser toggle, NOT a config rollback.
function defaultBooleanMode(): SearchBooleanMode {
  return process.env.SEARCH_MODE === 'and' ? 'and' : 'or';
}

// #530 semantic env knobs. SEARCH_SEMANTIC=off is the kill-switch (hybrid is
// otherwise transparent — no per-request mode flag). SEARCH_VECTOR_WEIGHT tunes
// the vector RRF leg's contribution (default 1.0, i.e. equal to each lexical
// leg). SEARCH_VECTOR_CANDIDATES caps the vector top-N pulled into the union.
function semanticKillSwitchOff(): boolean {
  return process.env.SEARCH_SEMANTIC === 'off';
}
function getVectorWeight(): number {
  const raw = Number(process.env.SEARCH_VECTOR_WEIGHT);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1.0;
}
function getVectorCandidates(): number {
  const raw = Number(process.env.SEARCH_VECTOR_CANDIDATES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 50;
}
// Safety net for the brute-force vector scan (no ANN index — see
// vectorCandidateArm): a per-statement timeout bounding ONLY the fused vector
// query, so a pathological seq scan is cancelled (SQLSTATE 57014) and search
// degrades to lexical instead of hanging the request. Default 2000ms.
function getVectorStatementTimeoutMs(): number {
  const raw = Number(process.env.SEARCH_VECTOR_STATEMENT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2000;
}

// #701: the most vector-only neighbours returned as `related` (first page only).
const RELATED_LIMIT = 5;

// Why an approved-mode share has no search: it publishes only the last saved
// (manual) version, while the index (title, text, embeddings) holds the live
// draft — searching it would leak the unpublished draft to anonymous readers.
export const SHARE_SEARCH_DISABLED_APPROVED =
  'Search is unavailable on this share because it publishes only saved versions.';

/**
 * Who is searching. There are exactly two kinds of caller:
 *  - an authenticated user: `userId` is REQUIRED — the scope is an explicit
 *    space (its Read right checked by the caller) or the user's member spaces,
 *    and the page-permission filter always runs; `shareId` is ignored;
 *  - the anonymous public-share reader: the scope is ONE share tree and nothing
 *    else — `spaceId` is ignored, no page outside the share is ever looked up.
 */
export type SearchCaller =
  | { userId: string; workspaceId: string }
  | { anonymousShare: true; workspaceId: string };

type SearchScope =
  | { kind: 'none' }
  | { kind: 'disabled'; reason: string }
  | { kind: 'spaces'; spaceIds: string[]; workspaceId: string }
  | {
      kind: 'ids';
      pageIds: string[];
      workspaceId: string;
      // The share root: `path` is cut there, never showing a title above it.
      rootPageId: string;
    };

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private pageRepo: PageRepo,
    private shareRepo: ShareRepo,
    private spaceMemberRepo: SpaceMemberRepo,
    private pagePermissionRepo: PagePermissionRepo,
    private pageEmbeddingRepo: PageEmbeddingRepo,
    // #599: the embedding fingerprint lifecycle — resolves the ACTIVE generation
    // the vector arm must filter by (NOT the live config's, which is the target of
    // an in-flight reindex) and reports its coverage for `semantic.state`.
    private embeddingGeneration: EmbeddingGenerationService,
    // Share search honours the workspace/space "sharing disabled" settings
    // exactly like the share page itself (isSharingAllowed).
    private shareService: ShareService,
  ) {}

  // === #529 SQL fragment builders (parameterized AST, never string-concat) =====

  // to_tsquery for a single FTS term. The term's own (already metachar-stripped)
  // words are joined with `&` and given a `:*` suffix for the prefix branch. The
  // whole lexeme string is a BOUND parameter to to_tsquery — no user operator can
  // reach the parser.
  private ftsTermTsq(
    term: ParsedTerm,
    config = TS_CONFIG,
  ): RawBuilder<unknown> {
    const words = term.text.split(/\s+/).filter(Boolean);
    const suffix = term.branch === 'ftsPrefix' ? ':*' : '';
    const lexeme = words.map((w) => w + suffix).join(' & ');
    return sql`to_tsquery(${config}, f_unaccent(${lexeme}))`;
  }

  private phraseTermTsq(term: ParsedTerm): RawBuilder<unknown> {
    return sql`phraseto_tsquery(${TS_CONFIG}, f_unaccent(${term.text}))`;
  }

  private termTsq(term: ParsedTerm): RawBuilder<unknown> {
    return term.branch === 'phrase'
      ? this.phraseTermTsq(term)
      : this.ftsTermTsq(term);
  }

  // Fold FTS/phrase term tsqueries into ONE tsquery via the SQL `||` operator
  // (AND via `&&` when mode is 'and'). Returns null when there are no such terms.
  private combineTsq(
    terms: ParsedTerm[],
    mode: SearchBooleanMode,
  ): RawBuilder<unknown> | null {
    const ftsTerms = terms.filter((t) => t.branch !== 'substring');
    if (ftsTerms.length === 0) return null;
    const op = mode === 'and' ? sql`&&` : sql`||`;
    let acc: RawBuilder<unknown> = sql`(${this.termTsq(ftsTerms[0])})`;
    for (let i = 1; i < ftsTerms.length; i++) {
      acc = sql`(${acc}) ${op} (${this.termTsq(ftsTerms[i])})`;
    }
    return acc;
  }

  // A LIKE '%needle%' pattern in the LOWER(f_unaccent(...)) space. Coalesce-free
  // so it can use the trigram GIN indexes (a coalesce wrapper would force a seq
  // scan). NULL title/text simply doesn't match, exactly as '' wouldn't.
  private likePattern(term: ParsedTerm): RawBuilder<unknown> {
    const body = '%' + escapeLikePattern(term.text) + '%';
    return sql`LOWER(f_unaccent(${body}))`;
  }

  private substringPred(
    term: ParsedTerm,
    titleOnly: boolean,
  ): RawBuilder<unknown> {
    const pat = this.likePattern(term);
    const title = sql`LOWER(f_unaccent(pages.title)) LIKE ${pat} ESCAPE '\\'`;
    if (titleOnly) return sql`(${title})`;
    const text = sql`LOWER(f_unaccent(pages.text_content)) LIKE ${pat} ESCAPE '\\'`;
    return sql`(${title} OR ${text})`;
  }

  // Whole-candidate match predicate for a single term (required / excluded
  // predicates, and per-hit matchedTerms).
  private termMatchPred(
    term: ParsedTerm,
    titleOnly: boolean,
  ): RawBuilder<unknown> {
    if (term.branch === 'substring') return this.substringPred(term, titleOnly);
    return sql`(pages.tsv @@ ${this.termTsq(term)})`;
  }

  // The positive RECALL predicate: OR (or AND, per mode) of every positive term's
  // match — the FTS terms via one combined tsquery, the substring terms via LIKE.
  private positiveRecall(
    parsed: ParsedQuery,
    titleOnly: boolean,
  ): RawBuilder<unknown> {
    const parts: RawBuilder<unknown>[] = [];
    const tsq = this.combineTsq(parsed.positive, parsed.mode);
    if (tsq) parts.push(sql`(pages.tsv @@ (${tsq}))`);
    for (const t of parsed.positive.filter((x) => x.branch === 'substring')) {
      parts.push(this.substringPred(t, titleOnly));
    }
    if (parts.length === 0) return sql`false`;
    const op = parsed.mode === 'and' ? sql` AND ` : sql` OR `;
    return sql`(${sql.join(parts, op)})`;
  }

  // The full candidate WHERE: positive recall AND every required AND none of the
  // excluded. Required terms with no positive term ARE the recall (A2).
  private candidatePredicate(
    parsed: ParsedQuery,
    titleOnly: boolean,
  ): RawBuilder<unknown> {
    const preds: RawBuilder<unknown>[] = [];
    if (parsed.positive.length > 0) {
      preds.push(this.positiveRecall(parsed, titleOnly));
    }
    for (const t of parsed.required) {
      preds.push(this.termMatchPred(t, titleOnly));
    }
    for (const t of parsed.excluded) {
      preds.push(sql`NOT ${this.termMatchPred(t, titleOnly)}`);
    }
    if (preds.length === 0) return sql`false`;
    return sql`(${sql.join(preds, sql` AND `)})`;
  }

  // ts_rank_cd over the positive FTS tsquery. NULL when the query has no FTS
  // positive term (pure-substring query) — the row is then absent from the FTS
  // RRF branch.
  private ftsScoreExpr(parsed: ParsedQuery): RawBuilder<unknown> {
    const tsq = this.combineTsq(parsed.positive, parsed.mode);
    if (!tsq) return sql`NULL::float`;
    return sql`CASE WHEN pages.tsv @@ (${tsq}) THEN ts_rank_cd(pages.tsv, (${tsq})) ELSE NULL END`;
  }

  // Substring tier (3 title-exact / 2 title-substring / 1 text) or NULL when the
  // row matched no positive substring term. Drives the substring RRF branch.
  private subTierExpr(
    parsed: ParsedQuery,
    titleOnly: boolean,
  ): RawBuilder<unknown> {
    const subTerms = parsed.positive.filter((t) => t.branch === 'substring');
    if (subTerms.length === 0) return sql`NULL::int`;
    const exact: RawBuilder<unknown>[] = [];
    const titleSub: RawBuilder<unknown>[] = [];
    const textSub: RawBuilder<unknown>[] = [];
    for (const t of subTerms) {
      const needle = sql`LOWER(f_unaccent(${t.text}))`;
      const pat = this.likePattern(t);
      exact.push(sql`LOWER(f_unaccent(pages.title)) = ${needle}`);
      titleSub.push(
        sql`LOWER(f_unaccent(pages.title)) LIKE ${pat} ESCAPE '\\'`,
      );
      textSub.push(
        sql`LOWER(f_unaccent(pages.text_content)) LIKE ${pat} ESCAPE '\\'`,
      );
    }
    const exactOr = sql`(${sql.join(exact, sql` OR `)})`;
    const titleOr = sql`(${sql.join(titleSub, sql` OR `)})`;
    const textOr = titleOnly
      ? sql`false`
      : sql`(${sql.join(textSub, sql` OR `)})`;
    return sql`CASE WHEN ${exactOr} THEN 3 WHEN ${titleOr} THEN 2 WHEN ${textOr} THEN 1 ELSE NULL END`;
  }

  // === Main entry (A6 unified path) ==========================================

  async searchPage(
    searchParams: SearchDTO,
    caller: SearchCaller,
  ): Promise<SearchResponseDto> {
    const anonymous = 'anonymousShare' in caller && caller.anonymousShare;
    // Fail closed: a non-anonymous search without a user would run with no
    // membership scope and no page-permission filter.
    const userId = anonymous ? null : (caller as { userId: string }).userId;
    if (!anonymous && !userId) {
      throw new Error(
        'searchPage: an authenticated search requires a userId (anonymous search is share-scoped only)',
      );
    }
    const workspaceId = caller.workspaceId;
    const rawQuery = (searchParams.query ?? '').trim();
    const mode = defaultBooleanMode();
    const match = (searchParams.match as SearchMatchMode) ?? 'auto';
    const parsed = parseSearchQuery(rawQuery, { match, mode });
    const titleOnly = Boolean(searchParams.titleOnly);
    const limit = Math.min(Math.max(searchParams.limit || 25, 1), 100);
    const offset = Math.max(searchParams.offset || 0, 0);
    const cap = getCandidateCap();

    const queryMeta = {
      raw: parsed.raw,
      parsed: {
        positive: parsed.positive.map((t) => t.text),
        required: parsed.required.map((t) => t.text),
        excluded: parsed.excluded.map((t) => t.text),
        reason: parsed.reason,
      },
      mode: parsed.mode,
      match,
    };

    const empty = (reason?: string): SearchResponseDto => ({
      items: [],
      related: [],
      total: 0,
      hasMore: false,
      truncatedAtCap: false,
      offset,
      query: reason
        ? { ...queryMeta, parsed: { ...queryMeta.parsed, reason } }
        : queryMeta,
    });

    // Only-negation / empty query: never run an expensive NOT-only scan (A2).
    if (!hasPositiveRecall(parsed)) {
      return empty(parsed.reason);
    }

    // --- Resolve scope (A6). --------------------------------------------------
    const scope = await this.resolveScope(searchParams, workspaceId, userId);
    if (scope.kind === 'none') return empty();
    if (scope.kind === 'disabled') {
      return { ...empty(), disabledReason: scope.reason };
    }

    // --- Optional parentPageId subtree scope. ---------------------------------
    let descendantIds: string[] | null = null;
    if (searchParams.parentPageId) {
      // Share scope: the subtree root must be a page of the share. An arbitrary
      // id is never looked up — that was a page-existence oracle across the
      // workspace (and a 500 on a non-uuid id) for anonymous readers.
      if (
        scope.kind === 'ids' &&
        !scope.pageIds.includes(searchParams.parentPageId)
      ) {
        return empty();
      }
      const descendants = await this.pageRepo.getPageAndDescendants(
        searchParams.parentPageId,
        { includeContent: false },
      );
      descendantIds = descendants.map((p: any) => p.id);
      if (descendantIds.length === 0) return empty();
    }

    // --- Build the shared candidate WHERE fragment. ---------------------------
    const scopePreds: RawBuilder<unknown>[] = [sql`pages.deleted_at IS NULL`];
    if (scope.kind === 'spaces') {
      scopePreds.push(
        sql`pages.space_id = ANY(${scope.spaceIds}::uuid[])`,
        sql`pages.workspace_id = ${scope.workspaceId}`,
      );
    } else {
      // share: an explicit (already permission-filtered) id set.
      scopePreds.push(
        sql`pages.id = ANY(${scope.pageIds}::uuid[])`,
        sql`pages.workspace_id = ${scope.workspaceId}`,
      );
    }
    if (searchParams.creatorId) {
      scopePreds.push(sql`pages.creator_id = ${searchParams.creatorId}`);
    }
    if (searchParams.labelId && !anonymous) {
      scopePreds.push(sql`EXISTS (
        SELECT 1 FROM page_labels
        WHERE page_labels.page_id = pages.id
          AND page_labels.label_id = ${searchParams.labelId}::uuid
      )`);
    }
    if (descendantIds) {
      scopePreds.push(sql`pages.id = ANY(${descendantIds}::uuid[])`);
    }
    const scopeSql = sql`(${sql.join(scopePreds, sql` AND `)})`;
    const candidateSql = sql`(${scopeSql} AND ${this.candidatePredicate(parsed, titleOnly)})`;

    // --- Semantic (vector) arm: embed the query, degrade gracefully. (#530) ----
    // The try/catch wraps ONLY embedQuery + vector-arm construction. On ANY throw
    // (TEI down / 800ms timeout / no provider) we omit the vector arm entirely and
    // run the byte-identical Phase-A lexical path — never a 500 from the sidecar.
    // The permission filter below stays OUTSIDE this try (a permission error must
    // 500, never fail-open). Hybrid is transparent; SEARCH_SEMANTIC=off disables it.
    let vectorArm: RawBuilder<unknown> | null = null;
    let semanticAvailable = false;
    let semanticReason: 'no-provider' | 'degraded' | 'stale' | undefined;
    // #599 coverage of the ACTIVE generation + whether a swap is in flight; both
    // drive `semantic.state` below. Undefined while the arm has not run.
    let semanticCoverage: { indexed: number; total: number } | undefined;
    let semanticStale = false;
    // #599 (D2): the served generation was produced by a DIFFERENT model than the
    // one embedding this query -> the vector arm is not raised at all, and the
    // response reports `state: 'stale', available: false` (not 'off': a provider IS
    // configured and the semantics are merely out of date pending a reindex).
    let semanticModelChanged = false;
    if (!semanticKillSwitchOff()) {
      try {
        // #599: embed with the CURRENT provider but filter by the ACTIVE
        // fingerprint — during a target reindex those differ, and serving the old
        // generation is what keeps semantic recall alive across the swap window
        // (see EmbeddingGenerationService.embedQueryForActiveGeneration).
        const { vector, fingerprint, generation } =
          await this.embeddingGeneration.embedQueryForActiveGeneration(
            workspaceId,
            rawQuery,
          );

        // The MODEL of the served generation changed under us. The rows
        // of the active generation and this query vector belong to two independently
        // trained embedding spaces: their cosine is noise (the spaces are related by
        // an arbitrary rotation), and RRF would inject those arbitrarily ranked pages
        // into the top, DISPLACING valid lexical hits. That is strictly worse than
        // having no vector arm at all, so we drop the arm and serve pure lexical
        // until the target reindex completes and the pointer flips onto rows from
        // this model. A dimension change would already be filtered out by the arm's
        // `model_dimensions = queryDim` predicate (0 rows -> clean degrade); this
        // covers the SAME-dimension model swap (e5-base -> bge-base, both 768), which
        // that filter cannot see.
        if (generation.modelChanged) {
          semanticModelChanged = true;
          semanticStale = true;
          semanticReason = 'stale';
          this.logger.warn(
            `search.semantic.model-changed workspace=${workspaceId} ` +
              `active_model=${generation.activeModel ?? 'unknown'} ` +
              `config_model=${generation.targetModel} (vector arm disabled: the served ` +
              `generation lives in a different embedding space; lexical only until the ` +
              `reindex completes)`,
          );
        } else {
          vectorArm = this.pageEmbeddingRepo.vectorCandidateArm({
            queryEmbedding: vector,
            dimensions: vector.length,
            fingerprint,
            scope: scopeSql,
            limit: getVectorCandidates(),
            // Filter page_embeddings by (immutable) workspace_id directly, so the
            // composite index bites on its leading column and candidates are
            // workspace-scoped at the embedding level. Space scoping stays on the
            // pages join only — page_embeddings.space_id can be STALE after a
            // cross-space move, so filtering it here would drop a moved page's
            // vector hit.
            workspaceId: scope.workspaceId,
          });
          semanticAvailable = true;

          // Coverage of the generation we just filtered by. A swap in flight is
          // ALWAYS stale — the active generation may well be 100% covered (it is
          // the OLD one), but the workspace's semantics no longer reflect the
          // configured model until the reindex completes and the pointer flips.
          // Coverage is TTL-cached, so this does not add a scan per keystroke.
          //
          // Its OWN try/catch: coverage is a cosmetic indicator, and a failed count
          // must never demote a working vector arm to `degraded` — we keep the arm
          // and simply report the state without the numbers (a swap in flight is
          // still reported stale, that fact needs no DB count).
          //
          // When the COUNT fails, coverage is UNKNOWN, and the DTO defines `full`
          // as "the active generation covers every page" — so unknown coverage
          // reports `stale` (numbers omitted): a legacy workspace with 0 indexed
          // pages must not report `full` because of a failed COUNT.
          semanticStale = generation.swapping;
          try {
            const coverage = await this.embeddingGeneration.getCoverage(
              workspaceId,
              generation.active,
            );
            semanticCoverage = {
              indexed: coverage.indexed,
              total: coverage.total,
            };
            semanticStale = semanticStale || coverage.state === 'stale';
          } catch {
            semanticStale = true;
            this.logger.debug(
              `search.semantic.coverage-unavailable workspace=${workspaceId} ` +
                `(coverage unknown -> reporting state=stale)`,
            );
          }
        }
      } catch (err) {
        if (err instanceof AiEmbeddingNotConfiguredException) {
          // No embedding provider is the DEFAULT state of any deployment without
          // the TEI sidecar — normal, not a problem. Log at DEBUG so it never
          // floods WARN once per search request.
          semanticReason = 'no-provider';
          this.logger.debug(
            `search.semantic.no-provider workspace=${workspaceId}`,
          );
        } else {
          // A provider IS configured but the embed call failed/timed out — a real
          // sidecar problem worth a WARN. Structured, greppable event (fixed code)
          // — no query text/secrets.
          semanticReason = 'degraded';
          this.logger.warn(
            `search.semantic.degraded reason=degraded workspace=${workspaceId}`,
          );
        }
      }
    }
    // --- Ranked candidate ids (ALL candidates, RRF order). --------------------
    // Lexical branches ranked SEPARATELY (FTS by ts_rank_cd, substring by tier);
    // when a query vector is available a third VECTOR branch is fused over the
    // UNION of lexical + vector candidates. RRF: score = Σ w/(k + rank_branch).
    // Deterministic ORDER BY rrf DESC, id so pagination never dupes/skips (A4).
    // Each id carries `lexical` — whether the page actually matches the query.
    // Only those are matches (`items`/`total`); the vector arm re-ranks them via
    // RRF, while vector-only neighbours go to `related` and are never counted. On
    // degrade the query is the plain lexical one.
    //
    // The fused query is bounded by a per-statement timeout (see runRankedQuery):
    // if the brute-force vector scan is cancelled (SQLSTATE 57014) we degrade to
    // the byte-identical lexical path — search returns lexical results, never
    // hangs, never 500s. Only the timeout is caught here; any OTHER SQL error
    // propagates. The permission filter below stays outside, unchanged.
    let orderedIds: { id: string; lexical: boolean }[];
    try {
      orderedIds = await this.runRankedQuery(
        candidateSql,
        parsed,
        titleOnly,
        vectorArm,
      );
    } catch (err) {
      if (vectorArm && isStatementTimeout(err)) {
        semanticAvailable = false;
        semanticReason = 'degraded';
        // The arm did not contribute -> its coverage numbers describe nothing that
        // ran; drop them so the response cannot be read as "semantics worked".
        semanticCoverage = undefined;
        semanticStale = false;
        this.logger.warn(
          `search.semantic.degraded reason=degraded workspace=${workspaceId} (vector statement timeout)`,
        );
        // Re-run the exact Phase-A lexical path (no vector arm, no timeout).
        orderedIds = await this.runRankedQuery(
          candidateSql,
          parsed,
          titleOnly,
          null,
        );
      } else {
        throw err;
      }
    }

    // Semantic state:
    //   'off'   — the arm never ran and there is nothing to reindex about it
    //             (kill-switch / no provider / a degrade).
    //   'stale' — either the arm RAN over an incompletely covered generation
    //             (`available: true` — a partially covered generation still returns
    //             real hits), or the arm was deliberately NOT raised because the
    //             served generation's model no longer matches the configured one
    //             (`available: false`, lexical only, a reindex will fix it).
    //   'full'  — the arm ran over a fully covered, same-model generation.
    if (semanticAvailable && semanticStale && !semanticReason) {
      semanticReason = 'stale';
    }
    const semantic: SearchSemanticDto = {
      state: semanticAvailable
        ? semanticStale
          ? 'stale'
          : 'full'
        : semanticModelChanged
          ? 'stale'
          : 'off',
      available: semanticAvailable,
      ...(semanticReason ? { reason: semanticReason } : {}),
      ...(semanticCoverage
        ? { indexed: semanticCoverage.indexed, total: semanticCoverage.total }
        : {}),
    };

    // --- Permission filter (fail-closed, exact total). ------------------------
    // filterAccessiblePageIds runs the #348 hasRestricted pre-check internally:
    // no restricted pages in scope → returns the ids untouched (fast path, total
    // stays trivially exact); otherwise a SQL anti-join drops hidden pages. An
    // error PROPAGATES (500) — it never degrades to an empty lexical result, so
    // hidden-page cardinality never leaks into `total`. The share path is already
    // permission-filtered by getPageAndDescendantsExcludingRestricted; every
    // other search is an authenticated one (userId checked above).
    if (!anonymous && orderedIds.length > 0) {
      const accessible = await this.pagePermissionRepo.filterAccessiblePageIds({
        pageIds: orderedIds.map((r) => r.id),
        userId,
        spaceId: searchParams.spaceId,
        workspaceId,
      });
      const accessibleSet = new Set(accessible);
      orderedIds = orderedIds.filter((r) => accessibleSet.has(r.id));
    }

    // #701 — split the permitted ids: lexical matches vs vector-only neighbours.
    // Both keep RRF order; for the neighbours that equals vec_distance order.
    const matchIds = orderedIds.filter((r) => r.lexical).map((r) => r.id);
    const relatedIds = orderedIds.filter((r) => !r.lexical).map((r) => r.id);

    // W1 — CANDIDATE_CAP bounds pagination REACHABILITY (JS-side), NOT query
    // compute. The `ranked` CTE deliberately has no SQL LIMIT: an exact `total`
    // requires counting EVERY match, and the permission anti-join must run over
    // the full match set, so a SQL LIMIT would corrupt `total`. The consequence
    // is that a broad common term in a tenant with restricted pages sorts +
    // anti-joins the whole match set on every request; the cap only truncates the
    // reachable window afterwards (rows past it are unreachable → truncatedAtCap).
    // Accepted for the small-tenant fork target — do NOT convert `cap` into a SQL
    // LIMIT thinking it bounds compute; it does not, and doing so breaks the exact
    // total contract. `total` counts the permitted LEXICAL matches only —
    // vector-only neighbours never enter it.
    const total = matchIds.length;
    const truncatedAtCap = total > cap;
    const window = matchIds.slice(0, cap);
    const pageIds = window.slice(offset, offset + limit);
    const hasMore = offset + pageIds.length < window.length;
    const relatedPageIds =
      offset === 0 ? relatedIds.slice(0, RELATED_LIMIT) : [];
    // An anonymous share reader never gets the semantic block: its state and
    // coverage counters describe the whole workspace, private spaces included.
    const semanticOut = anonymous ? {} : { semantic };

    if (pageIds.length === 0 && relatedPageIds.length === 0) {
      return {
        items: [],
        related: [],
        total,
        hasMore,
        truncatedAtCap,
        offset,
        query: queryMeta,
        ...semanticOut,
      };
    }

    // --- Detail fetch for the page slice + the related neighbours only
    //     (ts_headline/snippet are costly, so compute them ONLY for the returned
    //     rows) in one call, preserving RRF order, then split. ---------------
    const details = await this.fetchDetails(
      [...pageIds, ...relatedPageIds],
      parsed,
      titleOnly,
      scope.kind === 'ids' ? scope.rootPageId : null,
      anonymous,
    );
    const pageIdSet = new Set(pageIds);
    const items = details.filter((d) => pageIdSet.has(d.id));
    const related = details.filter((d) => !pageIdSet.has(d.id));

    return {
      items,
      related,
      total,
      hasMore,
      truncatedAtCap,
      offset,
      query: queryMeta,
      ...semanticOut,
    };
  }

  /**
   * Run the ranked-candidate-ids query and return the ids in RRF order,
   * each flagged `lexical` when the page actually matches the query.
   *
   * When `vectorArm` is null (degrade / semantic off / no query vector) this runs
   * the plain 2-branch lexical query — the semantic layer must
   * be a pure superset that never changes lexical behaviour on degrade.
   *
   * When a vector arm is supplied it is UNION ALL'd with the lexical arm into one
   * `candidates` set; `agg` collapses each page to its best per-branch signal
   * (MAX fts_score / MAX sub_tier / MIN vec_distance); `ranked` assigns a
   * per-branch row_number; the final ORDER BY fuses the three legs with RRF,
   * adding the vector leg ONLY for rows that have a vec_distance (a lexical-only
   * hit contributes 0 to the vector leg, and vice-versa). W_VEC weights the
   * vector leg. A row is `lexical` when it came from the lexical arm, i.e. passed
   * the match predicate; every row of the lexical-only path is lexical by
   * construction.
   */
  private async runRankedQuery(
    candidateSql: RawBuilder<unknown>,
    parsed: ParsedQuery,
    titleOnly: boolean,
    vectorArm: RawBuilder<unknown> | null,
  ): Promise<{ id: string; lexical: boolean }[]> {
    if (!vectorArm) {
      // Phase-A lexical path — DO NOT change (byte-identical on degrade, #529).
      const rankedRows = await sql<{ id: string }>`
        WITH candidates AS (
          SELECT pages.id AS id,
                 ${this.ftsScoreExpr(parsed)} AS fts_score,
                 ${this.subTierExpr(parsed, titleOnly)} AS sub_tier
          FROM pages
          WHERE ${candidateSql}
        ),
        ranked AS (
          SELECT id, fts_score, sub_tier,
                 row_number() OVER (ORDER BY fts_score DESC NULLS LAST, id) AS rn_fts,
                 row_number() OVER (ORDER BY sub_tier DESC NULLS LAST, id) AS rn_sub
          FROM candidates
        )
        SELECT id
        FROM ranked
        ORDER BY
          (CASE WHEN fts_score IS NOT NULL THEN 1.0/(${RRF_K} + rn_fts) ELSE 0 END)
          + (CASE WHEN sub_tier IS NOT NULL THEN 1.0/(${RRF_K} + rn_sub) ELSE 0 END) DESC,
          id ASC
      `.execute(this.db);
      return rankedRows.rows.map((r) => ({ id: r.id, lexical: true }));
    }

    // #530 fused 3-branch RRF over lexical ∪ vector candidates. The lexical arm
    // adds NULL::float vec_distance to stay UNION-compatible with the vector arm.
    const wVec = getVectorWeight();

    // Bound the brute-force vector scan with a per-statement timeout, scoped to
    // THIS query only. `set_config(..., is_local := true)` = SET LOCAL semantics:
    // it applies within this transaction and auto-resets at COMMIT/ROLLBACK, so
    // it can NEVER leak onto the next query that reuses this pooled connection.
    // On a cancellation the driver raises SQLSTATE 57014, which searchPage catches
    // to degrade to lexical-only. Running inside a transaction also guarantees the
    // SET and the ranked query share one connection.
    const timeoutMs = getVectorStatementTimeoutMs();
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('statement_timeout', ${String(timeoutMs)}, true)`.execute(
        trx,
      );
      const rankedRows = await sql<{ id: string; lexical: boolean }>`
        WITH candidates AS (
          (SELECT pages.id AS id,
                  ${this.ftsScoreExpr(parsed)} AS fts_score,
                  ${this.subTierExpr(parsed, titleOnly)} AS sub_tier,
                  NULL::float AS vec_distance
           FROM pages
           WHERE ${candidateSql})
          UNION ALL
          (${vectorArm})
        ),
        agg AS (
          SELECT id,
                 MAX(fts_score) AS fts_score,
                 MAX(sub_tier) AS sub_tier,
                 MIN(vec_distance) AS vec_distance,
                 -- #701: only the lexical arm emits a NULL vec_distance, so this
                 -- marks pages that passed candidateSql (the real match
                 -- predicate) — including +required-only queries, whose
                 -- fts_score/sub_tier stay NULL because they score positives only.
                 bool_or(vec_distance IS NULL) AS lexical
          FROM candidates
          GROUP BY id
        ),
        ranked AS (
          SELECT id, fts_score, sub_tier, vec_distance, lexical,
                 row_number() OVER (ORDER BY fts_score DESC NULLS LAST, id) AS rn_fts,
                 row_number() OVER (ORDER BY sub_tier DESC NULLS LAST, id) AS rn_sub,
                 row_number() OVER (ORDER BY vec_distance ASC NULLS LAST, id) AS rn_vec
          FROM agg
        )
        SELECT id, lexical
        FROM ranked
        ORDER BY
          (CASE WHEN fts_score IS NOT NULL THEN 1.0/(${RRF_K} + rn_fts) ELSE 0 END)
          + (CASE WHEN sub_tier IS NOT NULL THEN 1.0/(${RRF_K} + rn_sub) ELSE 0 END)
          + (CASE WHEN vec_distance IS NOT NULL THEN ${wVec}::float/(${RRF_K} + rn_vec) ELSE 0 END) DESC,
          id ASC
      `.execute(trx);
      return rankedRows.rows.map((r) => ({ id: r.id, lexical: r.lexical }));
    });
  }

  async searchAttachments(
    params: SearchDTO,
    { userId, workspaceId }: { userId: string; workspaceId: string },
  ) {
    if (!userId || params.parentPageId || params.titleOnly) return [];
    const parsed = parseSearchQuery(params.query.trim(), {
      match: params.match ?? 'auto',
      mode: defaultBooleanMode(),
    });
    if (!hasPositiveRecall(parsed)) return [];

    const scope = await this.resolveScope(params, workspaceId, userId);
    if (scope.kind !== 'spaces') return [];
    const attachmentTerm = (term: ParsedTerm) =>
      term.branch === 'phrase' || term.branch === 'substring'
        ? sql`phraseto_tsquery('simple', f_unaccent(${term.text}))`
        : this.ftsTermTsq(term, 'simple');
    const tsquery = sql`(${sql.join(
      parsed.positive.map(attachmentTerm),
      parsed.mode === 'and' ? sql` && ` : sql` || `,
    )})`;
    const qualifiers = [
      ...parsed.required.map(
        (term) => sql`AND attachments.tsv @@ ${attachmentTerm(term)}`,
      ),
      ...parsed.excluded.map(
        (term) => sql`AND NOT (attachments.tsv @@ ${attachmentTerm(term)})`,
      ),
    ];
    const rows = await sql<{
      id: string;
      fileName: string;
      pageId: string;
      space: { id: string; name: string; slug: string };
      page: { id: string; title: string | null; slugId: string };
    }>`
      SELECT attachments.id,
             attachments.file_name AS "fileName",
             pages.id AS "pageId",
             json_build_object('id', spaces.id, 'name', spaces.name, 'slug', spaces.slug) AS space,
             json_build_object('id', pages.id, 'title', pages.title, 'slugId', pages.slug_id) AS page
        FROM attachments
        JOIN pages ON pages.id = attachments.page_id AND pages.workspace_id = attachments.workspace_id
        JOIN spaces ON spaces.id = pages.space_id AND spaces.workspace_id = pages.workspace_id
       WHERE attachments.workspace_id = ${workspaceId}
         AND attachments.deleted_at IS NULL AND pages.deleted_at IS NULL
         AND pages.space_id = ANY(${scope.spaceIds}::uuid[])
         AND attachments.type = 'file'
         AND attachments.tsv @@ ${tsquery}
         ${sql.join(qualifiers, sql` `)}
         ${params.creatorId ? sql`AND pages.creator_id = ${params.creatorId}` : sql``}
         ${
           params.labelId
             ? sql`AND EXISTS (
           SELECT 1 FROM page_labels WHERE page_labels.page_id = pages.id
            AND page_labels.label_id = ${params.labelId}::uuid
         )`
             : sql``
         }
       ORDER BY ts_rank_cd(attachments.tsv, ${tsquery}) DESC, attachments.id
       LIMIT 250
    `.execute(this.db);
    if (!rows.rows.length) return [];

    const accessible = new Set(
      await this.pagePermissionRepo.filterAccessiblePageIds({
        pageIds: [...new Set(rows.rows.map((row) => row.pageId))],
        userId,
        spaceId: params.spaceId,
        workspaceId,
      }),
    );
    const matched = rows.rows
      .filter((row) => accessible.has(row.pageId))
      .slice(0, 20);
    if (!matched.length) return [];

    const snippets = await this.db
      .selectFrom('attachments')
      .select([
        'id',
        'pageId',
        sql<string>`left(replace(replace(ts_headline('simple', text_content, ${tsquery},
          'StartSel=' || chr(1) || ', StopSel=' || chr(2) || ', MinWords=6, MaxWords=18, MaxFragments=1'),
          chr(1), ''), chr(2), ''), 360)`.as('snippet'),
      ])
      .where(
        'id',
        'in',
        matched.map((row) => row.id),
      )
      .where('deletedAt', 'is', null)
      .execute();
    const snippetById = new Map(snippets.map((item) => [item.id, item]));
    return matched.flatMap((row) => {
      const item = snippetById.get(row.id);
      return item?.pageId === row.pageId
        ? [{ ...row, snippet: item.snippet }]
        : [];
    });
  }

  // Resolve the search scope: for an authenticated caller (`userId` set) an
  // explicit space or the user's member spaces; for the anonymous caller
  // (`userId` null) ONLY a public share's descendant id set (permission-
  // filtered). Returns a small tagged union.
  private async resolveScope(
    searchParams: SearchDTO,
    workspaceId: string,
    userId: string | null,
  ): Promise<SearchScope> {
    if (userId) {
      if (searchParams.spaceId) {
        return {
          kind: 'spaces',
          spaceIds: [searchParams.spaceId],
          workspaceId,
        };
      }
      const spaceIds = await this.spaceMemberRepo.getUserSpaceIds(userId);
      if (spaceIds.length === 0) return { kind: 'none' };
      return { kind: 'spaces', spaceIds, workspaceId };
    }

    if (searchParams.shareId) {
      // The same gate as the share page itself: a missing share, a share of
      // another workspace and a share whose workspace/space has sharing
      // disabled are all the same 404.
      const share = await this.shareRepo.findById(searchParams.shareId);
      if (!share || share.workspaceId !== workspaceId) {
        throw new NotFoundException('Share not found');
      }
      const sharingAllowed = await this.shareService.isSharingAllowed(
        workspaceId,
        share.spaceId,
      );
      if (!sharingAllowed) {
        throw new NotFoundException('Share not found');
      }
      const isRestricted = await this.pagePermissionRepo.hasRestrictedAncestor(
        share.pageId,
      );
      if (isRestricted) return { kind: 'none' };
      if (share.publishedMode === 'approved') {
        return { kind: 'disabled', reason: SHARE_SEARCH_DISABLED_APPROVED };
      }

      const pageIds: string[] = [];
      if (share.includeSubPages) {
        // A6: exclude restricted descendants + honour a restricted ancestor.
        const pageList =
          await this.pageRepo.getPageAndDescendantsExcludingRestricted(
            share.pageId,
            { includeContent: false },
          );
        pageIds.push(...pageList.map((p) => p.id));
      } else {
        pageIds.push(share.pageId);
      }
      if (pageIds.length === 0) return { kind: 'none' };
      return {
        kind: 'ids',
        pageIds,
        workspaceId,
        rootPageId: share.pageId,
      };
    }

    return { kind: 'none' };
  }

  // Fetch the display superset (A7) for the given page ids, in the given order.
  // `pathRootId` (share scope) cuts every `path` at that page. `anonymous` (the
  // share reader) omits `space` and `creatorId` from every item.
  private async fetchDetails(
    pageIds: string[],
    parsed: ParsedQuery,
    titleOnly: boolean,
    pathRootId: string | null,
    anonymous: boolean,
  ): Promise<SearchResultDto[]> {
    // S1: rank/highlight/matchedFields must reflect required terms too, not just
    // bare positives — a required-only query like `+кофейня` (no bare positive)
    // really matches, so it must not report matchedFields:[] / rank:null. Build
    // every detail expression from the SAME [...positive, ...required] set the
    // matchedTerms path uses (`detailTerms` below). Excluded terms stay out (they
    // are anti-matches). The candidate WHERE already enforced required-AND, so
    // OR-combining them here is purely for display scoring/highlighting.
    const detailTerms = [...parsed.positive, ...parsed.required];
    const tsq = this.combineTsq(detailTerms, parsed.mode);
    // rank/highlight are FTS-only (null for substring-only hits — the web already
    // falls back). ts_headline runs over the ORIGINAL text.
    const rankExpr = tsq
      ? sql<number>`CASE WHEN pages.tsv @@ (${tsq}) THEN ts_rank_cd(pages.tsv, (${tsq})) ELSE NULL END`
      : sql<number>`NULL::float`;
    const highlightExpr = tsq
      ? sql<string>`CASE WHEN pages.tsv @@ (${tsq}) THEN ts_headline(${TS_CONFIG}, coalesce(pages.text_content, ''), (${tsq}), 'MinWords=9, MaxWords=10, MaxFragments=3') ELSE NULL END`
      : sql<string>`NULL::text`;

    // Windowed plain snippet: leading window, else the FTS headline (plain).
    const snippetExpr = titleOnly
      ? sql<string>`''`
      : sql<string>`coalesce(
          case
            when coalesce(pages.text_content, '') <> ''
              then substring(LOWER(f_unaccent(pages.text_content)) from 1 for 300)
            ${
              tsq
                ? sql`else ts_headline(${TS_CONFIG}, coalesce(pages.text_content, ''), (${tsq}), 'MinWords=25, MaxWords=40, MaxFragments=3')`
                : sql``
            }
          end, '')`;

    // matchedFields: title / text.
    const titleMatchParts: RawBuilder<unknown>[] = [];
    const textMatchParts: RawBuilder<unknown>[] = [];
    if (tsq) {
      titleMatchParts.push(
        sql`to_tsvector(${TS_CONFIG}, f_unaccent(coalesce(pages.title, ''))) @@ (${tsq})`,
      );
      if (!titleOnly) {
        textMatchParts.push(
          sql`(pages.tsv @@ (${tsq}) AND NOT to_tsvector(${TS_CONFIG}, f_unaccent(coalesce(pages.title, ''))) @@ (${tsq}))`,
        );
      }
    }
    for (const t of detailTerms.filter((x) => x.branch === 'substring')) {
      const pat = this.likePattern(t);
      titleMatchParts.push(
        sql`LOWER(f_unaccent(pages.title)) LIKE ${pat} ESCAPE '\\'`,
      );
      if (!titleOnly) {
        textMatchParts.push(
          sql`LOWER(f_unaccent(pages.text_content)) LIKE ${pat} ESCAPE '\\'`,
        );
      }
    }
    const titleMatchExpr = titleMatchParts.length
      ? sql<boolean>`(${sql.join(titleMatchParts, sql` OR `)})`
      : sql<boolean>`false`;
    const textMatchExpr = textMatchParts.length
      ? sql<boolean>`(${sql.join(textMatchParts, sql` OR `)})`
      : sql<boolean>`false`;

    // Per-term matched flags (positive + required), assembled into matchedTerms.
    // Same set as `detailTerms` above. NB: aliases must be UNDERSCORE-FREE — the
    // app's Kysely runs the CamelCasePlugin, which would rewrite a `t_0` result
    // key to `t0`. `tmatch0` survives the round-trip unchanged.
    const allTerms = detailTerms;
    const termCols = allTerms.map(
      (t, i) =>
        sql`(${this.termMatchPred(t, titleOnly)}) AS "tmatch${sql.raw(String(i))}"`,
    );

    let q = this.db
      .selectFrom('pages')
      .select([
        'pages.id as id',
        'pages.slugId as slugId',
        'pages.title as title',
        'pages.icon as icon',
        'pages.creatorId as creatorId',
        'pages.spaceId as spaceId',
        'pages.createdAt as createdAt',
        'pages.updatedAt as updatedAt',
        rankExpr.as('rank'),
        highlightExpr.as('highlight'),
        snippetExpr.as('snippet'),
        titleMatchExpr.as('titleMatch'),
        textMatchExpr.as('textMatch'),
      ])
      .select((eb) => this.pageRepo.withSpace(eb))
      .where(sql<boolean>`pages.id = ANY(${pageIds}::uuid[])` as any);

    if (termCols.length > 0) {
      q = q.select(termCols as any);
    }

    const rows: any[] = await q.execute();

    const byId = new Map<string, any>(rows.map((r) => [r.id, r]));
    const pathById = await this.buildAncestorPaths(pageIds, pathRootId);

    const items: SearchResultDto[] = [];
    for (const id of pageIds) {
      const r = byId.get(id);
      if (!r) continue;
      const matchedFields: string[] = [];
      if (r.titleMatch) matchedFields.push('title');
      if (r.textMatch) matchedFields.push('text');
      const matchedTerms: string[] = [];
      allTerms.forEach((t, i) => {
        if (r[`tmatch${i}`]) matchedTerms.push(t.text);
      });
      const rank = r.rank == null ? null : Number(r.rank);
      const highlight = r.highlight
        ? String(r.highlight)
            .replace(/\r\n|\r|\n/g, ' ')
            .replace(/\s+/g, ' ')
        : null;
      const snippet = (r.snippet ?? '')
        .replace(/\r\n|\r|\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      items.push({
        id: r.id,
        pageId: r.id,
        slugId: r.slugId,
        icon: r.icon,
        title: r.title,
        ...(anonymous ? {} : { space: r.space, creatorId: r.creatorId }),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        rank,
        highlight,
        snippet,
        path: pathById.get(id) ?? [],
        // A per-response ordering proxy for legacy consumers; falls back to rank.
        score: rank ?? 0,
        matchedFields,
        matchedTerms: Array.from(new Set(matchedTerms)),
      });
    }
    return items;
  }

  /**
   * Batch ancestor-titles helper: ONE recursive CTE seeded with ALL hit ids,
   * walking UP parentPageId. Returns hitId → ancestor titles ordered root →
   * direct parent (the hit's own title excluded).
   *
   * The recursive walk skips soft-deleted ancestors (`deleted_at IS NULL`) and
   * stays within the hit's own space, so a deleted or cross-space ancestor's
   * title never leaks into `path`.
   *
   * `rootPageId` (share scope) stops the walk at the share root: its title is
   * the top of every `path`, and no title above the share ever leaves the
   * server to an anonymous reader.
   */
  private async buildAncestorPaths(
    hitIds: string[],
    rootPageId: string | null,
  ): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (hitIds.length === 0) return result;

    const rows = await this.db
      .withRecursive('ancestry', (db) =>
        db
          .selectFrom('pages')
          .select([
            'pages.id as hitId',
            'pages.id as pageId',
            'pages.title as title',
            'pages.parentPageId as parentPageId',
            'pages.spaceId as spaceId',
            sql<number>`0`.as('depth'),
          ])
          .where('pages.id', 'in', hitIds)
          .where('pages.deletedAt', 'is', null)
          .unionAll((exp) =>
            exp
              .selectFrom('pages as p')
              .innerJoin('ancestry as a', 'p.id', 'a.parentPageId')
              // A8: don't cross into a deleted ancestor or another space.
              .where('p.deletedAt', 'is', null)
              .whereRef('p.spaceId', '=', 'a.spaceId')
              .$if(Boolean(rootPageId), (qb) =>
                qb.where('a.pageId', '!=', rootPageId),
              )
              .select([
                'a.hitId as hitId',
                'p.id as pageId',
                'p.title as title',
                'p.parentPageId as parentPageId',
                'a.spaceId as spaceId',
                sql<number>`a.depth + 1`.as('depth'),
              ]),
          ),
      )
      .selectFrom('ancestry')
      .select(['hitId', 'title', 'depth'])
      .where('depth', '>', 0)
      .orderBy('hitId')
      .orderBy('depth', 'desc')
      .execute();

    for (const r of rows as any[]) {
      const list = result.get(r.hitId) ?? [];
      list.push(r.title);
      result.set(r.hitId, list);
    }
    return result;
  }

  async searchSuggestions(
    suggestion: SearchSuggestionDTO,
    userId: string,
    workspaceId: string,
  ) {
    let users = [];
    let groups = [];
    let pages = [];

    const limit = suggestion?.limit || 10;
    const query = suggestion.query.toLowerCase().trim();

    if (suggestion.includeUsers) {
      const userQuery = this.db
        .selectFrom('users')
        .select(['id', 'name', 'email', 'avatarUrl'])
        .where('workspaceId', '=', workspaceId)
        .where('deletedAt', 'is', null)
        .where((eb) =>
          eb.or([
            eb(
              sql`LOWER(f_unaccent(users.name))`,
              'like',
              sql`LOWER(f_unaccent(${`%${query}%`}))`,
            ),
            eb(sql`users.email`, 'ilike', sql`f_unaccent(${`%${query}%`})`),
          ]),
        )
        .limit(limit);

      users = await userQuery.execute();
    }

    if (suggestion.includeGroups) {
      groups = await this.db
        .selectFrom('groups')
        .select(['id', 'name', 'description'])
        .where((eb) =>
          eb(
            sql`LOWER(f_unaccent(groups.name))`,
            'like',
            sql`LOWER(f_unaccent(${`%${query}%`}))`,
          ),
        )
        .where('workspaceId', '=', workspaceId)
        .limit(limit)
        .execute();
    }

    if (suggestion.includePages) {
      let pageSearch = this.db
        .selectFrom('pages')
        .select(['id', 'slugId', 'title', 'icon', 'spaceId'])
        .select((eb) => this.pageRepo.withSpace(eb))
        .where((eb) =>
          eb(
            sql`LOWER(f_unaccent(pages.title))`,
            'like',
            sql`LOWER(f_unaccent(${`%${query}%`}))`,
          ),
        )
        .where('deletedAt', 'is', null)
        .where('workspaceId', '=', workspaceId)
        .limit(limit);

      if (suggestion.onlyTemplates) {
        pageSearch = pageSearch.where('isTemplate', '=', true);
      }

      const userSpaceIds = await this.spaceMemberRepo.getUserSpaceIds(userId);

      if (userSpaceIds?.length > 0) {
        pageSearch = pageSearch.where('spaceId', 'in', userSpaceIds);

        if (suggestion?.spaceId) {
          pageSearch = pageSearch.orderBy(
            sql`CASE WHEN pages."space_id" = ${suggestion.spaceId} THEN 0 ELSE 1 END`,
            'asc',
          );
        }

        pages = await pageSearch.execute();
      }

      if (pages.length > 0) {
        const pageIds = pages.map((p) => p.id);
        const accessibleIds =
          await this.pagePermissionRepo.filterAccessiblePageIds({
            pageIds,
            userId,
            workspaceId,
          });
        const accessibleSet = new Set(accessibleIds);
        pages = pages.filter((p) => accessibleSet.has(p.id));
      }
    }

    return { users, groups, pages };
  }
}
