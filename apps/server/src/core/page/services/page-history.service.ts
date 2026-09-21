import { Injectable } from '@nestjs/common';
import { PageHistoryRepo } from '@docmost/db/repos/page/page-history.repo';
import { PageHistory } from '@docmost/db/types/entity.types';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { CursorPaginationResult } from '@docmost/db/pagination/cursor-pagination';
import {
  computeWorkTime,
  bucketByDay,
  countRevisionsByDay,
  DEFAULT_WORK_TIME_CONFIG,
  WorkTimeConfig,
  PerDay,
  DayCount,
} from '../work-time';

export interface PageWorkTime {
  workMs: number;
  agentOnlyMs: number;
  perDay: PerDay[];
  /** the config actually used, so the UI can show "≈" + the T_gap threshold. */
  config: WorkTimeConfig;
  /** the tz the per-day buckets were computed in (echoed back for the label). */
  tz: string;
}

@Injectable()
export class PageHistoryService {
  constructor(private pageHistoryRepo: PageHistoryRepo) {}

  async findById(historyId: string): Promise<PageHistory> {
    return await this.pageHistoryRepo.findById(historyId, {
      includeContent: true,
    });
  }

  async findHistoryByPageId(
    pageId: string,
    paginationOptions: PaginationOptions,
  ): Promise<CursorPaginationResult<PageHistory>> {
    return this.pageHistoryRepo.findPageHistoryByPageId(
      pageId,
      paginationOptions,
    );
  }

  /**
   * #395 — estimate time worked on a page (§5) and bucket it into the viewer's
   * calendar days for the punch-card (§6.3). Reads only the cheap history
   * projection (no `content`); the estimate itself is a pure, deterministic
   * function so it is unit-tested exhaustively without a DB.
   *
   * `tz` is the viewer's IANA zone (browser locale) — it moves which day a
   * session lands in and where its windows sit, but never the total (§10).
   */
  async computeWorkTime(
    pageId: string,
    tz = 'UTC',
    config?: Partial<WorkTimeConfig>,
  ): Promise<PageWorkTime> {
    const rows = await this.pageHistoryRepo.findTimelineByPageId(pageId);
    const result = computeWorkTime(rows, config);
    const usedConfig: WorkTimeConfig = { ...DEFAULT_WORK_TIME_CONFIG, ...config };
    // `bucketByDay` consumes the pure core's un-bucketed sessions here; the
    // full session list is NOT shipped on the response (no client reads it).
    const perDay = bucketByDay(result.sessions, tz);
    return {
      workMs: result.workMs,
      agentOnlyMs: result.agentOnlyMs,
      perDay,
      config: usedConfig,
      tz,
    };
  }

  /**
   * #568/#605 — "all revisions per day" aggregate for the page-history
   * mini-calendar heatmap. Reads only the cheap timeline projection (no
   * `content`) — the same source as computeWorkTime — and tallies ALL revisions
   * (any kind) into the viewer's calendar days, reusing the shared tz core, so
   * the heatmap reflects total day activity. Whole history in one request (no
   * `month` param) so month navigation is purely client-side.
   *
   * `tz` is the viewer's IANA zone; an unknown zone makes the Intl-backed core
   * throw a RangeError, which the controller maps to a 400 (like /history/time).
   */
  async computeDayCounts(pageId: string, tz = 'UTC'): Promise<DayCount[]> {
    const rows = await this.pageHistoryRepo.findTimelineByPageId(pageId);
    return countRevisionsByDay(rows, tz);
  }
}
