// Single source of truth for the anonymous blob-sandbox route. The controller
// is mounted under the global `/api` prefix, so its decorator uses the bare
// segment while the public URL and the workspace-gate exclusion need the full
// path — derive the latter from the former so the two never drift.
export const SANDBOX_ROUTE_SEGMENT = 'sb';
export const SANDBOX_API_PATH = `/api/${SANDBOX_ROUTE_SEGMENT}`;
