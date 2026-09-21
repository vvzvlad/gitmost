import { useQuery, UseQueryResult } from "@tanstack/react-query";
import { IPageWorkTime } from "./work-time.types";
import { getPageWorkTime, viewerTimezone } from "./work-time-service";

const WORK_TIME_STALE_TIME = 5 * 60 * 1000;

/**
 * #395 — the "time worked on this article" estimate + per-day punch-card
 * buckets. The buckets are computed server-side in the viewer's timezone (so a
 * midnight-crossing session lands on the right calendar day for the reader).
 * `enabled` is opt-in so the (cheap but non-trivial) projection query only fires
 * when the number is actually shown.
 */
export function usePageWorkTime(
  pageId: string,
  enabled = true,
): UseQueryResult<IPageWorkTime, Error> {
  const tz = viewerTimezone();
  return useQuery({
    queryKey: ["page-work-time", pageId, tz],
    queryFn: () => getPageWorkTime(pageId, tz),
    enabled: enabled && !!pageId,
    staleTime: WORK_TIME_STALE_TIME,
  });
}
