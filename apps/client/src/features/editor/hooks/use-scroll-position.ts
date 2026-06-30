import { useCallback, useEffect, useRef } from "react";

// Throttle interval for persisting the scroll position while the user reads.
const SAVE_THROTTLE_MS = 250;
// Give up polling for the live content height after this long and restore to
// the furthest reachable position (handles "collab never finishes laying out").
const MAX_RESTORE_WAIT_MS = 5000;
// How often to re-check the document height while waiting for content to load.
const RESTORE_POLL_MS = 100;

// sessionStorage key prefix. sessionStorage survives an F5 in the same tab and
// is cleared on tab close, which is exactly the lifetime we want for an MVP
// "remember where I was reading" feature (self-limiting, no cross-tab leak).
const STORAGE_PREFIX = "gitmost:scroll-position:";

function storageKey(pageId: string): string {
  return `${STORAGE_PREFIX}${pageId}`;
}

// All storage access is wrapped: private mode / quota / disabled storage must
// never throw out of the hook and break the page.
function readStorage(pageId: string): number | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey(pageId));
    if (raw === null) return null;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? value : null;
  } catch (err) {
    // Best-effort feature: storage may be unavailable (private mode / quota).
    // No user-facing notification (a missed scroll restore is not actionable),
    // but log per the AGENTS.md "errors must never be swallowed" rule.
    console.warn("[useScrollPosition] sessionStorage read failed", err);
    return null;
  }
}

function writeStorage(pageId: string, scrollY: number): void {
  try {
    window.sessionStorage.setItem(storageKey(pageId), String(Math.round(scrollY)));
  } catch (err) {
    // Storage unavailable (private mode / quota). Non-actionable for the user,
    // but log it rather than swallow silently (AGENTS.md error-handling rule).
    console.warn("[useScrollPosition] sessionStorage write failed", err);
  }
}

/**
 * Persists and restores the window scroll position per page so a reader keeps
 * their place across a reload (F5) or reopening the document.
 *
 * Returns `restoreScrollPosition`, which the page editor calls once the live
 * (non-static) content is laid out. The two scroll mechanisms are mutually
 * exclusive: if the URL has a `#hash` anchor, the existing anchor-scroll logic
 * wins and restore is a no-op.
 */
export function useScrollPosition(pageId: string): {
  restoreScrollPosition: () => void;
} {
  // CONTRACT: this hook assumes PageEditor REMOUNTS per page — page.tsx renders
  // `<MemoizedFullEditor key={page.id} ...>`, so switching pages creates a fresh
  // hook instance with fresh refs. These refs latch per-mount and are NOT reset
  // when `pageId` changes in place (only the effect re-runs on [pageId]). If that
  // `key={page.id}` is ever removed, restore would silently break on the 2nd page
  // (refs would hold the first page's target / already-restored flag) — in that
  // case the refs must be reset on a pageId change.
  //
  // The target Y captured synchronously at mount, BEFORE any scroll/visibility
  // handler can overwrite the stored value with a fresh 0 (the page starts
  // scrolled to top on load). `null` means "not yet captured".
  const initialTargetRef = useRef<number | null>(null);
  // Guards so restore runs at most once per page mount.
  const hasRestoredRef = useRef(false);
  // Holds the in-flight restore poll timer so the cleanup can cancel it: without
  // this, a fast SPA navigation away mid-poll would let the old page's poll fire
  // window.scrollTo against the NEW page's document (visible wrong-page scroll).
  const pollTimerRef = useRef<number | null>(null);

  // Capture the previously-saved value synchronously during render, before the
  // effect below registers handlers that would persist the current (0) scrollY.
  if (initialTargetRef.current === null) {
    const saved = readStorage(pageId);
    // Store 0 when nothing is saved so the "already captured" check (!== null)
    // holds; restore treats targetY <= 0 as a no-op anyway.
    initialTargetRef.current = saved ?? 0;
  }

  useEffect(() => {
    let throttleTimer: number | null = null;

    const save = () => {
      writeStorage(pageId, window.scrollY);
    };

    // Throttle the high-frequency scroll handler: persist immediately on the
    // leading edge, then at most once per SAVE_THROTTLE_MS.
    const onScroll = () => {
      if (throttleTimer !== null) return;
      save();
      throttleTimer = window.setTimeout(() => {
        throttleTimer = null;
      }, SAVE_THROTTLE_MS);
    };

    // pagehide fires on reload/navigation (more reliable than unload); save now.
    const onPageHide = () => {
      save();
    };

    // Save when the tab is being backgrounded — covers mobile where pagehide is
    // not always emitted.
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        save();
      }
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (throttleTimer !== null) {
        window.clearTimeout(throttleTimer);
        throttleTimer = null;
      }
      // Cancel any in-flight restore poll so it cannot scroll the next page.
      if (pollTimerRef.current !== null) {
        window.clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      // SPA navigation away from this page: persist the final position.
      save();
    };
  }, [pageId]);

  const restoreScrollPosition = useCallback(() => {
    // Run at most once per page mount.
    if (hasRestoredRef.current) return;
    hasRestoredRef.current = true;

    // Anchor priority: a `#hash` in the URL is handled by useEditorScroll.
    if (window.location.hash) return;

    const targetY = initialTargetRef.current ?? 0;
    // Nothing meaningful to restore to.
    if (targetY <= 0) return;

    const start = Date.now();

    const tryRestore = () => {
      const maxScroll =
        document.documentElement.scrollHeight - window.innerHeight;
      const timedOut = Date.now() - start >= MAX_RESTORE_WAIT_MS;

      // Restore once the content is tall enough to reach the target, or bail out
      // after the timeout and scroll as far as currently possible.
      if (maxScroll >= targetY || timedOut) {
        window.scrollTo({
          top: Math.min(targetY, Math.max(maxScroll, 0)),
          behavior: "auto",
        });
        pollTimerRef.current = null;
        return;
      }

      // Stored in a ref so the effect cleanup can cancel it on unmount.
      pollTimerRef.current = window.setTimeout(tryRestore, RESTORE_POLL_MS);
    };

    tryRestore();
  }, []);

  return { restoreScrollPosition };
}
