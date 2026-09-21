import { describe, it, expect } from "vitest";
import {
  PALETTE,
  avatarStyle,
  avatarBackgroundCss,
  normalizeName,
  minPairwiseDistance,
  relativeLuminance,
  contrastRatio,
  oklchToSrgb,
  isInGamut,
} from "./avatar-palette";

/** Parse "#rrggbb" into sRGB components on the 0..1 scale relativeLuminance expects. */
function hexToRgb01(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ];
}

describe("avatar-palette validation", () => {
  it("palette colors stay distinguishable", () => {
    // 0.06 in OKLab is ~4-5 JNDs — safely distinct at avatar size. If a future
    // RINGS tweak drops this, "almost identical" colors would reappear.
    expect(minPairwiseDistance().distance).toBeGreaterThanOrEqual(0.06);
    expect(PALETTE.length).toBe(20);
  });

  it("every palette entry is WCAG-readable and in sRGB gamut", () => {
    // white text = luminance 1, black text = luminance 0 (per buildPalette).
    const textLum = { white: 1, black: 0 } as const;
    for (const entry of PALETTE) {
      expect(entry.hex).toMatch(/^#[0-9a-f]{6}$/);

      // (a) The chosen text color really clears the code's 3:1 threshold on the
      // actual background hex — recomputed independently from the hex, not from
      // the build-time luminance. A slot that picked the wrong text (or a color
      // too dim for either text) would fail here.
      const hexLum = relativeLuminance(hexToRgb01(entry.hex));
      const chosen = contrastRatio(textLum[entry.text], hexLum);
      expect(chosen).toBeGreaterThanOrEqual(3);
      // buildPalette prefers white and only falls back to black when white
      // fails 3:1. Mirror that decision: black is used *only* when white would
      // not clear the threshold — so a mis-assigned "black" on a dark color
      // (where white was fine) fails here.
      if (entry.text === "black") {
        expect(contrastRatio(textLum.white, hexLum)).toBeLessThan(3);
      }

      // (b) The entry's OKLCH is inside the sRGB gamut after chroma clamping;
      // an out-of-gamut slot (e.g. un-clamped chroma) would produce components
      // outside [0,1] and fail here.
      expect(isInGamut(oklchToSrgb(entry.L, entry.C, entry.h))).toBe(true);
    }
  });
});

describe("avatarStyle", () => {
  it("name-to-avatar mapping is frozen (golden values)", () => {
    // Golden slice: if this breaks, all existing avatars change — make sure
    // that is intentional (a config change in avatar-palette.ts).
    const s = avatarStyle("Backend Developer");
    expect([s.bg, s.bg2, s.angleDeg]).toEqual(["#a55795", "#90355e", 150]);
    expect(s.text).toBe("white");
  });

  it("is deterministic and normalizes the name", () => {
    expect(avatarStyle("Researcher")).toEqual(avatarStyle("Researcher"));
    // Casing, surrounding and repeated whitespace must not change the avatar.
    expect(avatarStyle("  RESEARCHER ")).toEqual(avatarStyle("researcher"));
    expect(avatarStyle("Backend   Developer")).toEqual(
      avatarStyle("backend developer"),
    );
    expect(normalizeName("  PM ")).toBe("pm");
  });

  it("returns a valid base color, angle and matching text", () => {
    const s = avatarStyle("Нарратор");
    const idx = PALETTE.findIndex((e) => e.hex === s.bg);
    expect(idx).toBe(s.paletteIndex);
    expect(idx).toBeGreaterThanOrEqual(0); // bg is a palette entry
    // Text color comes from the chosen palette entry.
    expect(s.text).toBe(PALETTE[idx].text);
    // Split angle is one of the SPLIT_ANGLE_STEPS (24) directions → multiples of 15.
    expect(s.angleDeg % 15).toBe(0);
    expect(s.angleDeg).toBeGreaterThanOrEqual(0);
    expect(s.angleDeg).toBeLessThan(360);
  });

  it("distinguishes the agents that used to collide as violet", () => {
    // "Структурный редактор" and "Фактчекер" looked identically violet before.
    expect(avatarStyle("Структурный редактор")).not.toEqual(
      avatarStyle("Фактчекер"),
    );
  });
});

describe("avatarBackgroundCss", () => {
  it("renders a two-stop gradient with a soft boundary", () => {
    const s = avatarStyle("Backend Developer");
    expect(avatarBackgroundCss(s)).toBe(
      "linear-gradient(150deg, #a55795 42%, #90355e 58%)",
    );
  });
});
