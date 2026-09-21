/**
 * #370 — resolve the TRUE previous snapshot for a history item.
 *
 * The history panel can be filtered to "only versions" (manual/agent), but diff
 * and restore must always compare against the immediately-preceding snapshot in
 * the FULL, unfiltered list — NOT the previous VISIBLE item. Comparing against
 * the previous visible version would silently skip the autosnapshots between two
 * versions and diff/restore the wrong baseline.
 *
 * Given the full (newest-first) list and an item id, this returns the id of the
 * item right after it in the full list (its chronological predecessor), or "" if
 * it is the oldest / not found. Pure and list-order-preserving so it can be unit
 * tested without mounting the component.
 */
export function resolvePrevSnapshotId(
  fullItems: ReadonlyArray<{ id: string }>,
  id: string,
): string {
  const index = fullItems.findIndex((item) => item.id === id);
  if (index === -1) return "";
  return fullItems[index + 1]?.id ?? "";
}
