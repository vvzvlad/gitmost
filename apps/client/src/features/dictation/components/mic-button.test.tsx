import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

// A disabled mic must explain WHY it is unavailable rather than silently saying
// "Start dictation". This renders MicButton in its idle+disabled state with a
// forwarded reason and asserts the accessible label resolves to that reason's
// text via the shared resolver (dictation-status.resolveUnavailableLabel).

// matchMedia (read by MantineProvider) is stubbed globally in vitest.setup.ts.

// Pass i18n keys through verbatim so we assert the exact resolved string.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (s: string) => s }),
}));

// Keep both controllers inert and idle so MicButton renders the idle branch.
const idleCtl = {
  status: "idle" as const,
  start: vi.fn(async () => {}),
  stop: vi.fn(),
  cancel: vi.fn(),
  audioLevel: 0,
  errorMessage: null,
};
vi.mock("@/features/dictation/hooks/use-dictation", () => ({
  useDictation: () => idleCtl,
}));
vi.mock("@/features/dictation/hooks/use-streaming-dictation", () => ({
  useStreamingDictation: () => idleCtl,
}));

import { MicButton } from "./mic-button";

function renderButton(props: React.ComponentProps<typeof MicButton>) {
  render(
    <MantineProvider>
      <MicButton {...props} />
    </MantineProvider>,
  );
}

describe("MicButton — disabled reason label", () => {
  // jsdom has no MediaRecorder / mediaDevices, so isDictationSupported() would
  // report "unsupported" and mask the forwarded reason. Stub both so the button
  // is considered supported and the availability reason is what surfaces.
  beforeEach(() => {
    (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder =
      class {};
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn() },
    });
  });
  afterEach(() => {
    delete (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder;
  });

  it("shows the cause-specific reason instead of 'Start dictation' when disabled with a reason", () => {
    renderButton({ onText: () => {}, disabled: true, unavailableReason: "offline" });
    const expected =
      "No connection to the collaboration server — dictation unavailable";
    // The reason surfaces as the accessible label (and the tooltip text).
    const button = screen.getByRole("button", { name: expected });
    expect(button).toBeDefined();
    // It is marked disabled the Mantine way (data-disabled), NOT the native
    // `disabled` attribute — otherwise pointer-events:none would kill the tooltip.
    expect(button.getAttribute("data-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    // And it no longer silently reads "Start dictation".
    expect(screen.queryByRole("button", { name: "Start dictation" })).toBeNull();
  });

  it("reads 'Start dictation' when enabled with no reason", () => {
    renderButton({ onText: () => {} });
    expect(
      screen.getByRole("button", { name: "Start dictation" }),
    ).toBeDefined();
  });

  it("does not advertise 'Start dictation' when disabled with no reason", () => {
    // A consumer passing bare `disabled` (e.g. the AI chat's isStreaming) with no
    // unavailableReason must not get a hoverable mic whose tooltip invites
    // "Start dictation" on a click that is rejected.
    renderButton({ onText: () => {}, disabled: true });
    expect(
      screen.queryByRole("button", { name: "Start dictation" }),
    ).toBeNull();
    const button = screen.getByRole("button");
    expect(button.getAttribute("data-disabled")).toBe("true");
  });
});
