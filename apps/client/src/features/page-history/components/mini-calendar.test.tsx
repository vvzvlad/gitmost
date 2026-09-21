import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import MiniCalendar from "./mini-calendar";
import { isoDayInTz } from "@/features/page-history/utils/revision-row";

// matchMedia (read by MantineProvider) is stubbed globally in vitest.setup.ts.

const TZ = "UTC";

function renderCal(counts: Map<string, number>, onPickDay = vi.fn()) {
  const todayISO = isoDayInTz(new Date(), TZ);
  return {
    todayISO,
    onPickDay,
    ...render(
      <MantineProvider>
        <MiniCalendar
          counts={counts}
          selectedDayISO={todayISO}
          onPickDay={onPickDay}
          tz={TZ}
        />
      </MantineProvider>,
    ),
  };
}

describe("MiniCalendar (#568 heatmap)", () => {
  it("renders a 6x7 grid and highlights the selected day", () => {
    const { todayISO } = renderCal(new Map());
    const cells = screen.getAllByTestId("calendar-day");
    expect(cells).toHaveLength(42);
    const today = cells.find((c) => c.getAttribute("data-day") === todayISO)!;
    expect(today.className).toContain("calDaySelected");
  });

  it("applies a heat class scaled to the day's revision count", () => {
    const day = isoDayInTz(new Date(), TZ);
    const { todayISO } = renderCal(new Map([[day, 200]]));
    const today = screen
      .getAllByTestId("calendar-day")
      .find((c) => c.getAttribute("data-day") === todayISO)!;
    // 200 revisions → top tier (calHeat3) under the #605 total-activity scale.
    expect(today.className).toContain("calHeat3");
  });

  it("picking an in-month day delegates the dayISO to onPickDay", () => {
    const { todayISO, onPickDay } = renderCal(new Map());
    const today = screen
      .getAllByTestId("calendar-day")
      .find((c) => c.getAttribute("data-day") === todayISO)!;
    fireEvent.click(today);
    expect(onPickDay).toHaveBeenCalledWith(todayISO);
  });

  it("Enter/Space activates a focusable day cell (F3 keyboard)", () => {
    const { todayISO, onPickDay } = renderCal(new Map());
    const today = screen
      .getAllByTestId("calendar-day")
      .find((c) => c.getAttribute("data-day") === todayISO)!;
    // In-month cells are focusable buttons.
    expect(today.getAttribute("role")).toBe("button");
    expect(today.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(today, { key: "Enter" });
    fireEvent.keyDown(today, { key: " " });
    expect(onPickDay).toHaveBeenCalledTimes(2);
  });

  it("day cells carry a non-color aria/title cue for the count (F3)", () => {
    const day = isoDayInTz(new Date(), TZ);
    renderCal(new Map([[day, 3]]));
    const today = screen
      .getAllByTestId("calendar-day")
      .find((c) => c.getAttribute("data-day") === day)!;
    // A non-color cue is wired (the interpolated count is filled by the real
    // i18next instance in-app; the test's key-fallback t returns the template).
    const label = today.getAttribute("aria-label") ?? "";
    expect(label).toContain("revisions");
    // The same text is mirrored to the native tooltip.
    expect(today.getAttribute("title")).toBe(label);
    // Outside-month cells are inert (no aria-label / not focusable).
    const outside = screen
      .getAllByTestId("calendar-day")
      .find((c) => c.getAttribute("role") !== "button");
    expect(outside?.getAttribute("aria-label")).toBeNull();
  });

  it("maps count tiers to heat classes at the #605 total-activity boundaries", () => {
    const cases: Array<[number, string]> = [
      [0, "calHeat0"],
      [20, "calHeat1"], // low day (≤20)
      [21, "calHeat2"], // tier 1→2 boundary
      [100, "calHeat2"], // mid day (≤100)
      [101, "calHeat3"], // tier 2→3 boundary
      [426, "calHeat3"], // heavy stage day
    ];
    for (const [count, cls] of cases) {
      const day = isoDayInTz(new Date(), TZ);
      const { unmount } = renderCal(
        count > 0 ? new Map([[day, count]]) : new Map(),
      );
      const today = screen
        .getAllByTestId("calendar-day")
        .find((c) => c.getAttribute("data-day") === day)!;
      expect(today.className).toContain(cls);
      unmount();
    }
  });
});
