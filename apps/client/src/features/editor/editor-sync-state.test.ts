import { describe, it, expect } from "vitest";
import { WebSocketStatus } from "@hocuspocus/provider";
import {
  isCollabSynced,
  isBodyEditable,
  computeDictationAvailability,
  shouldSwapToLive,
  computeBodyIndicator,
} from "./editor-sync-state";

describe("isCollabSynced", () => {
  it("is true only when Connected and synced", () => {
    expect(isCollabSynced(WebSocketStatus.Connected, true)).toBe(true);
  });

  it("is false while connecting or not yet synced", () => {
    expect(isCollabSynced(WebSocketStatus.Connecting, true)).toBe(false);
    expect(isCollabSynced(WebSocketStatus.Connected, false)).toBe(false);
    expect(isCollabSynced(WebSocketStatus.Disconnected, true)).toBe(false);
  });
});

describe("isBodyEditable (pre-sync data-loss gate, #218 / #564 guard 2)", () => {
  const base = {
    editable: true,
    inEditMode: true,
    showStatic: false,
    isRemoteConfirmed: true,
  };

  it("allows editing only after the static (pre-sync) phase ends", () => {
    expect(isBodyEditable(base)).toBe(true);
  });

  it("never editable while the static read-only editor is shown", () => {
    expect(isBodyEditable({ ...base, showStatic: true })).toBe(false);
  });

  // #564: the live body can be on screen (local-first swap) long before the
  // remote room confirms. That window MUST stay read-only.
  it("never editable in the local-first window (live body, remote not confirmed)", () => {
    expect(isBodyEditable({ ...base, isRemoteConfirmed: false })).toBe(false);
  });

  it("honors read-only and view mode", () => {
    expect(isBodyEditable({ ...base, editable: false })).toBe(false);
    expect(isBodyEditable({ ...base, inEditMode: false })).toBe(false);
  });
});

describe("computeDictationAvailability (mic reason precedence, #309)", () => {
  const base = {
    editable: true,
    inEditMode: true,
    showStatic: false,
    isRemoteConfirmed: true,
    isDisconnected: false,
  };

  it("is available with no reason once synced", () => {
    expect(computeDictationAvailability(base)).toEqual({
      isEditable: true,
      reason: null,
    });
  });

  it("reports 'offline' during pre-sync while disconnected", () => {
    expect(
      computeDictationAvailability({
        ...base,
        showStatic: true,
        isRemoteConfirmed: false,
        isDisconnected: true,
      }),
    ).toEqual({ isEditable: false, reason: "offline" });
  });

  it("reports 'connecting' during pre-sync while still connecting", () => {
    expect(
      computeDictationAvailability({
        ...base,
        showStatic: true,
        isRemoteConfirmed: false,
        isDisconnected: false,
      }),
    ).toEqual({ isEditable: false, reason: "connecting" });
  });

  // #564 / #309: after the early local-first swap the body is LIVE but still
  // read-only. The mic must say "connecting"/"offline" — saying "read-only" here
  // would be the #309 lie (the user does have edit permission).
  it("reports 'connecting', not 'read-only', in the local-first live window", () => {
    expect(
      computeDictationAvailability({
        ...base,
        showStatic: false,
        isRemoteConfirmed: false,
        isDisconnected: false,
      }),
    ).toEqual({ isEditable: false, reason: "connecting" });
  });

  it("reports 'offline' in the local-first live window when disconnected", () => {
    expect(
      computeDictationAvailability({
        ...base,
        showStatic: false,
        isRemoteConfirmed: false,
        isDisconnected: true,
      }),
    ).toEqual({ isEditable: false, reason: "offline" });
  });

  it("reports 'read-only' without edit permission", () => {
    expect(computeDictationAvailability({ ...base, editable: false })).toEqual({
      isEditable: false,
      reason: "read-only",
    });
  });

  it("reports 'read-only' when not in edit mode", () => {
    expect(
      computeDictationAvailability({ ...base, inEditMode: false }),
    ).toEqual({ isEditable: false, reason: "read-only" });
  });

  // Lack of edit permission takes precedence over the pre-sync reason: a
  // read-only viewer who is ALSO inside the pre-sync window must still read
  // "read-only", never "offline"/"connecting".
  it("prefers 'read-only' over pre-sync when a read-only viewer is disconnected", () => {
    expect(
      computeDictationAvailability({
        editable: false,
        inEditMode: true,
        showStatic: true,
        isRemoteConfirmed: false,
        isDisconnected: true,
      }),
    ).toEqual({ isEditable: false, reason: "read-only" });
  });

  it("prefers 'read-only' over pre-sync when a read-only viewer is still connecting", () => {
    expect(
      computeDictationAvailability({
        editable: false,
        inEditMode: true,
        showStatic: true,
        isRemoteConfirmed: false,
        isDisconnected: false,
      }),
    ).toEqual({ isEditable: false, reason: "read-only" });
  });
});

