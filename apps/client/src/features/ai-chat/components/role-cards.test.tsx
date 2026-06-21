import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import RoleCards from "./role-cards";
import { IAiRole } from "@/features/ai-chat/types/ai-chat.types.ts";

// MantineProvider reads window.matchMedia (color scheme) on mount, which jsdom
// does not implement. Provide a minimal stub so the provider can render.
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
});

// react-i18next without an I18nextProvider returns the key verbatim, so
// t("Universal assistant") renders as "Universal assistant" — exactly the label
// we assert on below.

const roles: IAiRole[] = [
  {
    id: "r1",
    name: "Pirate",
    emoji: "🏴‍☠️",
    description: "Talks like a pirate",
    enabled: true,
  },
  {
    id: "r2",
    name: "Grandpa",
    emoji: null,
    description: null,
    enabled: true,
  },
];

function renderCards(
  selectedRoleId: string | null,
  onSelect = vi.fn(),
) {
  render(
    <MantineProvider>
      <RoleCards
        roles={roles}
        selectedRoleId={selectedRoleId}
        onSelect={onSelect}
      />
    </MantineProvider>,
  );
  return onSelect;
}

describe("RoleCards", () => {
  it("renders a Universal assistant card plus one card per role", () => {
    renderCards(null);
    expect(screen.getByText("Universal assistant")).toBeDefined();
    expect(screen.getByText("Pirate")).toBeDefined();
    expect(screen.getByText("Grandpa")).toBeDefined();
    // The emoji is shown for the role that has one.
    expect(screen.getByText("🏴‍☠️")).toBeDefined();
  });

  it("highlights the Universal card when nothing is selected", () => {
    renderCards(null);
    const universal = screen.getByText("Universal assistant").closest("button");
    expect(universal?.getAttribute("aria-pressed")).toBe("true");
    const pirate = screen.getByText("Pirate").closest("button");
    expect(pirate?.getAttribute("aria-pressed")).toBe("false");
  });

  it("highlights a role card when that role is selected", () => {
    renderCards("r1");
    const universal = screen.getByText("Universal assistant").closest("button");
    expect(universal?.getAttribute("aria-pressed")).toBe("false");
    const pirate = screen.getByText("Pirate").closest("button");
    expect(pirate?.getAttribute("aria-pressed")).toBe("true");
  });

  it("calls onSelect with the role id when a role card is clicked", () => {
    const onSelect = renderCards(null);
    fireEvent.click(screen.getByText("Pirate"));
    expect(onSelect).toHaveBeenCalledWith("r1");
  });

  it("calls onSelect with null when the Universal card is clicked", () => {
    const onSelect = renderCards("r1");
    fireEvent.click(screen.getByText("Universal assistant"));
    expect(onSelect).toHaveBeenCalledWith(null);
  });
});
