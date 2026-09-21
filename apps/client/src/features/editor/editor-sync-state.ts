import { WebSocketStatus } from "@hocuspocus/provider";
import type { DictationUnavailableReason } from "@/features/dictation/dictation-status";

/**
 * The collab document is usable only once the provider is Connected AND has
 * synced (both the local IndexedDB replica and the remote room). Until then the
 * in-browser Y.Doc is empty/stale, so edits would either be dropped or clobber
 * the server's authoritative doc when it finally arrives.
 */
export function isCollabSynced(
  status: WebSocketStatus | string,
  isSynced: boolean,
): boolean {
  return status === WebSocketStatus.Connected && isSynced;
}

/**
 * Whether the page BODY editor may accept edits.
 *
 * TWO independent gates, both required (#564, local-first phase 2):
 *
 * - `!showStatic` — the live (collab-bound) editor is the one on screen.
 * - `isRemoteConfirmed` — the remote collab room confirmed a sync at least once
 *   for THIS page. This is the load-bearing gate: with local-first enabled the
 *   body swaps to the live editor as soon as the LOCAL ydoc is hydrated, i.e.
 *   `!showStatic` becomes true BEFORE any network round-trip. Gating editability
 *   on `!showStatic` alone would therefore make the body editable on top of a
 *   possibly-stale local ydoc — exactly the #218 class (keystrokes landing in a
 *   doc that has not reconciled with the server) plus the data-loss risk of
 *   clobbering newer remote content when the two finally merge. Editability keys
 *   on remote confirmation, never on the swap.
 *
 * Read-only and view modes are still honored via `editable`/`inEditMode`.
 */
export function isBodyEditable(opts: {
  editable: boolean;
  inEditMode: boolean;
  showStatic: boolean;
  isRemoteConfirmed: boolean;
}): boolean {
  return (
    opts.editable &&
    opts.inEditMode &&
    !opts.showStatic &&
    opts.isRemoteConfirmed
  );
}

/**
 * Whether dictation can start and, when it can't, the cause-specific reason the
 * mic button surfaces. Derives editability from `isBodyEditable` (the single,
 * tested gate) so the published `isEditable` can never diverge from the actual
 * body-editable state and make the tooltip lie (#309).
 *
 * The pre-sync reason keys on `isRemoteConfirmed`, NOT on `showStatic`: after an
 * early local-first swap the body is live but still read-only, and answering
 * "read-only" there would be the #309 lie again (the mic is blocked because we
 * are connecting/offline, not because the user lacks permission).
 *
 * `isDisconnected` is the caller's own boolean (collab connection is in the
 * Disconnected state), passed in so this module stays free of the collab enum.
 */
export function computeDictationAvailability(opts: {
  editable: boolean;
  inEditMode: boolean;
  showStatic: boolean;
  isRemoteConfirmed: boolean;
  isDisconnected: boolean;
}): { isEditable: boolean; reason: DictationUnavailableReason | null } {
  const isEditable = isBodyEditable({
    editable: opts.editable,
    inEditMode: opts.inEditMode,
    showStatic: opts.showStatic,
    isRemoteConfirmed: opts.isRemoteConfirmed,
  });
  if (isEditable) return { isEditable, reason: null };
  // Permitted to edit and in edit mode, but the remote room has not confirmed a
  // sync yet: the static pre-sync window, or the local-first read-only window.
  if (opts.editable && opts.inEditMode && !opts.isRemoteConfirmed) {
    return {
      isEditable,
      reason: opts.isDisconnected ? "offline" : "connecting",
    };
  }
  // No edit permission or not in edit mode.
  return { isEditable, reason: "read-only" };
}

