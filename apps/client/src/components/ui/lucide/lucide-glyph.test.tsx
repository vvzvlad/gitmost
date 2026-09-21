import { describe, it, expect } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { LucideGlyph, isValidIconName } from "./lucide-glyph";

describe("isValidIconName", () => {
  it("accepts a known icon and rejects everything else", () => {
    expect(isValidIconName("rocket")).toBe(true);
    expect(isValidIconName("file-text")).toBe(true);
    expect(isValidIconName("definitely-not-an-icon")).toBe(false);
    expect(isValidIconName("")).toBe(false);
    expect(isValidIconName(null)).toBe(false);
    expect(isValidIconName(undefined)).toBe(false);
  });
});

describe("LucideGlyph", () => {
  it("renders a real SVG for a valid icon name", async () => {
    const { container } = render(<LucideGlyph name="rocket" size={20} />);
    await waitFor(() => {
      expect(container.querySelector("svg")).not.toBeNull();
    });
  });

  it("renders the node fallback for an invalid name (no svg)", () => {
    const { container, getByText } = render(
      <LucideGlyph name="not-a-real-icon" fallback={<span>FB</span>} />,
    );
    expect(getByText("FB")).toBeDefined();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("renders the node fallback for an empty / null name", () => {
    const { getByText, rerender } = render(
      <LucideGlyph name="" fallback={<span>EMPTY</span>} />,
    );
    expect(getByText("EMPTY")).toBeDefined();
    rerender(<LucideGlyph name={null} fallback={<span>NULL</span>} />);
    expect(getByText("NULL")).toBeDefined();
  });

  it("never renders a raw JSON value as text", async () => {
    // A serialized IconRef accidentally passed as `name` is not a valid icon
    // name → it must hit the fallback, never leak the JSON into the DOM.
    const json = '{"name":"rocket","color":"blue"}';
    const { container } = render(
      <LucideGlyph name={json} fallback={<span>fallback</span>} />,
    );
    expect(container.textContent ?? "").not.toContain('{"name"');

    // And for a valid render, the DOM still carries no JSON braces.
    const { container: c2 } = render(<LucideGlyph name="rocket" />);
    await waitFor(() => {
      expect(c2.querySelector("svg")).not.toBeNull();
    });
    expect(c2.textContent ?? "").not.toContain('{"name"');
  });
});
