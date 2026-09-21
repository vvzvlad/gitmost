import { ReactNode } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { Button, Center, Stack, Text } from "@mantine/core";
import {
  hasAutoReloaded,
  markAutoReloaded,
  recordReloadBreadcrumb,
} from "@/lib/reload-guard";

// Heuristic detection of a failed dynamic import. Since the code-splitting work,
// every route (plus Aside / AiChatWindow) is React.lazy: when a new deploy
// replaces the hashed chunks, a tab left open on the old index.html requests a
// chunk URL that now 404s, and React.lazy rejects. Browsers / Vite surface these
// with a ChunkLoadError name or one of these messages.
export function isChunkLoadError(error: unknown): boolean {
  if (!error) return false;
  const name = (error as { name?: string }).name ?? "";
  const message = (error as { message?: string }).message ?? "";
  return (
    name === "ChunkLoadError" ||
    /Failed to fetch dynamically imported module/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /Importing a module script failed/i.test(message)
  );
}

// Exported for tests: the reactive chunk-load reload decision, so the shared
// window budget (invariant: ≤1 auto-reload per window across this path AND the
// proactive version-coherence path) can be exercised against the real guard.
export function handleError(error: unknown) {
  if (!isChunkLoadError(error)) return;
  // A stale-chunk 404 is cured by a full reload that re-fetches index.html and
  // the new chunk manifest. Auto-reload at most once per window via the SHARED
  // window-based reload guard (see @/lib/reload-guard — the same budget the
  // proactive version-coherence path consumes, so a mismatch that arrives on
  // both paths reloads at most once per window across BOTH). This recovers
  // across multiple deploys in a single tab's lifetime, yet a permanently-broken
  // lazy chunk (which would loop) is stopped after the first reload and falls
  // through to the manual recovery UI below. If the shared budget is already
  // spent this window, or the stamp write fails (storage unavailable), we return
  // without reloading rather than risk a loop.
  if (hasAutoReloaded()) return;
  if (!markAutoReloaded()) return;
  // Trace before the reload clears the console (same diagnostic breadcrumb the
  // proactive version-coherence path writes, tagged with this path).
  recordReloadBreadcrumb({ path: "chunk-boundary" });
  window.location.reload();
}

// Root-level boundary that sits ABOVE every route-level Suspense boundary so a
// lazy route/component chunk failure is caught here instead of unmounting the
// whole tree into a blank white screen. Per-feature ErrorBoundaries (page.tsx,
// transclusion, page-embed) remain in place underneath for their local errors.
export function ChunkLoadErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary
      onError={handleError}
      fallbackRender={({ error }) => {
        const chunk = isChunkLoadError(error);
        return (
          <Center h="100vh" p="md">
            <Stack align="center" gap="sm" maw={420}>
              <Text fw={600}>
                {chunk ? "A new version is available" : "Something went wrong"}
              </Text>
              <Text size="sm" c="dimmed" ta="center">
                {chunk
                  ? "Please reload the page to load the latest version."
                  : "An unexpected error occurred. Reloading the page may help."}
              </Text>
              <Button onClick={() => window.location.reload()}>Reload</Button>
            </Stack>
          </Center>
        );
      }}
    >
      {children}
    </ErrorBoundary>
  );
}
