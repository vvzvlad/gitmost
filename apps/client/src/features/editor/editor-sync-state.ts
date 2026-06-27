import { WebSocketStatus } from "@hocuspocus/provider";

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
 * `showStatic` is true during the pre-sync window (a read-only static editor is
 * shown). Gating editability on `!showStatic` guarantees the body never becomes
 * editable before the collab doc is synced, so early keystrokes on a freshly
 * created page can't land only in local ProseMirror and then be lost when the
 * server's initial empty doc syncs in (#218). Read-only and view modes are
 * still honored via `editable`/`inEditMode`.
 */
export function isBodyEditable(opts: {
  editable: boolean;
  inEditMode: boolean;
  showStatic: boolean;
}): boolean {
  return opts.editable && opts.inEditMode && !opts.showStatic;
}
