import { createSpotlight } from '@mantine/spotlight';
import { isVitalsActive, reportOperation } from '@/lib/telemetry/vitals';

export const [searchSpotlightStore, searchSpotlight] = createSpotlight();

export const [shareSearchSpotlightStore, shareSearchSpotlight] =
  createSpotlight();

// #683 `spotlight_open` — measure the search-palette open→paint latency
// (double-rAF render→paint, Pattern B). This is the bounded cost of opening the
// surface; the wait for query RESULTS is measured separately as `search_full`
// in SearchSpotlight, so open latency is never inflated by the user's typing/
// think time (the same unbounded-idle trap #639 guards for page opens). Gated on
// isVitalsActive() so a disabled/non-sampled session schedules no rAF work.
function measureSpotlightOpen(): void {
  if (!isVitalsActive()) return;
  try {
    const start = performance.now();
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        reportOperation('spotlight_open', performance.now() - start),
      ),
    );
  } catch {
    // requestAnimationFrame/performance unavailable (SSR/tests): telemetry is
    // best-effort, so skip silently rather than throw into the open path.
  }
}

/** Open the main search palette and measure `spotlight_open` (#683). */
export function openSearchSpotlight(): void {
  measureSpotlightOpen();
  searchSpotlight.open();
}

/** Open the share-page search palette and measure `spotlight_open` (#683). */
export function openShareSearchSpotlight(): void {
  measureSpotlightOpen();
  shareSearchSpotlight.open();
}
