/**
 * The client seam. `pull.ts`/`push.ts` depend on a narrow STRUCTURAL interface
 * rather than any concrete client, because the gitmost server writes NATIVELY —
 * through repositories + collab `openDirectConnection`.
 *
 * `GitSyncClient` is that interface: the native datasource (server side)
 * implements it, and the engine only ever uses `Pick<GitSyncClient, ...>`
 * subsets of it. The signatures below MIRROR exactly the methods the engine's
 * `pull.ts`/`push.ts` actually call (arg shapes + the fields the engine reads
 * off each result), so a REST-style client is still structurally assignable and
 * the native adapter has a precise contract.
 */
export {};
