import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import RoleCards from "./role-cards";
import { IAiRole } from "@/features/ai-chat/types/ai-chat.types.ts";

// matchMedia (read by MantineProvider) is stubbed globally in vitest.setup.ts.

const roles: IAiRole[] = [
  {
    id: "r1",
    name: "Pirate",
    emoji: '{"name":"anchor"}',
    description: "Talks like a pirate",
    enabled: true,
    autoStart: true,
    launchMessage: null,
  },
  {
    id: "r2",
    name: "Grandpa",
    emoji: null,
    description: null,
    enabled: true,
    autoStart: true,
    launchMessage: null,
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
  it("renders one card per role with name, glyph, and description", () => {
    const { container } = render(
      <MantineProvider>
        <RoleCards roles={roles} onPick={vi.fn()} />
      </MantineProvider>,
    );
    expect(screen.getByText("Pirate")).toBeDefined();
    expect(screen.getByText("Talks like a pirate")).toBeDefined();
    expect(screen.getByText("Grandpa")).toBeDefined();
    // The role with an IconRef renders a Lucide glyph, never the raw JSON.
    expect(container.textContent ?? "").not.toContain('{"name"');
  });

  it("renders the Lucide glyph SVG for a role with an IconRef", async () => {
    const { container } = render(
      <MantineProvider>
        <RoleCards roles={roles} onPick={vi.fn()} />
      </MantineProvider>,
    );
    // The glyph is a lazily-loaded DynamicIcon; wait for the SVG to mount so a
    // RoleCard that stopped rendering a glyph entirely would fail this test
    // (the anti-leak assertion above alone would not catch that).
    await waitFor(() => {
      expect(container.querySelector("svg")).not.toBeNull();
    });
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
