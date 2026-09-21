// #348 — debounce window for the per-page RAG re-embed job. Repeated saves
// within this window collapse to a single delayed job (coalesced by a stable
// jobId), so active editing does not pile up expensive re-embeds (external API
// + page_embeddings rewrite, concurrency 1). The worker reads the CURRENT page
// state at run time, so the last content within the window wins.
export const EMBED_DEBOUNCE_MS = 30 * 1000;

/**
 * #370 — page-history intentionality tiers. Domain of `page_history.kind`.
 *   - 'manual' / 'agent'  → Tier 1 versions (intentional points)
 *   - 'idle' / 'boundary' → Tier 0 autosnapshots (safety net)
 * A legacy `null` kind is treated as an autosave.
 */
export type PageHistoryKind = 'manual' | 'agent' | 'idle' | 'boundary';

/**
 * #370 — trailing idle-flush windows. A page's pending idle snapshot is
 * re-armed on every store and fires this long after edits go quiet, so a burst
 * of edits collapses into a single autosnapshot instead of one-per-store. Human
 * sessions are noisier and less risky, so they flush less often than the agent.
 */
export const IDLE_INTERVAL_USER = 60 * 60 * 1000; // 60m
export const IDLE_INTERVAL_AGENT = 15 * 60 * 1000; // 15m

/**
 * #370 — max-wait ceiling for the idle flush. Pure trailing debounce starves the
 * safety net: hocuspocus stores at least every ~45s, so a CONTINUOUS editing
 * session would re-arm the trailing timer forever and never take an idle
 * snapshot until edits finally go quiet (up to IDLE_INTERVAL_USER = 60m). This
 * ceiling bounds the actual wait from the FIRST edit of a burst, so an idle
 * snapshot fires at least this often during a long unbroken session — restoring
 * a recovery point cadence closer to the old heuristic without one-per-store
 * noise. Mirrors hocuspocus's own maxDebounce idea.
 */
export const IDLE_MAX_WAIT_USER = 10 * 60 * 1000; // 10m
export const IDLE_MAX_WAIT_AGENT = 5 * 60 * 1000; // 5m
