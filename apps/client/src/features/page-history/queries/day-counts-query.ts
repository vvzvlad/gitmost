import { useQuery, UseQueryResult } from "@tanstack/react-query";
import {
  getPageHistoryDayCounts,
  IPageHistoryDayCount,
} from "@/features/page-history/services/day-counts-service";
import { viewerTimezone } from "@/features/page-history/work-time/work-time-service";

const DAY_COUNTS_STALE_TIME = 5 * 60 * 1000;

/**
 * #568 — revisions-per-day aggregate for the mini-calendar heatmap. The whole
 * history is fetched in one request (no `month` param) so month navigation is
 * purely client-side. `tz` is the SAME viewer zone the dense list groups days
 * in, so a heatmap cell and its list rows can never drift onto different days.
 *
 * fail-open: the caller renders an empty grid on error and the list/restore keep
 * working (the heatmap is navigational sugar, never a gate).
 */
export function usePageHistoryDayCounts(
  pageId: string,
): UseQueryResult<IPageHistoryDayCount[], Error> {
  const tz = viewerTimezone();
  return useQuery({
    queryKey: ["page-history-day-counts", pageId, tz],
    queryFn: () => getPageHistoryDayCounts(pageId, tz),
    enabled: !!pageId,
    staleTime: DAY_COUNTS_STALE_TIME,
  });
}
