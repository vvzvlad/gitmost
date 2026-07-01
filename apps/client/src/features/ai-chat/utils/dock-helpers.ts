// Pure geometry helper for the AI chat window dock/undock decision (#276). Kept
// free of React and the DOM so it can be unit-tested in isolation (see
// dock-helpers.test.ts). The DOM-reading getNavbarRect() lives in the window
// component; this is only the point-in-rect math that decides dock-on-drop and
// undock-on-drag-out from the measured navbar rect.

export type NavbarRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/**
 * Whether a viewport point (x, y) falls within `rect`. Edges are inclusive so a
 * drop exactly on the navbar boundary counts as "over the navbar". Returns false
 * when the rect is null (navbar absent/collapsed) so the caller falls back to the
 * floating behavior.
 */
export function isPointWithinRect(
  x: number,
  y: number,
  rect: NavbarRect | null,
): boolean {
  if (!rect) return false;
  return (
    x >= rect.left &&
    x <= rect.left + rect.width &&
    y >= rect.top &&
    y <= rect.top + rect.height
  );
}