describe("shouldSwapToLive (#564 guard 1)", () => {
  const base = {
    localFirst: true,
    isLocalSynced: false,
    ydocNonEmpty: false,
    collabSynced: false,
  };

  it("swaps once the collab provider is connected+synced (today's rule)", () => {
    expect(shouldSwapToLive({ ...base, collabSynced: true })).toBe(true);
    expect(
      shouldSwapToLive({ ...base, localFirst: false, collabSynced: true }),
    ).toBe(true);
  });

  it("swaps early on a NON-EMPTY local ydoc when local-first is on", () => {
    expect(
      shouldSwapToLive({ ...base, isLocalSynced: true, ydocNonEmpty: true }),
    ).toBe(true);
  });

  // The blank-body regression this guard exists for: y-indexeddb emits "synced"
  // for an empty doc too (first visit on this device / after an IDB purge).
  it("does NOT swap on an EMPTY local ydoc — the static copy stays until remote", () => {
    expect(
      shouldSwapToLive({ ...base, isLocalSynced: true, ydocNonEmpty: false }),
    ).toBe(false);
  });

  it("flag off: a non-empty local ydoc alone never swaps (byte-identical to today)", () => {
    expect(
      shouldSwapToLive({
        localFirst: false,
        isLocalSynced: true,
        ydocNonEmpty: true,
        collabSynced: false,
      }),
    ).toBe(false);
  });
});

describe("computeBodyIndicator (#564 guards 4+5)", () => {
  const base = {
    localFirst: true,
    showStatic: false,
    isRemoteConfirmed: false,
    isDisconnected: false,
    canEdit: true,
  };

  it("stays quiet on a healthy connection while connecting (no offline flash)", () => {
    expect(computeBodyIndicator(base)).toBe("connecting");
  });

  it("shows the offline banner only once really Disconnected", () => {
    expect(computeBodyIndicator({ ...base, isDisconnected: true })).toBe(
      "offline",
    );
  });

  // #564 F4 — the banner claims "showing the last copy saved on this device".
  // While showStatic is true, what is on screen is the SERVER-seeded static copy
  // (first visit / empty local ydoc / ydoc still loading), so saying that would
  // be a plain lie about fresh server content. A dead socket in the static window
  // gets the quiet badge, exactly like the flag-off path.
  it("never claims 'offline, local copy' while the STATIC server copy is on screen", () => {
    expect(
      computeBodyIndicator({ ...base, showStatic: true, isDisconnected: true }),
    ).toBe("connecting");

    // Same for a reader (no edit affordance to explain): say nothing at all.
    expect(
      computeBodyIndicator({
        ...base,
        showStatic: true,
        isDisconnected: true,
        canEdit: false,
      }),
    ).toBe("none");

    // Non-vacuity: the ONLY difference from the "offline" case above is that the
    // live (local ydoc) body is what is actually on screen.
    expect(
      computeBodyIndicator({
        ...base,
        showStatic: false,
        isDisconnected: true,
      }),
    ).toBe("offline");
  });

  it("shows the offline banner to readers too (chrome+body coherence)", () => {
    expect(
      computeBodyIndicator({ ...base, isDisconnected: true, canEdit: false }),
    ).toBe("offline");
  });

  it("says nothing once the remote confirmed, even if it later drops", () => {
    expect(
      computeBodyIndicator({
        ...base,
        isRemoteConfirmed: true,
        isDisconnected: true,
      }),
    ).toBe("none");
  });

  it("flag off: exactly today's rule (quiet badge, static window, editors only)", () => {
    const off = { ...base, localFirst: false };
    expect(computeBodyIndicator({ ...off, showStatic: true })).toBe(
      "connecting",
    );
    expect(
      computeBodyIndicator({ ...off, showStatic: true, isDisconnected: true }),
    ).toBe("connecting");
    expect(
      computeBodyIndicator({ ...off, showStatic: true, canEdit: false }),
    ).toBe("none");
    expect(computeBodyIndicator({ ...off, showStatic: false })).toBe("none");
  });

  // #641, part 6 — hysteresis. Over a multi-hour offline session Hocuspocus
  // flaps Connecting/Disconnected on every retry; the sticky latch holds the
  // banner steady so it does not flicker (acceptance 7).
  describe("offline hysteresis (#641 part 6)", () => {
    it("stays 'offline' during a retry blip (Connecting) once the latch is set", () => {
      // isDisconnected momentarily false (a Connecting attempt), but stickyOffline
      // is held: the banner must NOT flip back to the quiet "connecting" badge.
      expect(
        computeBodyIndicator({
          ...base,
          isDisconnected: false,
          stickyOffline: true,
        }),
      ).toBe("offline");
    });

    it("without the latch, a Connecting blip returns to 'connecting' (flicker source)", () => {
      expect(
        computeBodyIndicator({
          ...base,
          isDisconnected: false,
          stickyOffline: false,
        }),
      ).toBe("connecting");
    });

    it("a REAL remote sync clears offline regardless of the latch", () => {
      expect(
        computeBodyIndicator({
          ...base,
          isRemoteConfirmed: true,
          isDisconnected: true,
          stickyOffline: true,
        }),
      ).toBe("none");
    });

    it("the latch never overrides the static (server-seeded) window", () => {
      // While the static copy is on screen we must not claim a stale local copy.
      expect(
        computeBodyIndicator({
          ...base,
          showStatic: true,
          stickyOffline: true,
        }),
      ).toBe("connecting");
    });
  });
});
