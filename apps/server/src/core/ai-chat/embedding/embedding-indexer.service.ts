import { Injectable, Logger } from '@nestjs/common';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import {
  PageEmbeddingRepo,
  PageEmbeddingChunkRow,
} from '@docmost/db/repos/ai-chat/page-embedding.repo';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { InjectKysely } from 'nestjs-kysely';
import { executeTx } from '@docmost/db/utils';
import { AiService } from '../../../integrations/ai/ai.service';
import { EmbeddingGenerationService } from '../../../integrations/ai/embedding-generation.service';
import { EmbeddingReindexProgressService } from '../../../integrations/ai/embedding-reindex-progress.service';
import { AiEmbeddingNotConfiguredException } from '../../../integrations/ai/ai-embedding-not-configured.exception';
import {
  describeProviderError,
  isFatalProviderError,
} from '../../../integrations/ai/ai-error.util';
import { jsonToText } from '../../../collaboration/collaboration.util';

// NOTE: the `page_embeddings.embedding` column is now dimension-agnostic
// (bare pgvector `vector`, see migration 20260617T140000), so the indexer
// stores WHATEVER dimension the configured model returns and records it per row
// in `model_dimensions`. There is no fixed-dimension guard any more; search
// compares only same-dimension rows. Trade-off: a dimension-agnostic column has
// no ANN index, so retrieval is a seq scan with `<=>` (fine at wiki scale).

// RecursiveCharacterTextSplitter settings. ~1000 chars per chunk with 200 char
// overlap is a reasonable default for prose retrieval (§6.7 stage D).
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;

// A single page taking longer than this during a bulk reindex is logged at
// WARN as an early "slow page" signal before the hard embedding timeout.
const SLOW_PAGE_MS = 30_000;

/**
 * #599 (R2) — a bulk reindex run finished, but SOME pages failed to embed (a TEI
 * timeout, a 429/500, a single poison page). The run is therefore NOT a full
 * reindex: the target generation has holes, so the pointer is not flipped (see
 * runReindex) and the workspace stays in the swap window — ~2x the pgvector rows
 * (no ANN index -> a linearly slower vector scan), `semantic.state: 'stale'`, and
 * on a MODEL change lexical-only search.
 *
 * That window MUST NOT be permanent. This error is THROWN out of the run so BullMQ
 * marks the job failed and RETRIES it with backoff (the reindex jobs are enqueued
 * with `attempts: 3` + exponential backoff — the AI_QUEUE default is `attempts: 1`,
 * so the option is set explicitly at every enqueue site). A retry is safe: the
 * start GC keeps [active, target] (it never deletes the generation being served),
 * and the per-page replace is fingerprint-scoped, so re-running simply re-writes
 * the same rows and re-attempts the pages that failed — a transient TEI hiccup then
 * self-heals into a completed run + a flip.
 *
 * Retries are BOUNDED (`attempts`), so a permanently failing page (a poison page,
 * a model that rejects a specific input) cannot loop forever: after the last
 * attempt the job is failed for good and the workspace is simply left in the
 * already-safe state it is in now — old generation still serving, coverage `stale`,
 * with the final WARN/ERROR naming the failure count. It never silently reports
 * success, which is exactly the bug this replaces.
 */
export class PartialReindexError extends Error {
  constructor(
    readonly workspaceId: string,
    readonly failed: number,
    readonly total: number,
  ) {
    super(
      `Partial reindex for workspace ${workspaceId}: ${failed}/${total} page(s) failed ` +
        `to embed, so the target generation is incomplete and the active generation ` +
        `was NOT flipped. Retrying the run (it is idempotent).`,
    );
    this.name = 'PartialReindexError';
  }
}

/**
 * Vector-RAG indexer (§6.7 stage D / §14[M1]). Turns a page's plain text into
 * chunk embeddings and persists them so the `semanticSearch` agent tool can do
 * cosine ANN retrieval.
 *
 * Everything is workspace-scoped. Reindex HARD-replaces a page's rows (delete +
 * insert in one transaction) so search never serves stale vectors.
 */
