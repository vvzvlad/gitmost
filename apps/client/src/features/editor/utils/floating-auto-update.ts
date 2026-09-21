/**
 * Shared `autoUpdate` options for every floating-ui anchor in the editor.
 *
 * WHY `layoutShift: false` (Safari 100% CPU burn):
 *
 * `@floating-ui/dom`'s `autoUpdate` defaults `layoutShift: true`, which starts
 * `observeMove()`. That helper watches the reference element by REBUILDING an
 * `IntersectionObserver` over and over: each iteration derives a `rootMargin`
 * from a `floor()`-quantized `getBoundingClientRect()`, and the loop only stops
 * when two consecutive `intersectionRatio` values are EXACTLY equal (float
 * equality). Every iteration costs a forced layout + `computePosition()` (with
 * `hide()`, which walks the clipping ancestors) + a React re-render.
 *
 * Our references are the worst case for that convergence: table cells in a
 * `table-layout: fixed; width: 100%` table inside `.tableWrapper
 * { overflow-x: auto }` (so they are partially clipped), in columns whose width
 * is a fractional px value. WebKit's ratio computation does not settle there,
 * Blink's does — and the partial-clip path has no throttle at all (only the
 * fully-clipped `ratio === 0` branch gets a 1s timeout). Result: an endless
 * layout/render loop pinning one core, Safari-only.
 *
 * WHAT WE GIVE UP (honestly): the remaining `autoUpdate` observers do NOT
 * cover every way a reference can move. `ancestorScroll` / `ancestorResize`
 * listen for scroll/resize on the overflow ancestors, and `elementResize`
 * puts a ResizeObserver on the reference and floating elements — there is NO
 * DOM-mutation observer in `autoUpdate` at all. A reference that MOVES
 * without resizing is caught by nothing except `layoutShift`/`observeMove`.
 * So a remote collaborator inserting a paragraph above the table, an image
 * above the table finishing its load, or a `<details>` expanding will shift
 * the cell and leave the handle/popover at a stale position — until the next
 * scroll, resize, pointermove or selection update.
 *
 * WHY THAT IS ACCEPTABLE: the staleness is bounded and self-correcting. The
 * table handles are re-derived from `pointermove` and `selectionUpdate`
 * anyway (see `dnd-extension.ts`), which is exactly the interaction that
 * would make a misplaced handle matter. We trade a rare, transient
 * mispositioning for removing a permanent one-core spin.
 *
 * SCOPE NOTE: the slash-menu, emoji-menu and mention anchors pass a VIRTUAL
 * element with no `contextElement`, so `observeMove` never ran for them in
 * the first place — the option there is consistency, not a fix. The
 * load-bearing sites are the three table handles and the footnote popover.
 */
export const EDITOR_AUTO_UPDATE_OPTIONS = { layoutShift: false } as const;
