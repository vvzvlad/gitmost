// Pure helpers for the AI chat window auto-collapse behavior. Kept free of React
// so they can be unit-tested in isolation (see collapse-helpers.test.ts).

/**
 * Decide whether an outside pointer (mousedown) should collapse the chat window.
 *
 * Returns true only when the pointer target is genuinely "on the page": NOT
 * inside the window element AND NOT inside a Mantine portal. Mantine renders
 * dropdown menus (chat-list kebab), modals (delete-confirm), tooltips and
 * notifications into portals tagged with `data-portal="true"`; clicks on those
 * are part of operating the chat, so they must not collapse it.
 */
export function shouldCollapseOnOutsidePointer(
  target: EventTarget | null,
  windowEl: HTMLElement | null,
): boolean {
  if (!windowEl) return false;
  if (!(target instanceof Element)) return false;
  // Inside the window itself -> not an "away" interaction (drag, resize, typing).
  if (windowEl.contains(target)) return false;
  // Inside a Mantine portal the chat owns (kebab menu, confirm modal, tooltip,
  // notifications). data-portal="true" reliably excludes all of them.
  if (target.closest("[data-portal]")) return false;
  return true;
}

/**
 * Click-vs-drag discrimination for the window header: a press whose pointer
 * moved less than `threshold` px on both axes between mousedown and mouseup is
 * treated as a click (which expands a collapsed window), not a drag (which
 * repositions it).
 */
export function isHeaderClick(
  downX: number,
  downY: number,
  upX: number,
  upY: number,
  threshold = 4,
): boolean {
  return Math.abs(upX - downX) <= threshold && Math.abs(upY - downY) <= threshold;
}