@Injectable()
export class EmbeddingIndexerService {
  private readonly logger = new Logger(EmbeddingIndexerService.name);

  constructor(
    private readonly pageRepo: PageRepo,
    private readonly pageEmbeddingRepo: PageEmbeddingRepo,
    private readonly aiService: AiService,
    private readonly reindexProgress: EmbeddingReindexProgressService,
    private readonly generation: EmbeddingGenerationService,
    @InjectKysely() private readonly db: KyselyDB,
  ) {}

  /**
   * (Re)build the embeddings for a single page.
   *
   * No-ops quietly when embeddings are unconfigured (so the queue never dies on
   * an unconfigured workspace). Any embedding dimension is accepted; the only
   * defensive skip is a page whose chunks somehow yield mixed vector lengths.
   * Deleted/empty pages have their rows purged and return.
   *
   * #599: new rows are always written with the TARGET fingerprint (the live
   * config's). The delete half of the delete+insert replace is FINGERPRINT-SCOPED
   * while a swap is in flight, so an edit during a reindex never removes the
   * page's still-served ACTIVE-generation rows (acceptance 3).
   *
   * `activeFingerprint` lets the bulk run pass the pointer it resolved ONCE, so a
   * 1000-page run does not re-read the workspace settings 1000 times. The
   * event-driven single-page path (page edited/created) omits it and resolves it
   * itself.
   *
   * Returns the number of chunk rows written (0 = purged / no-op / unconfigured) —
   * the bulk run counts the pages that really produced a chunk, which is the
   * coverage denominator recorded at the flip.
   */
  async reindexPage(
    pageId: string,
    activeFingerprint?: string,
  ): Promise<number> {
    const page = await this.pageRepo.findById(pageId, {
      includeContent: true,
      includeTextContent: true,
    });

    if (!page) {
      // The page row is gone; nothing references its embeddings to delete by
      // workspace, and the FK cascade already removed them. Nothing to do.
      this.logger.debug(`reindexPage: page ${pageId} not found, skipping`);
      return 0;
    }

    const { workspaceId, spaceId } = page;

    // Deleted page -> drop its embeddings and stop. UNSCOPED on purpose: a page
    // that no longer exists must vanish from EVERY generation, including the one
    // currently being served.
    if (page.deletedAt) {
      await this.pageEmbeddingRepo.deleteByPage(pageId, workspaceId);
      return 0;
    }

    // Prefer heading-breadcrumb chunks: each chunk is prefixed with its heading
    // path ("Page Title > H1 > H2") so the breadcrumb is embedded AND stored in
    // `content` (feeding the fts column and the agent's snippet). Walk the
    // ProseMirror JSON — NOT the markdown text — so a `#` inside a fenced code
    // block is never mistaken for a heading. Degrades to the plain-text path on
    // any error / unknown structure (returns null).
    const breadcrumbChunks = page.content
      ? await this.safeBuildBreadcrumbChunks(page.content, page.title)
      : null;

    // Fall back to plain text when breadcrumb chunking is unavailable.
    const fallbackText =
      breadcrumbChunks && breadcrumbChunks.length > 0
        ? null
        : this.extractText(page);

    // Empty page (neither path produced content) -> remove any prior embeddings
    // so search returns nothing. UNSCOPED (like the deleted-page purge): a page
    // with no content must not be served from ANY generation.
    if (
      (!breadcrumbChunks || breadcrumbChunks.length === 0) &&
      (!fallbackText || fallbackText.trim().length === 0)
    ) {
      await this.pageEmbeddingRepo.deleteByPage(pageId, workspaceId);
      return 0;
    }

    // Resolve the embeddings provider WITHOUT crashing the queue when
    // unconfigured. #530: resolveEmbeddingProvider prefers the workspace provider
    // and falls back to the GLOBAL env provider (TEI sidecar), and yields the
    // doc-prefix + the active fingerprint stored per row so search filters by the
    // active generation.
    let provider: Awaited<ReturnType<AiService['resolveEmbeddingProvider']>>;
    try {
      provider = await this.aiService.resolveEmbeddingProvider(workspaceId);
    } catch (err) {
      if (err instanceof AiEmbeddingNotConfiguredException) {
        // No embeddings provider for this workspace: NO-OP (§6.7). The page can
        // be indexed later once a provider is configured.
        this.logger.debug(
          `reindexPage: embeddings not configured for workspace ${workspaceId}, skipping page ${pageId}`,
        );
        return 0;
      }
      throw err;
    }

    // #599: the fingerprint the NEW rows carry is always the live config's (the
    // TARGET generation). Resolve the ACTIVE pointer to decide the delete scope
    // below (the bulk run supplies it, so it is read once per run, not per page).
    // The model id is recorded per row (provenance) AND at the flip, so a reader can
    // tell whether the served generation's rows share the query's embedding space.
    const targetFingerprint = provider.fingerprint;
    const modelName = provider.modelId;
    const active =
      activeFingerprint ??
      (
        await this.generation.generationForTarget(
          workspaceId,
          targetFingerprint,
          modelName,
        )
      ).active;

    // Use breadcrumb chunks when available; otherwise chunk the plain text.
    let chunks: string[];
    if (breadcrumbChunks && breadcrumbChunks.length > 0) {
      chunks = breadcrumbChunks;
    } else {
      const splitter = new RecursiveCharacterTextSplitter({
        chunkSize: CHUNK_SIZE,
        chunkOverlap: CHUNK_OVERLAP,
      });
      chunks = await splitter.splitText(fallbackText as string);
    }
    if (chunks.length === 0) {
      await this.pageEmbeddingRepo.deleteByPage(pageId, workspaceId);
      return 0;
    }

    // #530: prepend the provider's DOC prefix to each chunk (e5-style
    // "passage: "; empty for a non-e5 provider) so stored vectors live in the
    // same prefixed space as a prefixed query, then embed with the RESOLVED
    // provider model (which may be the global TEI sidecar, not a workspace one).
    const prefixedChunks = provider.docPrefix
      ? chunks.map((c) => provider.docPrefix + c)
      : chunks;
    const vectors = await this.aiService.embedWithModel(
      provider.model,
      workspaceId,
      prefixedChunks,
    );

    // The column is dimension-agnostic, so ANY model dimension is stored as-is.
    // Defensive sanity check only: all chunks of ONE page come from the SAME
    // model and must share a dimension. A page that yields mixed lengths would
    // poison the per-dimension search filter, so skip it with a warning rather
    // than insert inconsistent rows.
    const expectedDim = vectors[0]?.length;
    if (expectedDim != null) {
      const mixed = vectors.find((v) => v.length !== expectedDim);
      if (mixed) {
        this.logger.warn(
          `reindexPage: mixed embedding dimensions (${expectedDim} vs ${mixed.length}) ` +
            `for workspace ${workspaceId}; skipping page ${pageId}.`,
        );
        return 0;
      }
    }

    const rows = this.buildChunkRows(
      chunks,
      vectors,
      { pageId, workspaceId, spaceId },
      modelName,
      targetFingerprint,
    );

    // HARD replace in one transaction: delete then insert so search never returns
    // stale vectors for this page.
    //
    // #599 — the delete is FINGERPRINT-SCOPED to the generation being rewritten
    // (the target) whenever a swap is in flight. During a swap the page's ACTIVE
    // rows are what search still serves; deleting them here (and inserting rows of
    // the not-yet-served target generation) would drop the page out of semantic
    // search for the entire reindex window. Outside a swap active === target and
    // the scope is dropped entirely, so the replace ALSO reclaims the page's rows
    // from any other generation (notably legacy NULL-fingerprint rows) — the
    // per-page half of the generational GC.
    const deleteScope =
      active === targetFingerprint ? undefined : [targetFingerprint];

    await executeTx(this.db, async (trx) => {
      await this.pageEmbeddingRepo.deleteByPage(
        pageId,
        workspaceId,
        trx,
        deleteScope,
      );
      await this.pageEmbeddingRepo.insertChunks(rows, trx);
    });

    this.logger.debug(
      `reindexPage: indexed ${rows.length} chunk(s) for page ${pageId}`,
    );
    return rows.length;
  }

