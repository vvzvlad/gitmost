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

function renderCards(onPick = vi.fn()) {
  render(
    <MantineProvider>
      <RoleCards roles={roles} onPick={onPick} />
    </MantineProvider>,
  );
  return onPick;
}

describe("RoleCards", () => {
  it("renders one card per role with name, emoji, and description", () => {
    renderCards();
    expect(screen.getByText("Pirate")).toBeDefined();
    expect(screen.getByText("Talks like a pirate")).toBeDefined();
    expect(screen.getByText("Grandpa")).toBeDefined();
    // The emoji is shown for the role that has one.
    expect(screen.getByText("🏴‍☠️")).toBeDefined();
  });

  it("does NOT render a Universal assistant card", () => {
    renderCards();
    expect(screen.queryByText("Universal assistant")).toBeNull();
  });

  it("calls onPick with the role object when a card is clicked", () => {
    const onPick = renderCards();
    fireEvent.click(screen.getByText("Pirate"));
    expect(onPick).toHaveBeenCalledWith(roles[0]);
  });
});
