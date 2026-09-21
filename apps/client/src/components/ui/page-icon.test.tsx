import { describe, it, expect, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { PageIcon, PageIconPicker } from "./page-icon";
import { serializeIconRef } from "@/lib/icon-ref";

describe("PageIcon", () => {
  it("renders the default file glyph for a null value", () => {
    const { container } = render(<PageIcon value={null} />);
    expect(
      container.querySelector(".tabler-icon-file-description"),
    ).not.toBeNull();
  });

  it("renders the default file glyph for a legacy emoji value (never raw)", () => {
    const { container } = render(<PageIcon value="🚀" />);
    expect(
      container.querySelector(".tabler-icon-file-description"),
    ).not.toBeNull();
    expect(container.textContent ?? "").not.toContain("🚀");
  });

  it("renders the default file glyph for malformed JSON", () => {
    const { container } = render(<PageIcon value={'{"name":'} />);
    expect(
      container.querySelector(".tabler-icon-file-description"),
    ).not.toBeNull();
    expect(container.textContent ?? "").not.toContain("{");
  });

  it("renders a Lucide glyph in a colored box for a valid IconRef", async () => {
    const json = serializeIconRef({ name: "rocket", color: "teal" });
    const { container } = render(<PageIcon value={json} />);
    // The colored box exists and there is no default file glyph.
    expect(
      container.querySelector(".tabler-icon-file-description"),
    ).toBeNull();
    await waitFor(() => {
      expect(container.querySelector("svg")).not.toBeNull();
    });
    // No raw JSON ever reaches the DOM.
    expect(container.textContent ?? "").not.toContain('{"name"');
  });
});

// --- Rendered geometry ------------------------------------------------------
// The icon size is a DOM-observable property, and it is exactly the class of
// thing that broke silently before: the tile kept its declared size in the JSX
// while the ActionIcon around it clipped it back down. Assert on the real DOM.

/**
 * The tile is the outer `aria-hidden` `<span>` PageIcon renders around the
 * glyph — the first one in document order (Mantine's own ActionIcon-icon
 * wrapper carries no aria-hidden, and the glyph's inner span comes after).
 */
function tile(root: HTMLElement): HTMLElement {
  return root.querySelector('span[aria-hidden="true"]') as HTMLElement;
}

describe("PageIcon geometry", () => {
  it("renders the tile at the requested size", () => {
    const json = serializeIconRef({ name: "rocket", color: "teal" });
    const { container } = render(<PageIcon value={json} size={20} />);
    expect(tile(container).style.width).toBe("20px");
    expect(tile(container).style.height).toBe("20px");
  });

  it("clamps an oversized request to MAX_BOX (24px)", () => {
    const json = serializeIconRef({ name: "rocket", color: "teal" });
    const { container } = render(<PageIcon value={json} size={40} />);
    expect(tile(container).style.width).toBe("24px");
    expect(tile(container).style.height).toBe("24px");
  });

  it("renders the no-icon fallback glyph at the FULL box size (same footprint as the tile)", () => {
    const { container } = render(<PageIcon value={null} size={20} />);
    const svg = container.querySelector(
      "svg.tabler-icon-file-description",
    ) as SVGElement;
    expect(svg).not.toBeNull();
    expect(svg.getAttribute("width")).toBe("20");
    expect(svg.getAttribute("height")).toBe("20");
  });
});

/**
 * Mantine renders an ActionIcon's numeric size as `--ai-size: calc(<n>rem * …)`
 * on the button element, so read the rem value back out and convert to px
 * (Mantine's `rem()` uses a 16px base).
 */
function actionIconSizePx(button: HTMLElement): number {
  const raw = button.style.getPropertyValue("--ai-size");
  const match = /([\d.]+)rem/.exec(raw);
  expect(match, `no rem value in --ai-size: "${raw}"`).not.toBeNull();
  return Number(match![1]) * 16;
}

describe("PageIconPicker trigger geometry (anti-clipping invariant)", () => {
  it("derives a trigger button at least 2px larger than the tile it wraps", async () => {
    const json = serializeIconRef({ name: "rocket", color: "teal" });
    // Only `size` is passed — NO actionIconProps.size. The button dimension has
    // to come from PageIconPicker's own `+ 2`, so deleting it fails this test.
    const { container } = render(
      <MantineProvider>
        <PageIconPicker
          value={json}
          onChange={vi.fn()}
          onRemove={vi.fn()}
          size={20}
          actionIconProps={{ tabIndex: -1 }}
        />
      </MantineProvider>,
    );

    const button = container.querySelector("button") as HTMLElement;
    expect(button).not.toBeNull();

    // The tile keeps its declared size inside the trigger…
    await waitFor(() => {
      expect(tile(button).style.width).toBe("20px");
    });
    const tilePx = parseInt(tile(button).style.width, 10);

    // …and the button reserves its own border box on top of it. Mantine's
    // ActionIcon root sets `overflow: hidden` + a 1px transparent border under
    // `box-sizing: border-box`, so anything smaller than tile + 2 clips the tile.
    expect(actionIconSizePx(button)).toBeGreaterThanOrEqual(tilePx + 2);
  });
});

describe("PageIcon glyph tone (the TSX ↔ CSS-module contract)", () => {
  it("hands both scheme-specific tones to the tile as inline custom properties", () => {
    // page-icon.module.css resolves the light/dark fork by reading these two
    // properties inside a light-dark(); if the TSX stops emitting them the glyph
    // silently falls back to the inherited text color.
    const json = serializeIconRef({ name: "rocket", color: "teal" });
    const { container } = render(<PageIcon value={json} size={20} />);
    const style = tile(container).style;
    expect(style.getPropertyValue("--page-icon-fg-light")).toContain(
      "--mantine-color-teal-9",
    );
    expect(style.getPropertyValue("--page-icon-fg-dark")).toContain(
      "--mantine-color-teal-2",
    );
  });
});