  /**
   * (Re)build embeddings for the EMBEDDABLE page set of a workspace — the same
   * set countEmbeddablePages counts (via getEmbeddablePageIds): non-deleted pages
   * that qualify under any of the three clauses of `embeddablePredicate` —
   * non-empty textContent, OR an empty/null textContent whose ProseMirror
   * `content` JSON has at least one text node (`"type":"text"`) that `jsonToText`
   * can extract, OR an already-stored (non-deleted) embedding row — NOT every
   * non-deleted page. Iterating this set keeps the live `total` equal to the
   * steady-state denominator, so the progress counter climbs 0 -> total and
   * matches the before/after DB coverage exactly. A page with truly no
   * extractable text (empty textContent AND content with only non-text/atom
   * nodes such as math) is correctly skipped (reindexPage no-ops on it); a page
   * that lost its text but still has stale embeddings stays in the set (the
   * EXISTS clause) so it is visited and its stale rows are cleared. Used by the
   * bulk reindex (WORKSPACE_CREATE_EMBEDDINGS, fired when AI Search is enabled
   * and by the manual "Reindex now" action).
   *
   * Resolves the embeddings model once up front: if the workspace has no
   * embeddings provider configured, the whole batch is skipped (otherwise each
   * page would no-op individually after a wasted read). Pages are processed
   * sequentially and each is isolated in try/catch so one failure never aborts
   * the batch.
   *
   * #599 — THE GENERATION SWAP. The run is the unit that owns a fingerprint
   * transition, in this order:
   *
   *   1. pin the TARGET (the live config's fingerprint) and read the ACTIVE
   *      pointer. The run carries the target from here on: every row it writes
   *      carries it, and the pointer may only ever be flipped ONTO it.
   *   2. GC at the START: keep {active, target} only — reclaims older generations,
   *      legacy NULL-fingerprint rows, and the partial output of an earlier run
   *      whose target has since been superseded. Idempotent, so a retried run
   *      re-runs it harmlessly (acceptance 4).
   *   3. reindex every embeddable page into the TARGET generation. NON-DESTRUCTIVE:
   *      the active generation is untouched and keeps serving search for the whole
   *      window (acceptance 2), at the cost of a transient ~2x pgvector footprint
   *      (documented on deleteOtherGenerations).
   *   4. ATOMIC FLIP, only after the run indexed EVERY page it iterated (zero
   *      failures) AND only if the config still resolves to this run's target
   *      (EmbeddingGenerationService.completeRun). A fatal provider abort throws out
   *      of the loop and never reaches this line, so an aborted run NEVER flips the
   *      pointer (acceptance 4). If the config moved on MID-RUN, completeRun throws
   *      StaleReindexTargetError: the job fails, BullMQ retries it, and the retry
   *      re-resolves the provider here at step 1 and builds the new target (#599
   *      review F1 — the enqueue that config change attempted was deduped against
   *      this run, so the retry is the only thing that will ever build it).
   *
   * The legacy NULL-fingerprint rows of an existing instance are covered by exactly
   * the same path: the first run writes the whole workspace under the target
   * fingerprint, flips onto it, and the GC reclaims the NULLs (acceptance 1).
   *
   * #599 (D4) — the WHOLE run is serialised per workspace by a Postgres advisory
   * lock (EmbeddingGenerationService.runExclusive). The BullMQ jobId dedupe alone is
   * not enough: a stalled job is re-dispatched while the original still runs, and
   * two overlapping runs destroy each other's generations (run B's start GC deletes
   * run A's half-built target; a config rollback then lets A flip onto its own holed
   * generation and GC the one that was serving). A second run simply skips.
   */
  async reindexWorkspace(workspaceId: string): Promise<void> {
    const ran = await this.generation.runExclusive(workspaceId, () =>
      this.runReindex(workspaceId),
    );
    if (!ran) {
      this.logger.warn(
        `reindexWorkspace: another reindex run is already in flight for workspace ` +
          `${workspaceId}; skipping this one (its work is being done by the run that ` +
          `holds the lock).`,
      );
    }
  }

