import { Space } from '@docmost/db/types/entity.types';

// #529 A7 — the single per-hit SUPERSET returned by the unified search engine.
// The web-UI reads id/highlight/icon/space/title/…; the MCP agent maps id→pageId
// and reads snippet/score/path. `rank`/`highlight` are null for substring-only
// hits (the web already falls back). Nothing the legacy web response carried is
// dropped.
export class SearchResultDto {
  id: string;
  // Alias of `id` for the MCP layer (it addresses pages by pageId).
  pageId: string;
  slugId: string;
  icon: string;
  title: string;
  space?: Partial<Space>;
  creatorId: string;
  createdAt: Date;
  updatedAt: Date;
  // ts_rank_cd of the FTS branch; null for substring-only hits.
  rank: number | null;
  // ts_headline marked HTML; null for substring-only hits.
  highlight: string | null;
  // Plain windowed snippet around the match (empty for titleOnly).
  snippet: string;
  // Ancestor titles root → direct parent ([] for a root page).
  path: string[];
  // Per-response ordering proxy (falls back to rank).
  score: number;
  // Which fields matched: 'title' and/or 'text'.
  matchedFields: string[];
  // Which parsed positive/required terms this hit matched.
  matchedTerms: string[];
}

// #530 Phase B — the semantic (vector) layer's per-request status.
//  - `state`:
//      'off'   — the vector arm did not run at all: kill-switch, no embedding
//                provider, or a degrade (sidecar down / embed timeout).
//      'stale' — the semantics are out of date and a reindex would fix them. Two
//                sub-cases:
//                (a) the arm RAN over the active generation, which does not cover
//                    the whole workspace (a legacy NULL-fingerprint instance never
//                    reindexed, an aborted/partial run, pages added since, or a
//                    same-model fingerprint swap in flight where the OLD generation
//                    keeps serving) -> `available: true`, real vector hits;
//                (b) the arm was deliberately NOT raised because the configured
//                    MODEL differs from the one that produced the served
//                    generation's rows (#599 D2): a cosine across two independently
//                    trained embedding spaces is noise, so search serves lexical
//                    only until the reindex completes -> `available: false`.
//      'full'  — the arm ran and the active generation covers every page that
//                produces a chunk.
//  - `available`: whether the vector arm actually contributed this request. TRUE on
//    a 'stale' of sub-case (a); FALSE on (b).
//  - `reason`: why the arm did NOT run — 'no-provider' / 'degraded' — or, on a
//    'stale' state, simply 'stale'.
//  - `indexed`/`total`: coverage of the ACTIVE generation (#599). `total` is the
//    number of pages that actually produce >= 1 chunk, NOT the raw embeddable
//    count (see EmbeddingGenerationService.computeCoverage). Present only when the
//    vector arm ran.
export class SearchSemanticDto {
  state: 'full' | 'stale' | 'off';
  available: boolean;
  reason?: 'no-provider' | 'degraded' | 'stale';
  indexed?: number;
  total?: number;
}

// The paginated envelope (A5). `total` is the permission-filtered count of the
// candidate UNION (lexical ∪ vector top-N, fail-closed) — a deliberate, #530
// documented change from Phase A's exact-lexical count (on a semantic degrade it
// falls back to exactly that lexical count). `hasMore` is true when more results
// exist WITHIN the fusion window; `truncatedAtCap` signals the match set exceeded
// CANDIDATE_CAP and the tail is unreachable by pagination.
export class SearchResponseDto {
  items: SearchResultDto[];
  total: number;
  hasMore: boolean;
  truncatedAtCap: boolean;
  offset: number;
  query: {
    raw: string;
    parsed: {
      positive: string[];
      required: string[];
      excluded: string[];
      reason?: string;
    };
    mode: 'or' | 'and';
    match: string;
  };
  // Absent on the early-exit paths (empty/garbage query); present once search
  // actually runs. Optional so those short-circuit responses stay valid.
  semantic?: SearchSemanticDto;
}
