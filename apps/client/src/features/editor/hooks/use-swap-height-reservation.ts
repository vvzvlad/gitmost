import { RefObject, useCallback, useEffect, useState } from "react";

// Last-resort release deadline. The primary release is the live-content height
// match below; this cap only exists so a slow/short live doc can never pin the
// reservation forever. It is generous (well past when the live content normally
// reaches the reserved height — it renders the SAME content as the static copy)
// so a slow load doesn't release mid-render and reintroduce the collapse.
const RELEASE_CAP_MS = 4000;

// #564 — release tolerance for an EARLY (local-first) swap, where the live doc
// comes from the local ydoc and may legitimately be a little shorter than the
// server-seeded static copy. Must stay high enough that a document collapsed to
// a fraction of its height (unloaded images / embeds) does NOT release.
export const EARLY_SWAP_RELEASE_RATIO = 0.8;

/**
 * Reserves the document height across the static -> live editor swap.
 *
 * The live editor lays out its content over a few frames, so replacing the
 * (full-height) static copy with it momentarily shrinks the document; the
 * browser then clamps window scroll to the top, which yanked the reader off
 * their restored reading position (and threw their scroll to 0 if they were
 * scrolling at that moment). Pinning a min-height on the swap wrapper keeps the
 * document tall through the swap so the scroll position simply survives (#266).
 * `reservedHeight === null` means no reservation is active.
 *
 * The capture is intentionally a CALLBACK the page editor invokes, NOT something
 * this hook derives by watching `showStatic`. The height MUST be read
 * synchronously while the static content is still mounted (full natural height),
 * right before the flip to the live branch. By the time any post-transition
 * effect here could run, `showStatic` is already false and the wrapper shows the
 * live/collapsed content, so `offsetHeight` would be wrong. So page-editor calls
 * `captureReservation(wrapper.offsetHeight)` inside its collab-sync effect,
 * before `setShowStatic(false)`, preserving that exact timing.
 *
 * @param showStatic       whether the static (cached) content is still shown.
 * @param menuContainerRef the live-branch content container. It is a descendant
 *   of the swap wrapper inside the live branch, so its `scrollHeight` is the live
 *   content height (not inflated by the ancestor min-height reservation).
 */
export function useSwapHeightReservation(
  showStatic: boolean,
  menuContainerRef: RefObject<HTMLElement | null>,
  earlySwap: boolean = false,
): {
  reservedHeight: number | null;
  captureReservation: (height: number | null) => void;
} {
  const [reservedHeight, setReservedHeight] = useState<number | null>(null);

  // Capture the current (static, full-height) content height BEFORE the swap so
  // the wrapper can reserve it while the live editor lays out — otherwise the
  // transient shrink clamps window scroll to the top. The caller reads
  // `offsetHeight` synchronously at the swap point and hands it here.
  const captureReservation = useCallback(
    (height: number | null) => setReservedHeight(height),
    [],
  );

  // Release the reserved height once the live editor's content has laid out to
  // at least the reserved height (so removing the reservation cannot collapse
  // the document). The primary release is that height match; the cap is only a
  // last-resort so we never pin forever. A shorter-than-reserved live doc (rare:
  // stale/longer cache) releases at the cap, leaving only harmless bottom dead
  // space until then.
  // `earlySwap` (#564, guard 6): with local-first the swap happens hundreds of ms
  // EARLIER, from the local ydoc — whose content may legitimately differ in
  // height from the (network-seeded) static copy. Demanding an exact match would
  // then pin the reservation until the 4s cap and leave dead space under the
  // body, so the early-swap rule releases at a TOLERANCE of the reserved height.
  //
  // The tolerance is deliberately NOT "any non-zero height": the live editor's
  // first laid-out frame can be a small fraction of the static copy (lazy images,
  // excalidraw / drawio / page-embed nodes all measure to ~0 until they load), and
  // releasing there would collapse the document and clamp the scroll to the top —
  // precisely the bug the reservation exists to prevent. Releasing at 80% keeps
  // the guard meaningful while tolerating a legitimately-shorter local copy; a
  // still-shorter one falls back to the 4s cap, as before.
  useEffect(() => {
    if (showStatic || reservedHeight == null) return;
    let raf = 0;
    const startedAt = Date.now();
    const check = () => {
      const liveHeight = menuContainerRef.current?.scrollHeight ?? 0;
      const target = earlySwap
        ? reservedHeight * EARLY_SWAP_RELEASE_RATIO
        : reservedHeight;
      const laidOut = liveHeight > 0 && liveHeight >= target;
      if (laidOut || Date.now() - startedAt > RELEASE_CAP_MS) {
        setReservedHeight(null);
        return;
      }
      raf = requestAnimationFrame(check);
    };
    raf = requestAnimationFrame(check);
    return () => cancelAnimationFrame(raf);
  }, [showStatic, reservedHeight, menuContainerRef, earlySwap]);

  return { reservedHeight, captureReservation };
}
