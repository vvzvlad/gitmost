/**
 * #370 — page-version stateless wire formats. Kept in one place so the client
 * emitter (Save hotkey / button) and the client listener (page-editor) agree
 * with the server (PersistenceExtension) on the message shapes.
 */

/** Client → server: "save a version now". The server derives the tier
 * (manual/agent) from the signed connection actor, never from this payload. */
export const SAVE_VERSION_MESSAGE_TYPE = "save-version";

/** Server → all clients: a version was saved (or promoted / already existed). */
export const VERSION_SAVED_MESSAGE_TYPE = "version.saved";

export interface VersionSavedMessage {
  type: typeof VERSION_SAVED_MESSAGE_TYPE;
  historyId: string;
  kind: "manual" | "agent";
  /** True when the latest snapshot was already a manual version (a no-op save). */
  alreadySaved: boolean;
}

/**
 * Cross-component coordination flag so only the client that pressed Save shows
 * the confirmation toast, while every other client silently refreshes its
 * history panel on the broadcast. A module-level ref avoids stale-closure
 * pitfalls in the editor's long-lived stateless handler.
 */
export const saveVersionPending = { current: false };
