/**
 * DEV-ONLY entry for the AI chat perf harness (served by the vite dev server at
 * /perf/ai-chat-perf.html; never part of the production build, which uses the
 * single default index.html entry).
 *
 * Mounts the minimal provider stack the real ChatThread needs (Mantine, router
 * for tool-card Links, react-query, i18n) and patches `window.fetch` BEFORE
 * React mounts so ChatThread's DefaultChatTransport requests to
 * /api/ai-chat/stream are answered by the synthetic SSE generator.
 */

import "@mantine/core/styles.css";

import ReactDOM from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { mantineCssResolver, theme } from "../src/theme.ts";
// i18n side-effect init (http-backend). Translations load from /locales in dev;
// missing keys fall back to the key text, which is fine for the harness.
import "../src/i18n.ts";
import { installAiChatStreamFetchPatch } from "./synthetic-turn.ts";
import PerfHarness from "./harness.tsx";

// MUST run before React mounts: ChatThread creates its transport with the
// global fetch, so the patch has to be in place before the first send.
installAiChatStreamFetchPatch();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      retry: false,
      staleTime: 5 * 60 * 1000,
    },
  },
});

const container = document.getElementById("root") as HTMLElement;

ReactDOM.createRoot(container).render(
  <MemoryRouter>
    <MantineProvider theme={theme} cssVariablesResolver={mantineCssResolver}>
      <QueryClientProvider client={queryClient}>
        <PerfHarness />
      </QueryClientProvider>
    </MantineProvider>
  </MemoryRouter>,
);