  /** The body of a reindex run; always executed under the per-workspace run lock. */
  private async runReindex(workspaceId: string): Promise<void> {
    // #599 (review F2) — the instant this run STARTED, recorded with the coverage
    // numbers at the flip. It is what lets the coverage rule tell the pages this run
    // measured from the pages that appeared/changed afterwards, so the run's frozen
    // chunk-less gap can never excuse a brand-new un-embedded page. Taken BEFORE the
    // first page is read (not at the flip): a page edited mid-run must land on the
    // "changed since" side, or its re-embedding would be excused by a measurement
    // that never saw it.
    const coverageAt = new Date();

    // The whole run is wrapped so the per-workspace progress record is ALWAYS
    // cleared in the finally — on success, on a fatal-provider abort, on an
    // unconfigured early-return, or on any unexpected throw — so a failed run
    // never leaves a stuck "reindexing" state (the status then falls back to the
    // steady-state DB coverage count). A placeholder record may already exist
    // (seeded at enqueue time); the finally cleans that too.
    try {
      // #530: resolve via the same path reindexPage uses (workspace provider, else
      // the global TEI sidecar) so a global-only deployment is NOT skipped.
      // #599: its fingerprint is this run's TARGET generation.
      let targetFingerprint: string;
      let targetModel: string;
      try {
        const provider =
          await this.aiService.resolveEmbeddingProvider(workspaceId);
        targetFingerprint = provider.fingerprint;
        // Recorded with the pointer at the flip: it is what lets a reader detect a
        // MODEL change (a different embedding space) as opposed to a mere
        // revision/prefix change (the same space) — #599 D2.
        targetModel = provider.modelId;
      } catch (err) {
        if (err instanceof AiEmbeddingNotConfiguredException) {
          this.logger.log(
            `reindexWorkspace: embeddings not configured for workspace ${workspaceId}, skipping`,
          );
          return;
        }
        throw err;
      }

      // The pointer the readers currently serve (== target on a fresh instance,
      // i.e. no swap window). Read ONCE and threaded into every reindexPage call.
      const { active, swapping } = await this.generation.generationForTarget(
        workspaceId,
        targetFingerprint,
        targetModel,
      );

      // GC at the START of the swap: at most 2 generations survive — the one being
      // served and the one being built (cap 2, acceptance 5). Idempotent.
      await this.generation.gcGenerations(
        workspaceId,
        Array.from(new Set([active, targetFingerprint])),
      );

      if (swapping) {
        this.logger.log(
          `reindexWorkspace: fingerprint swap for workspace ${workspaceId}: ` +
            `active=${active} -> target=${targetFingerprint} (old generation keeps serving search until the flip)`,
        );
      }

      // Iterate the EMBEDDABLE set (same three-clause predicate as
      // countEmbeddablePages), NOT every non-deleted page: this makes `total`
      // here equal the steady-state denominator, so the live counter climbs
      // 0 -> total and matches the before/after DB count exactly (no
      // 478 -> 500 -> 478 denominator jump). Pages whose text lives in the
      // ProseMirror `content` JSON (a text node) even with empty text_content ARE
      // in this set (the content-JSON clause) and get embedded; a page with no
      // extractable text at all is correctly skipped — reindexPage no-ops on it —
      // and a page that lost its text but still has stale embeddings IS in this
      // set (the EXISTS clause) so it is still visited and its stale rows cleared.
      const pageIds = await this.pageRepo.getEmbeddablePageIds(workspaceId);
      const total = pageIds.length;
      const startedAt = Date.now();
      // Publish the live run progress over this same set (done reset to 0). The
      // counter increments once per iterated page and reaches exactly `total`,
      // which equals countEmbeddablePages — the steady-state denominator.
      await this.reindexProgress.start(workspaceId, total);
      this.logger.log(
        `reindexWorkspace: starting reindex of ${total} page(s) for workspace ${workspaceId}`,
      );

      let failed = 0;
      // Pages that really produced >= 1 chunk. This — NOT the raw embeddable count
      // — is the coverage denominator recorded at the flip: a page whose only
      // content is a math block / an image passes the (optimistic) embeddable
      // predicate but yields no chunk, so counting it would keep the coverage state
      // pinned at `stale` forever (#599).
      let produced = 0;
      for (let i = 0; i < total; i++) {
        const pageId = pageIds[i];
        const position = i + 1;
        // Log BEFORE the await: if the embedding call hangs, this is the last line
        // in the log and it names the exact page that is stuck.
        this.logger.log(
          `reindexWorkspace: [${position}/${total}] indexing page ${pageId} (workspace ${workspaceId})`,
        );
        const pageStartedAt = Date.now();
        try {
          // Rows are written under the TARGET fingerprint; `active` is passed so
          // the per-page replace scopes its delete correctly during a swap.
          const chunks = await this.reindexPage(pageId, active);
          if (chunks > 0) produced++;
          // Count this page as processed (matches the [position/total] log).
          await this.reindexProgress.increment(workspaceId);
          const elapsed = Date.now() - pageStartedAt;
          if (elapsed >= SLOW_PAGE_MS) {
            this.logger.warn(
              `reindexWorkspace: [${position}/${total}] page ${pageId} took ${elapsed}ms`,
            );
          }
        } catch (err) {
          // A fatal provider error (invalid/missing key, no credits) recurs
          // identically on EVERY remaining page. Abort the whole batch instead of
          // issuing hundreds of doomed requests against the provider. Do NOT count
          // it as processed — the run aborts here (the finally clears progress).
          if (isFatalProviderError(err)) {
            this.logger.error(
              `reindexWorkspace: aborting at [${position}/${total}] for workspace ` +
                `${workspaceId} — fatal provider error, remaining pages would fail ` +
                `identically: ${describeProviderError(err)}`,
            );
            throw err;
          }
          // Per-page isolation: one non-fatal failure (incl. an embedding timeout)
          // must not abort the whole batch. A handled failure still advances the
          // counter (matches the [position/total] log, so done reaches total).
          failed++;
          await this.reindexProgress.increment(workspaceId);
          this.logger.error(
            `reindexWorkspace: [${position}/${total}] failed to reindex page ${pageId} ` +
              `after ${Date.now() - pageStartedAt}ms: ${describeProviderError(err)}`,
          );
        }
      }

      this.logger.log(
        `reindexWorkspace: done for workspace ${workspaceId}: ` +
          `${total - failed}/${total} indexed, ${failed} failed in ${Date.now() - startedAt}ms`,
      );

      // #599 (D1) — a run with ANY failed page is NOT a full reindex, and the design
      // flips "ONLY after a FULL reindex". Non-fatal per-page failures (a TEI
      // timeout, a 429/500, a mixed-dimension page) are isolated so they cannot
      // abort the batch — but they mean the TARGET generation has HOLES: those pages
      // have no target rows. Flipping anyway would be data loss, not degradation:
      //   - the post-flip GC (keep = [target]) would destroy the OLD generation,
      //     including the only surviving rows of the failed pages -> they fall out
      //     of semantic search PERMANENTLY;
      //   - and coverage would report `full` (indexed == the recorded produced
      //     total), i.e. a vacuous "full" over a corpus that silently lost 5%.
      // So: no flip. The OLD generation keeps serving (complete, if stale), coverage
      // keeps reporting `stale`, and the partial target rows are simply an extra
      // generation — a re-run overwrites them page by page (the per-page replace is
      // fingerprint-scoped, so it is idempotent), and the start GC reclaims them if
      // the config has moved on in the meantime.
      //
      // #599 (R2) — and the re-run must be AUTOMATIC. Returning quietly here made
      // the BullMQ job COMPLETE successfully, so nothing ever re-ran it: ONE
      // transient TEI timeout parked the workspace in the swap window FOREVER (2x
      // rows on an un-indexed vector column, `stale`, and lexical-only after a model
      // change). THROW instead: the processor lets it out, BullMQ retries the job
      // with exponential backoff, and the idempotent run re-attempts the failed
      // pages. Bounded by the job's `attempts`, after which the workspace is left in
      // this same (safe, old-generation-still-serving) state — degraded, but never
      // silently and never claiming success.
      if (failed > 0) {
        this.logger.warn(
          `reindexWorkspace: NOT flipping the active generation for workspace ` +
            `${workspaceId}: ${failed}/${total} page(s) failed, so the target ` +
            `generation ${targetFingerprint} is incomplete. The previous generation ` +
            `(${active}) keeps serving search and semantic.state stays 'stale'. ` +
            `Failing the job so it is RETRIED (the run is idempotent).`,
        );
        throw new PartialReindexError(workspaceId, failed, total);
      }

      // The run completed IN FULL (a fatal provider error would have thrown out of
      // the loop above, skipping this; a partial run threw just above). Publish the
      // generation: ONE settings write moves the active pointer onto the target and
      // records `produced` (the pages that really produced a chunk), `total` (the
      // pages the run considered embeddable) and `coverageAt` (when the run started)
      // as the coverage measurements — but only if the config STILL resolves to this
      // run's target, so a config change during the run cannot get a superseded
      // generation published (the second-swap-during-the-first guard). On a
      // successful flip completeRun also GCs the superseded generation, ending the
      // transient ~2x storage.
      //
      // #599 (review F1) — when the config DID move on, completeRun THROWS
      // (StaleReindexTargetError) rather than skipping quietly, and the throw is
      // deliberately left to propagate: it fails the BullMQ job, whose retry
      // re-resolves the provider at the top of this method and builds the NOW-current
      // target. Nothing else would: the reindex the config change tried to enqueue
      // was de-duplicated against this very job, so swallowing this would leave the
      // new fingerprint with zero rows and no job forever.
      await this.generation.completeRun({
        workspaceId,
        target: targetFingerprint,
        targetModel,
        coverageTotal: produced,
        coverageEmbeddable: total,
        coverageAt,
      });
    } finally {
      // Always remove the progress record so the status reverts to the DB count.
      await this.reindexProgress.clear(workspaceId);
    }
  }

