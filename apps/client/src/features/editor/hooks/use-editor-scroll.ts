import { Editor } from "@tiptap/react";
import { useCallback, useEffect, useState } from "react";

const WAIT_INTERVAL_MS = 800;
const WAIT_TIMEOUT_MS = 5000;
// How many times handleScrollTo re-looks-up the target element before giving up.
const MAX_TRY_COUNT = 10;

// Polls `checkFn` until it turns true or `timeoutMs` elapses. The deadline is
// mandatory: without it a predicate that never becomes true leaves a setInterval
// running for the life of the tab, and one leaks per editor construction (this is
// called from the editor's onCreate, and handleScrollTo recurses).
// The deadline is its own setTimeout rather than a clock comparison inside the
// tick: it fires at exactly `timeoutMs` (not quantized up to the next 800 ms
// tick), and it reads no clock at all, so a wall-clock jump can neither extend
// nor truncate the wait. Resolves true when the predicate was satisfied, false on
// timeout; both timers are cleared on every exit path.
function waitForState(
  checkFn: () => boolean,
  timeoutMs: number = WAIT_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    let interval: ReturnType<typeof setInterval> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;

    const finish = (satisfied: boolean) => {
      if (interval !== undefined) clearInterval(interval);
      if (deadline !== undefined) clearTimeout(deadline);
      resolve(satisfied);
    };

    // No immediate pre-check: the original polled first at +800ms and the
    // scroll timing is unchanged on purpose.
    interval = setInterval(() => {
      if (checkFn()) finish(true);
    }, WAIT_INTERVAL_MS);
    deadline = setTimeout(() => finish(false), timeoutMs);
  });
}

export const useEditorScroll = ({
  canScroll,
  initialScrollTo,
}: {
  canScroll: () => boolean;
  initialScrollTo?: string;
}) => {
  const [scrollTo, setScrollTo] = useState<string>(initialScrollTo || "");

  useEffect(() => {
    if (!initialScrollTo) {
      setScrollTo(window.location.hash ? window.location.hash.slice(1) : "");
    }
  }, [initialScrollTo]);

  const handleScrollTo = useCallback(async (editor: Editor, _scrollTo: string | null = null, tryCount: number = 0) => {
    // Resolve the target BEFORE waiting. This runs from the editor's onCreate on
    // every editor construction, and the common case is no hash at all — waiting
    // 800ms (and warning at 5s) for a scroll that has no destination is pure
    // waste. Behavior for a non-empty target is unchanged.
    const targetId = _scrollTo || scrollTo;
    if (!targetId) return false;
    // Same reason: the 11th recursion can only return false, so it must not
    // arm a poll interval and a 5s deadline first.
    if (tryCount >= MAX_TRY_COUNT) return false;

    const ready = await waitForState(() => canScroll());
    // Timed out waiting for the editor to become scrollable — stop instead of
    // recursing, so a never-ready editor cannot spin timers forever. Say so:
    // a deep link that silently never scrolls is exactly the kind of quiet
    // degradation that must stay visible.
    if (!ready) {
      console.warn(
        `[editor-scroll] editor did not become scrollable within ${WAIT_TIMEOUT_MS}ms; ` +
          `skipping scroll to "${targetId}"`,
      );
      return false;
    }
    return new Promise((resolve) => {
      const dom = editor.view.dom.querySelector(`[id="${targetId}"], [data-id="${targetId}"]`);
      if (dom) {
        dom.scrollIntoView({ behavior: 'smooth', block: 'start' });
        resolve(true);
      } else {
        setTimeout(async () => {
          resolve(await handleScrollTo(editor, targetId, tryCount + 1));
        }, 200);
      }
    });
  }, [scrollTo, canScroll]);

  return { scrollTo, handleScrollTo };
};
