// Default lifetime for a temporary note, in HOURS, used when the workspace has
// no `temporaryNoteHours` configured (NULL). Mirrors the trash-cleanup
// DEFAULT_RETENTION_DAYS fallback. After this many hours a temporary note is
// auto-moved to trash unless it was made permanent first.
export const DEFAULT_TEMPORARY_NOTE_HOURS = 24;