  /** Purge ALL embeddings for a workspace (WORKSPACE_DELETE_EMBEDDINGS). */
  async removeWorkspace(workspaceId: string): Promise<void> {
    await this.pageEmbeddingRepo.deleteByWorkspace(workspaceId);
  }

  /** Remove all embeddings for a deleted page (used by the delete path). */
  async removePage(pageId: string, workspaceId: string): Promise<void> {
    await this.pageEmbeddingRepo.deleteByPage(pageId, workspaceId);
  }

  /**
   * Get the page's plain text. Prefers the stored `textContent`; falls back to
   * extracting text from the ProseMirror JSON `content` when textContent is
   * absent (e.g. older rows).
   */
  private extractText(page: {
    textContent?: string | null;
    content?: unknown;
  }): string {
    if (typeof page.textContent === 'string' && page.textContent.length > 0) {
      return page.textContent;
    }
    if (page.content) {
      try {
        return jsonToText(page.content as never) ?? '';
      } catch {
        return '';
      }
    }
    return '';
  }

  /**
   * Map chunk strings + vectors to insertable rows. Breadcrumb-prefixed chunks
   * are NOT verbatim substrings of any source text, so chunkStart is a running
   * cumulative offset (sum of previous chunk lengths) rather than an indexOf
   * position. These offsets are informational provenance only — search returns
   * `content` and never slices by offset. chunkIndex stays a global monotonic
   * index.
   */
  private buildChunkRows(
    chunks: string[],
    vectors: number[][],
    ids: { pageId: string; workspaceId: string; spaceId: string },
    modelName: string,
    fingerprint: string | null,
  ): PageEmbeddingChunkRow[] {
    const rows: PageEmbeddingChunkRow[] = [];
    let cursor = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = vectors[i];
      if (!embedding) continue;
      const chunkStart = cursor;
      cursor += chunk.length;
      rows.push({
        pageId: ids.pageId,
        workspaceId: ids.workspaceId,
        spaceId: ids.spaceId,
        // Page-body chunk: no attachment.
        attachmentId: null,
        chunkIndex: i,
        chunkStart,
        chunkLength: chunk.length,
        content: chunk,
        // Provenance for a future re-index sweep on model change.
        modelName,
        modelDimensions: embedding.length,
        // #530: the active generation fingerprint this row belongs to.
        fingerprint,
        embedding,
      });
    }
    return rows;
  }

  /**
   * Thin try/catch wrapper around buildBreadcrumbChunks. Any failure (malformed
   * structure, unknown node type, etc.) returns null so the caller degrades
   * gracefully to the plain-text chunking path.
   */
  private async safeBuildBreadcrumbChunks(
    contentJson: unknown,
    pageTitle: string | null,
  ): Promise<string[] | null> {
    try {
      return await this.buildBreadcrumbChunks(contentJson, pageTitle);
    } catch {
      return null;
    }
  }

  /**
   * Build heading-breadcrumb chunks by walking the ProseMirror JSON document.
   *
   * Each section (the body following a heading) is split with the same 1000/200
   * RecursiveCharacterTextSplitter, and every resulting piece is prefixed with
   * its heading path ("Page Title > H1 > H2"). Walking the JSON — not markdown
   * text — means a `#` inside a fenced code block is never treated as a heading
   * (ProseMirror heading nodes are explicit).
   *
   * Returns null when `contentJson` is not an object with an array `content`, so
   * the caller falls back to plain-text chunking.
   */
  private async buildBreadcrumbChunks(
    contentJson: unknown,
    pageTitle: string | null,
  ): Promise<string[] | null> {
    const doc = contentJson as { content?: unknown };
    if (
      typeof contentJson !== 'object' ||
      contentJson === null ||
      !Array.isArray(doc.content)
    ) {
      return null;
    }

    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: CHUNK_SIZE,
      chunkOverlap: CHUNK_OVERLAP,
    });

    const out: string[] = [];
    const stack: { level: number; text: string }[] = [];
    let buffer = '';

    // Flush the accumulated body as one or more chunks under the CURRENT crumb.
    const flush = async (): Promise<void> => {
      if (buffer.trim().length === 0) {
        buffer = '';
        return;
      }
      const crumb = [pageTitle, ...stack.map((s) => s.text)]
        .filter((s) => typeof s === 'string' && s.trim().length > 0)
        .join(' > ');
      const pieces = await splitter.splitText(buffer);
      for (const piece of pieces) {
        out.push(crumb ? `${crumb}\n\n${piece}` : piece);
      }
      buffer = '';
    };

    for (const block of doc.content as Array<{
      type?: string;
      attrs?: { level?: number };
    }>) {
      if (block?.type === 'heading') {
        // Flush the preceding body under the crumb in effect BEFORE this
        // heading, then update the heading stack.
        await flush();
        const level =
          typeof block.attrs?.level === 'number' ? block.attrs.level : 1;
        // Pop deeper-or-equal headings: a new H2 replaces a prior H2/H3/...
        while (stack.length > 0 && stack[stack.length - 1].level >= level) {
          stack.pop();
        }
        const headingText = jsonToText({
          type: 'doc',
          content: [block],
        } as never).trim();
        if (headingText.length > 0) {
          stack.push({ level, text: headingText });
        }
      } else {
        const blockText = jsonToText({
          type: 'doc',
          content: [block],
        } as never);
        buffer = buffer.length > 0 ? `${buffer}\n${blockText}` : blockText;
      }
    }

    // Flush any trailing body after the last heading.
    await flush();

    return out;
  }
}
