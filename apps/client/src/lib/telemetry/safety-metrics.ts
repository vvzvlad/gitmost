import { isClientTelemetryEnabled } from "@/lib/config";

/**
 * ALWAYS-ON safety-control counters (#640).
 *
 * These are deliberately SEPARATE from the perf pipe in `vitals.ts`. The perf
 * metrics are default-OFF and 25%-sampled; a safety control whose failure is
 * unobservable by construction is not a control (AGENTS.md rule #10). So every
 * counter here is:
 *  - kept in an in-memory tally that is observable to the operator (a debug
 *    hook) and to tests (`getSafetyMetric`), with NO sampling gate;
 *  - logged with a stable, greppable `[ydoc-safety]` prefix on EVERY increment,
 *    which by itself satisfies rule #10's "a metric OR a greppable ERROR log";
 *  - best-effort delivered to the telemetry sink IMMEDIATELY (not buffered
 *    behind the sampled flush loop), so a fail-closed control's degradation is
 *    reported the moment it happens — but only when the operator has turned
 *    telemetry on at all (otherwise the sink endpoint does not exist).
 *
 * The counters fire on the failure paths of the local-content hygiene controls:
 * a blocked/failed IndexedDB deletion, a tombstone the denylist could not
 * persist, an IDB quota error, a purge that could not complete, and the
 * session-wide fail-closed disable of the local-paint path.
 */
export type SafetyMetricName =
  // A `deleteDatabase` request was blocked (another tab still holds the db open)
  // — the revoked/signed-out content then survives on disk until that tab closes.
  | "ydoc_delete_blocked"
  // A `deleteDatabase` request errored.
  | "ydoc_delete_error"
  // A purge (logout / 401 / sign-in / session-boundary) could not complete.
  | "ydoc_purge_failed"
  // The tombstone denylist could not be written (quota / storage disabled).
  | "ydoc_tombstone_write_failed"
  // A generic IndexedDB quota error surfaced while managing the ydoc databases.
  | "ydoc_idb_quota_error"
  // The tombstone store is unreadable/unwritable, so the local-paint path is
  // disabled for the WHOLE session (fail-closed fallback to the network gate).
  | "ydoc_local_paint_disabled"
  // #641, part 4 — a 5xx response on an OFFLINE-CRITICAL request (/me,
  // /pages/info, /spaces/*). The server ANSWERED with an error, so this is a
  // real (possibly partial) outage that must NOT hide behind "offline, cached
  // copy": it is counted + reported here, distinct from an unreachable network.
  | "http_server_error";

const ENDPOINT = "/api/telemetry/vitals";

const counters = new Map<SafetyMetricName, number>();

/**
 * Record a safety-control failure. Always increments the in-memory counter and
 * logs a greppable line; additionally attempts an immediate best-effort beacon
 * when telemetry is enabled. Never throws.
 */
export function reportSafetyMetric(
  name: SafetyMetricName,
  detail?: unknown,
): void {
  counters.set(name, (counters.get(name) ?? 0) + 1);

  // Greppable, always-on. This is a control FAILURE, so it is an error-level log
  // even when the numeric consequence is small (rule #10).
  try {
    // eslint-disable-next-line no-console
    console.error(`[ydoc-safety] ${name}`, detail ?? "");
  } catch {
    // never let logging throw
  }

  // Immediate best-effort delivery, unconditional of the 25% perf sampling. The
  // sink only exists when the operator enabled telemetry, so gate solely on that
  // master switch (not on `isVitalsSampled`).
  try {
    if (!isClientTelemetryEnabled()) return;
    const payload = JSON.stringify({
      events: [{ name, value: 1 }],
    });
    if (typeof navigator !== "undefined" && navigator.sendBeacon) {
      const blob = new Blob([payload], { type: "application/json" });
      if (navigator.sendBeacon(ENDPOINT, blob)) return;
    }
    void fetch(ENDPOINT, {
      method: "POST",
      body: payload,
      headers: { "Content-Type": "application/json" },
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // best-effort — the in-memory counter + console log remain the observable
    // record even if delivery fails.
  }
}

/** Observable tally for tests and the operator debug hook. */
export function getSafetyMetric(name: SafetyMetricName): number {
  return counters.get(name) ?? 0;
}

/** Test-only: clear every counter. */
export function resetSafetyMetricsForTests(): void {
  counters.clear();
}