/**
 * Whether the body may swap from the static copy to the live (collab-bound)
 * editor (#564).
 *
 * - Flag off (`localFirst === false`) → today's behavior EXACTLY: swap only once
 *   the collab provider is Connected AND both replicas have synced.
 * - Flag on → additionally swap as soon as the LOCAL ydoc is hydrated, but ONLY
 *   if that ydoc actually has content. `IndexeddbPersistence` emits "synced" even
 *   for an EMPTY doc (first visit on this device, or after an IDB purge);
 *   swapping then would replace the server-seeded static copy with an empty live
 *   body until the network answers — a regression against today. So an empty
 *   local ydoc keeps the static copy until remote sync (guard 1).
 */
export function shouldSwapToLive(opts: {
  localFirst: boolean;
  isLocalSynced: boolean;
  ydocNonEmpty: boolean;
  collabSynced: boolean;
}): boolean {
  if (opts.collabSynced) return true;
  if (!opts.localFirst) return false;
  return opts.isLocalSynced && opts.ydocNonEmpty;
}

/**
 * What (if anything) the body tells the user about an un-reconciled state
 * (guard 4 / guard 5).
 *
 * - `"none"`       — nothing to say (remote confirmed, or a reader on a healthy
 *   connection).
 * - `"connecting"` — the quiet, unobtrusive "Connecting… (read-only)" badge.
 *   This is the NORMAL state on every page open (local sync lands in tens of ms,
 *   remote in hundreds), so it must never be alarming.
 * - `"offline"`    — the connection is really down (explicit drop, or the 7500ms
 *   timeout flipped the status to Disconnected) AND what is on screen is the
 *   LOCAL ydoc copy: a page-wide "offline, showing the cached copy" banner.
 *   Page-wide because the chrome (title/icon, from the #563 meta boot cache —
 *   possibly NEWER) and the body (from the ydoc — possibly OLDER) are different
 *   points in time; chrome without an indicator would look authoritative.
 *
 * `showStatic` is checked BEFORE `isDisconnected` on the local-first branch, and
 * that ordering is load-bearing: while the static copy is up, the body on screen
 * is the SERVER-seeded content this page was rendered with (first visit, empty
 * local ydoc, or the ydoc still loading). Saying "you're offline — showing the
 * last copy saved on this device" over server-fresh content is a plain lie, so a
 * dropped socket / the 7500ms timeout in the static window gets the quiet badge,
 * exactly like the flag-off path.
 *
 * With the flag off this collapses to exactly today's rule: the quiet badge, and
 * only inside the static pre-sync window.
 *
 * HYSTERESIS (#641, part 6). Hocuspocus retries forever (`maxAttempts: 0`) and
 * emits `Connecting`/`Disconnected` on EVERY attempt, so over a multi-hour
 * offline session `isDisconnected` flaps and the yellow banner flickers — right
 * before Ф5 makes this banner the PRIMARY offline signal. `stickyOffline` holds
 * "offline" through those flaps: once we are really offline in the live-local
 * window it stays offline until a REAL remote sync (`isRemoteConfirmed`) clears
 * it — never merely until the next momentary `Connecting`. The caller owns the
 * latch (page-editor); this function just honors it.
 */
export type BodyIndicator = "none" | "connecting" | "offline";

export function computeBodyIndicator(opts: {
  localFirst: boolean;
  showStatic: boolean;
  isRemoteConfirmed: boolean;
  isDisconnected: boolean;
  canEdit: boolean;
  stickyOffline?: boolean;
}): BodyIndicator {
  if (!opts.localFirst) {
    return opts.showStatic && opts.canEdit ? "connecting" : "none";
  }
  if (opts.isRemoteConfirmed) return "none";
  // The static (server-seeded) copy is on screen — never claim it is a stale
  // local copy, however dead the socket is.
  if (opts.showStatic) return opts.canEdit ? "connecting" : "none";
  // Live local body, remote not confirmed: "offline" if the socket is down OR the
  // hysteresis latch is set (a mid-session retry blip must not flip us back to the
  // quiet "connecting" badge and flicker the banner).
  if (opts.isDisconnected || opts.stickyOffline) return "offline";
  return opts.canEdit ? "connecting" : "none";
}
