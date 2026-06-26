import { describe, it, expect } from "vitest";
import { roleLaunchMessage, shouldResetRolePicked } from "./role-launch.ts";

const DEFAULT = "Take a look at the current document";

// Covers the three-way handleRolePick behavior (issue #149) without mounting the
// chat-thread component — the logic lives in these pure helpers.
describe("roleLaunchMessage", () => {
  it("autoStart=true + custom launchMessage -> the trimmed custom text", () => {
    expect(
      roleLaunchMessage(
        { autoStart: true, launchMessage: "  Draft a plan  " },
        DEFAULT,
      ),
    ).toBe("Draft a plan");
  });

  it("autoStart=true + empty launchMessage -> the default fallback", () => {
    expect(
      roleLaunchMessage({ autoStart: true, launchMessage: "" }, DEFAULT),
    ).toBe(DEFAULT);
  });

  it("autoStart=true + whitespace-only launchMessage -> the default fallback", () => {
    expect(
      roleLaunchMessage({ autoStart: true, launchMessage: "   " }, DEFAULT),
    ).toBe(DEFAULT);
  });

  it("autoStart=true + null launchMessage -> the default fallback", () => {
    expect(
      roleLaunchMessage({ autoStart: true, launchMessage: null }, DEFAULT),
    ).toBe(DEFAULT);
  });

  it("autoStart=false -> null (bind only, send nothing) regardless of message", () => {
    expect(
      roleLaunchMessage(
        { autoStart: false, launchMessage: "ignored" },
        DEFAULT,
      ),
    ).toBeNull();
    expect(
      roleLaunchMessage({ autoStart: false, launchMessage: null }, DEFAULT),
    ).toBeNull();
  });
});

// Regression guard for #149: the "picked, not sent" flag must reset when the
// user starts a fresh chat after an autoStart=false pick. On pre-fix code there
// was no reset, so the flag stayed stuck and the role cards never returned —
// this is exactly the `true` case below (which the old code never acted on).
describe("shouldResetRolePicked", () => {
  it("resets when the thread is empty and the bound role was cleared (New chat)", () => {
    // chatId still null, roleId cleared by the parent, flag stuck -> reset.
    expect(shouldResetRolePicked(null, null, true)).toBe(true);
    expect(shouldResetRolePicked(null, undefined, true)).toBe(true);
  });

  it("does NOT reset while a role is still bound (cards stay hidden, composer shown)", () => {
    // Right after the autoStart=false pick, roleId is the picked role -> keep hidden.
    expect(shouldResetRolePicked(null, "role-1", true)).toBe(false);
  });

  it("does NOT reset once the chat exists (a message was sent / chat created)", () => {
    expect(shouldResetRolePicked("chat-1", null, true)).toBe(false);
  });

  it("is a no-op when the flag is already false", () => {
    expect(shouldResetRolePicked(null, null, false)).toBe(false);
  });
});
