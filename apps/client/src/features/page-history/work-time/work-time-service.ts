import api from "@/lib/api-client";
import { IPageWorkTime } from "./work-time.types";

/** The viewer's IANA timezone (browser locale) — the punch-card lays days out
 *  in "my evenings", per §6.3/§10. Falls back to UTC if the runtime hides it. */
export function viewerTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export async function getPageWorkTime(
  pageId: string,
  tz: string,
): Promise<IPageWorkTime> {
  const req = await api.post<IPageWorkTime>("/pages/history/time", {
    pageId,
    tz,
  });
  return req.data;
}
