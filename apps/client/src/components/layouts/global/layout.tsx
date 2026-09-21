import { Suspense, useEffect } from "react";
import { UserProvider } from "@/features/user/user-provider.tsx";
import { Outlet, useParams } from "react-router-dom";
import { Center, Loader } from "@mantine/core";
import GlobalAppShell from "@/components/layouts/global/global-app-shell.tsx";
import { SearchSpotlight } from "@/features/search/components/search-spotlight.tsx";
import { useGetSpaceBySlugQuery } from "@/features/space/queries/space-query.ts";

export default function Layout() {
  const { spaceSlug } = useParams();
  const { data: space } = useGetSpaceBySlugQuery(spaceSlug);

  // Warm the (now route-split) editor chunk during idle time on authenticated
  // routes, so the first navigation to a page renders from cache instead of a
  // cold chunk fetch. Best-effort: gated on requestIdleCallback and never blocks
  // startup — the dynamic import mirrors the App.tsx route lazy loader so both
  // resolve to the same chunk.
  useEffect(() => {
    const ric =
      typeof window !== "undefined" && (window as any).requestIdleCallback;
    const warm = () => {
      // Best-effort prefetch: a failed warm-up (offline, stale 404) is harmless
      // and must not surface as an unhandledrejection.
      void import("@/pages/page/page").catch(() => {});
    };
    if (ric) {
      const id = ric(warm);
      return () => (window as any).cancelIdleCallback?.(id);
    }
    const timer = setTimeout(warm, 2000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <UserProvider>
      <GlobalAppShell>
        <Suspense
          fallback={
            <Center h="60vh">
              <Loader size="sm" />
            </Center>
          }
        >
          <Outlet />
        </Suspense>
      </GlobalAppShell>
      <SearchSpotlight spaceId={space?.id} />
    </UserProvider>
  );
}
