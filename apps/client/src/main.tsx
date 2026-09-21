import "@mantine/core/styles.css";
import "@mantine/spotlight/styles.css";
import "@mantine/notifications/styles.css";
import "@mantine/dates/styles.css";
import "@/styles/a11y-overrides.css";
import "@/styles/notification-overrides.css";

import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import { mantineCssResolver, theme } from "@/theme";
import { MantineProvider } from "@mantine/core";
import { BrowserRouter } from "react-router-dom";
import { ModalsProvider } from "@mantine/modals";
import { Notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HelmetProvider } from "react-helmet-async";
import { ChunkLoadErrorBoundary } from "@/components/chunk-load-error-boundary.tsx";
import "./i18n";
import {
  getPostHogHost,
  getPostHogKey,
  isCloud,
  isPostHogEnabled,
} from "@/lib/config.ts";
import { initVitals } from "@/lib/telemetry/vitals";
import { installPageMetaEviction } from "@/features/page/atoms/page-meta-cache-atom";
import {
  installPageYdocEvictionOnce,
  migratePageYdocDatabasesOnce,
} from "@/features/editor/page-ydoc-eviction";
import { enforceOfflineSessionBoundary } from "@/features/user/session-boundary";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      retry: false,
      staleTime: 5 * 60 * 1000,
    },
  },
});

// #564 — destroy a page's LOCAL YDOC (its body, on disk in IndexedDB) as soon as
// ANY page query fails with 403/404. Installed at APP level and BEFORE the
// page-meta eviction below, for two load-bearing reasons:
//  - the case this guard exists for (a revoked page opened in a fresh session)
//    renders not-found and NEVER mounts the page editor, so installing it from
//    the editor would mean the 403 is never heard;
//  - it resolves a slugId to its pageId through the page-meta boot cache, which
//    installPageMetaEviction() deletes on the very same event. Query-cache
//    listeners run in registration order, so this one must read the alias first.
installPageYdocEvictionOnce(queryClient);

// #626 / #640 — one-time cleanup of the pre-namespacing legacy `page.<pageId>`
// ydoc databases (they had no workspace/user scope, so a shared browser could
// serve one user's local page body to the next). Runs once (localStorage-
// flagged) and only deletes un-namespaced databases, never the current user's
// scoped ones. MUST run BEFORE the session-boundary enforcement below clears the
// page-meta boot cache, because on Firefox the migration derives the legacy
// names from that cache (there is no `indexedDB.databases()` there).
migratePageYdocDatabasesOnce();

// #640, part 6 — network-independent session boundary. If the last successful
// `/me` (sessionVerifiedAt) is older than OFFLINE_GRACE (=30d = JWT token life),
// refuse to draw ANY local content and purge it — offline or not. Runs at boot,
// before the first render, so nothing stale is ever painted. This is the only
// safeguard that needs no network event and the thing that makes Ф5 safe.
enforceOfflineSessionBoundary();

// #563 — evict a page from the localStorage boot cache as soon as ANY page query
// fails with 403/404 (deleted / access revoked), regardless of what is mounted.
// Without this, a revoked page would keep painting stale chrome from the cache
// on every subsequent visit.
installPageMetaEviction(queryClient);

// #355 — client perf-telemetry. Decides sampling ONCE (25%/session) before
// subscribing to any observer; non-sampled sessions send nothing.
initVitals();

const container = document.getElementById("root") as HTMLElement;
const root = ((container as any).__reactRoot ??=
  ReactDOM.createRoot(container));

function renderApp() {
  root.render(
    <BrowserRouter>
      <MantineProvider theme={theme} cssVariablesResolver={mantineCssResolver}>
        <ModalsProvider>
          <QueryClientProvider client={queryClient}>
            {/* top-center: toasts sit in the top of the viewport, in the line
                of sight, and no longer cover centered content (e.g. "Load
                more"). The below-chrome vertical offset is applied via a
                position-scoped CSS rule in notification-overrides.css (NOT an
                inline `style`): Mantine renders all six position containers at
                once and an inline root style would land on every one, giving the
                bottom-* containers both top+bottom → full-viewport transparent
                overlays that swallow clicks. */}
            <Notifications position="top-center" limit={3} zIndex={10000} />
            <HelmetProvider>
              {/* Root boundary above every lazy route's Suspense: a stale-chunk
                  404 after a deploy is caught and recovered here instead of
                  blanking the whole app. */}
              <ChunkLoadErrorBoundary>
                <App />
              </ChunkLoadErrorBoundary>
            </HelmetProvider>
          </QueryClientProvider>
        </ModalsProvider>
      </MantineProvider>
    </BrowserRouter>,
  );
}

async function initAnalytics() {
  // posthog-js is only pulled in for cloud deployments with analytics enabled, so
  // self-hosted builds never download it. The gate is kept identical to the
  // previous eager code so cloud analytics behavior is unchanged; the import is
  // simply deferred behind it.
  //
  // Crucially this runs AFTER the immediate first render below, so first paint is
  // never gated on the analytics chunk. Any failure (network, stale 404, or an
  // ad-blocker blocking a chunk named "posthog") is swallowed so the user keeps a
  // working app without analytics instead of a permanently blank page.
  //
  // NOTE: we init the posthog SINGLETON only and do NOT wrap the tree in
  // <PostHogProvider>. The app has zero consumers of the PostHog React context
  // (no usePostHog / useFeatureFlag* / PostHogFeature), and PostHogProvider given
  // an already-initialized `client` is a no-op — all capture goes through the
  // singleton. Re-rendering to attach the provider would only REMOUNT the whole
  // App (running every mount effect twice and dropping local state / focus /
  // in-progress input on cloud cold-load) for no functional gain.
  if (!(isCloud() && isPostHogEnabled)) return;
  try {
    const { default: posthog } = await import("posthog-js");
    posthog.init(getPostHogKey(), {
      api_host: getPostHogHost(),
      defaults: "2025-05-24",
      disable_session_recording: true,
      capture_pageleave: false,
    });
  } catch {
    // Analytics failed to load — degrade gracefully; the app already rendered.
  }
}

// Paint immediately for everyone (self-hosted stays exactly as instant as before,
// cloud no longer blocks on the analytics import). The posthog singleton is
// initialized after, without re-rendering the tree.
renderApp();
void initAnalytics();
