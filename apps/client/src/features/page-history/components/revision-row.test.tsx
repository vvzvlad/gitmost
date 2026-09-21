import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import RevisionRow from "./revision-row";
import { RevisionRowData } from "@/features/page-history/utils/revision-row";

// matchMedia (read by MantineProvider) is stubbed globally in vitest.setup.ts.
// react-i18next with no initialized instance returns the key as the label, so
// t("Saved") renders "Saved" and t("via") renders "via".

function renderRow(row: RevisionRowData, onSelect = vi.fn()) {
  return {
    onSelect,
    ...render(
      <MantineProvider>
        <RevisionRow row={row} selected={false} onSelect={onSelect} />
      </MantineProvider>,
    ),
  };
}

const base: RevisionRowData = {
  id: "1",
  ts: 0,
  atLabel: "5:35 AM",
  dayISO: "2026-07-12",
  isAgent: false,
  authorName: "Alice",
  authorAvatarUrl: "",
  saved: false,
  version: true,
};

describe("RevisionRow (#568 dense row)", () => {
  it("human manual version: avatar + name + time + SAVED badge", () => {
    renderRow({ ...base, saved: true });
    expect(screen.getByText("5:35 AM")).toBeDefined();
    expect(screen.getByText("Alice")).toBeDefined();
    // SAVED badge only when saved (kind === manual).
    expect(screen.getByText("Saved")).toBeDefined();
    expect(screen.queryByTestId("revision-agent-glyph")).toBeNull();
  });

  it("autosave (not a version): dimmed, NO SAVED badge", () => {
    const { container } = renderRow({ ...base, saved: false, version: false });
    expect(screen.queryByText("Saved")).toBeNull();
    const rowEl = container.querySelector(
      '[data-testid="revision-row"]',
    ) as HTMLElement;
    expect(rowEl.style.opacity).toBe("0.55");
  });

  it("agent version: square role glyph + 'via <launcher>', NO SAVED badge", () => {
    renderRow({
      ...base,
      isAgent: true,
      agentName: "Corrector",
      agentEmoji: '{"name":"wrench"}',
      launcherName: "Bob",
      saved: false,
    });
    // Square role glyph renders the Lucide icon (never the raw stored JSON).
    const glyph = screen.getByTestId("revision-agent-glyph");
    expect(glyph.textContent ?? "").not.toContain('{"name"');
    expect(screen.getByText("Corrector")).toBeDefined();
    // "· via Bob" provenance.
    expect(screen.getByText(/via/)).toBeDefined();
    expect(screen.getByText(/Bob/)).toBeDefined();
    // Agent versions are marked by the glyph, not a duplicate SAVED badge.
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("clicking the row selects it by id", () => {
    const onSelect = vi.fn();
    const { container } = renderRow(base, onSelect);
    fireEvent.click(
      container.querySelector('[data-testid="revision-row"]') as HTMLElement,
    );
    expect(onSelect).toHaveBeenCalledWith("1");
  });

  it("carries a data-day anchor for jump-to-day scrolling", () => {
    const { container } = renderRow(base);
    const rowEl = container.querySelector('[data-testid="revision-row"]');
    expect(rowEl?.getAttribute("data-day")).toBe("2026-07-12");
  });
});
