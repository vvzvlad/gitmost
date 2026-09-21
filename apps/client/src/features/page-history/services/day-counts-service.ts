import api from "@/lib/api-client";

/** #568/#605 — one calendar day of the page-history heatmap: the number of ALL
 *  revisions (any kind — manual/agent/idle/boundary/legacy null) on that day,
 *  keyed by 'YYYY-MM-DD' in the viewer tz, i.e. total day activity. Intentionally
 *  broader than the "Only versions" list filter (which stays about versions), so
 *  a lit day need NOT have a version row — an autosave-only day still lights up. */
export interface IPageHistoryDayCount {
  dayISO: string;
  count: number;
}

export async function getPageHistoryDayCounts(
  pageId: string,
  tz: string,
): Promise<IPageHistoryDayCount[]> {
  const req = await api.post<IPageHistoryDayCount[]>(
    "/pages/history/day-counts",
    { pageId, tz },
  );
  return req.data;
}
