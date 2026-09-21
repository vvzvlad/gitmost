import { useEffect, useRef } from "react";
import type { Editor } from "@tiptap/react";
import { hasSavedReadingPosition } from "./use-scroll-position";

// Delay before auto-focusing the title on load — guards a tiptap init race
// ("Cannot access view['hasFocus']" if focused too early).
const TITLE_AUTOFOCUS_DELAY_MS = 300;

/**
 * Auto-focus the page title shortly after mount — UNLESS a saved reading position
 * will be restored (then the viewport scrolls away from the top, and focusing the
 * top-of-page title would drop the caret off-screen). When it does focus, it uses
 * `{ scrollIntoView: false }` so placing the caret never moves the viewport
 * (tiptap's focus scrolls the focused node into view by default, which otherwise
 * yanks the window to the top and fights scroll-position restoration).
 *
 * Extracted from TitleEditor so this exact decision is unit-testable.
 *
 * CONTRACT: relies on TitleEditor remounting per page (page.tsx renders
 * `<MemoizedFullEditor key={page.id}>`), so `hasSavedScrollRef` is captured fresh
 * per page. It is read synchronously on first render, before any scroll-save
 * handler can clobber the stored value to 0 — matching `useScrollPosition`'s own
 * synchronous capture of `initialTargetRef`.
 */
export function useTitleAutofocus(
  titleEditor: Editor | null,
  pageId: string,
  // Ф7 (#643) — do NOT focus until the LIVE title has resolved. Mounted on
  // cached meta (local-first phase 7), an autofocus at 300ms would put the field
  // in focus BEFORE `/pages/info` lands; the title-editor's setContent effect
  // then skips (it never overwrites a focused field), so the cached/placeholder
  // title stays put and a navigate-away can persist it over the real one (title
  // erasure). Gating focus on resolution keeps the field un-focused when the live
  // title arrives, so setContent applies it. Flag OFF: always `true` (unchanged).
  resolved: boolean = true,
): void {
  const hasSavedScrollRef = useRef<boolean | null>(null);
  if (hasSavedScrollRef.current === null) {
    hasSavedScrollRef.current = hasSavedReadingPosition(pageId);
  }

  useEffect(() => {
    if (hasSavedScrollRef.current) return;
    if (!resolved) return;
    const timer = setTimeout(() => {
      // guard against "Cannot access view['hasFocus']" before init
      if (!titleEditor?.isInitialized) return;
      titleEditor?.commands?.focus("end", { scrollIntoView: false });
    }, TITLE_AUTOFOCUS_DELAY_MS);
    // Clear the pending focus if the editor changes or the component unmounts
    // (also fixes the previously-uncancelled timer).
    return () => clearTimeout(timer);
  }, [titleEditor, resolved]);
}
