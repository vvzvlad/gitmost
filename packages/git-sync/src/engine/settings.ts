/**
 * Engine settings.
 *
 * The engine is driven IN-PROCESS by the NestJS server, which builds the
 * `Settings` object from `EnvironmentService`. This module therefore exposes
 * ONLY the `Settings` type the engine consumes — there is no `.env`-loading
 * side-effecting entry point and no env-validation here (the server owns that).
 */

export type Settings = {
  docmostSpaceId: string;
  vaultPath: string;
  gitRemote?: string;
  pollIntervalMs: number;
  debounceMs: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /**
   * Per-space PUSH policy for a page whose committed body still contains
   * unresolved git conflict markers (`<<<<<<<` / `=======` / `>>>>>>>`):
   *   - false (DEFAULT, SAFE): SKIP that page's push (it is recorded as a push
   *     failure, so refs are NOT advanced) — the user must resolve the git
   *     conflict first before the page reaches Docmost.
   *   - true: strip the marker lines and push BOTH sides' content (the
   *     `stripConflictMarkers` behavior).
   * Optional/undefined is treated as false.
   */
  autoMergeConflicts?: boolean;
};
