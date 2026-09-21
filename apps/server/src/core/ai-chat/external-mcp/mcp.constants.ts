/**
 * Shared constants for the external-MCP layer (#686). Kept in one place so the
 * admin path, the personal `account/mcp-servers` path, the per-user cache keys,
 * and the observability/tooling-block builder all agree on the same budgets.
 */

/**
 * Separator between the workspace id and the user id in a per-user MCP cache
 * key (`${workspaceId}${CACHE_KEY_SEP}${userId}`). A NUL byte can never appear
 * in a UUID, so it is an unambiguous delimiter (no id can contain it) and a
 * safe prefix boundary for the `${workspaceId}\0` fan-out that invalidates all
 * of a workspace's per-user cache entries at once.
 */
export const CACHE_KEY_SEP = '\0';

/**
 * Byte budget (ARCH INVARIANT #1) for the admin-first external-MCP tooling
 * guidance block spliced into the agent system prompt. The block is truncated
 * to this many characters so a workspace with many servers (admin + personal)
 * cannot blow the model context window.
 */
export const MCP_TOOLING_BLOCK_MAX = 16000;

/**
 * Cap on the number of external-MCP connection-failure records surfaced per
 * turn (ARCH INVARIANT #1). Older failures beyond this are dropped so the
 * delivered failure list stays bounded.
 */
export const MCP_FAILURES_CAP = 10;

/**
 * Max length (characters) of a single external-MCP failure reason string
 * before it is truncated. Keeps one hostile/verbose provider error from
 * dominating the failure payload.
 */
export const MCP_FAILURE_REASON_MAX = 200;
