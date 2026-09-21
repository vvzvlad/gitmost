export interface ColumnLayout {
  /** Left margin (px) measured from Main's content-box inline-start. */
  left: number;
  /** Column width (px), never exceeding `colMax`. */
  width: number;
}

/**
 * Pin the editor column's LEFT edge to its "panel-closed" centered position, so
 * opening the right aside narrows the column on the RIGHT instead of sliding the
 * whole column leftward (issue #570).
 *
 * @param W           Main's CURRENT content-box width (px). When the aside is
 *                    open on desktop this is already narrowed by Main's
 *                    padding-inline-end; 0 below the breakpoint / when closed.
 * @param asideOffset Px the open aside removes from Main's content box (i.e. the
 *                    amount Main shrank because the panel is open). 0 when the
 *                    panel is closed or is a mobile overlay that reserves no space.
 * @param colMax      Max column width (matches the non-fluid Container `size`).
 * @param asideGap    Gutter (px) kept between the column's right edge and the panel.
 */
export function computeColumnLayout(
  W: number,
  asideOffset: number,
  colMax: number,
  asideGap: number,
): ColumnLayout {
  // Width Main would have if the panel were closed — the reference frame for the
  // "centered" left edge. Because `left` is computed from this closed width, it
  // is identical whether the panel is open or closed: that is why the left edge
  // never moves.
  const wFull = W + asideOffset;
  const left = Math.max(0, (wFull - colMax) / 2);
  // The column surrenders width on the RIGHT: capped at colMax and kept a gap
  // clear of the panel so its right edge never slides under the aside.
  const width = Math.max(
    0,
    Math.min(colMax, W - left - (asideOffset ? asideGap : 0)),
  );
  return { left, width };
}
