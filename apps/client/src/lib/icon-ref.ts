/**
 * Single source of truth for the Lucide-icon reference stored in `pages.icon`
 * and `aiAgentRoles.emoji` (#610).
 *
 * Both columns keep their existing name and `varchar` type — the value is now a
 * JSON string of an {@link IconRef} instead of a native emoji character:
 *   - `pages.icon`         : `{"name":"rocket","color":"blue"}` (color = palette token)
 *   - `aiAgentRoles.emoji` : `{"name":"rocket"}` (no color — the avatar bg is a gradient)
 *
 * A legacy native-emoji value is NOT valid JSON, so `parseIconRef` returns
 * `null` for it and every render site falls back to its default glyph. This
 * module never throws.
 */

export interface IconRef {
  /** Lucide icon name in kebab-case (a key of `dynamicIconImports`). */
  name: string;
  /** Optional Mantine palette token (articles only). */
  color?: string;
}

/**
 * The article-icon color palette — Mantine hue tokens rendered as a 35% tint of
 * the `-6` hue (see {@link pageIconBg}) behind a glyph tone picked per color
 * scheme (see {@link pageIconFgLight} / {@link pageIconFgDark}). Every token in
 * this list was measured against that pairing on the real sidebar surfaces and
 * clears 3:1 glyph-on-tile in both schemes. Default is `blue`.
 */
export const PAGE_ICON_PALETTE = [
  "gray",
  "red",
  "pink",
  "grape",
  "violet",
  "indigo",
  "blue",
  "cyan",
  "teal",
  "green",
  "lime",
  "yellow",
  "orange",
] as const;

export type PageIconColor = (typeof PAGE_ICON_PALETTE)[number];

export const DEFAULT_PAGE_ICON_COLOR: PageIconColor = "blue";

const PALETTE_SET = new Set<string>(PAGE_ICON_PALETTE);

/** An unknown / missing palette token resolves to the default (`blue`). */
export function resolvePageIconColor(color?: string | null): PageIconColor {
  return color && PALETTE_SET.has(color)
    ? (color as PageIconColor)
    : DEFAULT_PAGE_ICON_COLOR;
}

/**
 * Theme-aware tile background for a palette token — a stronger version of the
 * mechanism behind Mantine's `-light` token, which is literally the `-6` hue at
 * 10% alpha (light scheme) / 15% (dark). We keep that exact mechanism and only
 * raise the tint to 35%: 3.5x more colored in the light scheme, ~2.3x in dark.
 * It is still a tint, not a filled chip.
 *
 * A translucent hue is scheme-agnostic by construction: it darkens a light
 * surface and lightens a dark one, so the BACKGROUND needs no `light-dark()`
 * fork and even the `gray` token stays visible on the dark sidebar surface.
 * `color-mix` is already used natively elsewhere in this codebase
 * (`styles/notification-overrides.css`, the transclusion styles), so it adds no
 * new browser-support floor.
 *
 * Also used for the palette swatches in the picker dropdown, which are the same
 * tint with no glyph on top.
 */
export function pageIconBg(color: PageIconColor): string {
  return `color-mix(in srgb, var(--mantine-color-${color}-6) 35%, transparent)`;
}

/*
 * Why the glyph tone is a per-scheme FORK while the background above is not:
 * in the light scheme Mantine's `--mantine-color-<c>-light-color` IS shade `-6`,
 * the very hue now mixed into the tile at 35%. Glyph and tile would then be the
 * same color at two alphas, so raising the tint necessarily washes the glyph out
 * — measured, that pairing lowered glyph-on-tile contrast for all 13 tokens and
 * left only 4 of them above 3:1 (yellow 1.41, teal 1.74, lime 1.51 among the 9
 * that failed). The two tones below were measured over the real surfaces (light
 * sidebar #f6f7f9 and its gray-3 hover row, dark sidebar --mantine-color-dark-8
 * and its dark-5 hover) against the real palettes, including the custom
 * blue/red tuples in `theme.ts`: light 3.41…11.06, dark 6.20…8.01 — all 13
 * tokens clear the 3:1 non-text threshold in both schemes at rest, and the only
 * value that dips below it is yellow on a hovered light row (2.99).
 *
 * The fork is RESOLVED IN CSS, not here: `page-icon.module.css` reads the two
 * values back out of inline custom properties inside a `light-dark()`, because
 * postcss-preset-mantine compiles `light-dark()` into a
 * `[data-mantine-color-scheme='dark'] &` rule — it does not process inline
 * styles, so a native `light-dark()` in a `style={{}}` would depend on browser
 * support instead of the repo-wide mechanism every other fork uses.
 *
 * TRADE-OFF, stated honestly: this tile no longer picks up `theme.ts`'s WCAG
 * overrides of `--mantine-color-*-light-color` (red → red-7, green → #1B5E20,
 * gray → gray-7). Those were calibrated for the OLD 10% background and are moot
 * on a 35% tint. The new tones are darker than all of them except green, which
 * measures 4.44:1 here versus the override's ~6.8:1 on the old washed-out tile —
 * still comfortably above the 3:1 bar that applies to a non-text glyph.
 */

/**
 * Glyph tone for the LIGHT scheme: the `-9` shade darkened 20% toward black.
 * That extra darkening is what keeps every token >=3:1 on the 35% tile (the old
 * `-light-color` / `-6` pairing did not, even before the tint was raised).
 * Consumed via `--page-icon-fg-light`; see the block comment above.
 */
export function pageIconFgLight(color: PageIconColor): string {
  return `color-mix(in srgb, var(--mantine-color-${color}-9) 80%, black)`;
}

/**
 * Glyph tone for the DARK scheme: the `-2` shade, the light-end counterpart of
 * the tone above — the tile is a translucent hue over a near-black surface, so
 * the glyph has to go lighter, not darker. Consumed via `--page-icon-fg-dark`;
 * see the block comment above.
 */
export function pageIconFgDark(color: PageIconColor): string {
  return `var(--mantine-color-${color}-2)`;
}

/**
 * Parse a stored icon value into an {@link IconRef}, DEFENSIVELY. Returns `null`
 * for anything that is not a valid IconRef JSON object with a non-empty `name`:
 * null/undefined, empty string, non-JSON (e.g. a legacy emoji character), a JSON
 * value that is not an object, or an object without a usable `name`.
 *
 * When a `color` is present but is not a known palette token it is normalized to
 * the default (`blue`); a missing `color` stays absent (role refs carry none).
 */
export function parseIconRef(
  raw: string | null | undefined,
): IconRef | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // A native emoji or any other non-JSON string lands here → treated as "no
    // icon" so the caller renders its default glyph.
    return null;
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    return null;
  }

  const name = (parsed as Record<string, unknown>).name;
  if (typeof name !== "string" || name.trim() === "") return null;

  const ref: IconRef = { name: name.trim() };

  const color = (parsed as Record<string, unknown>).color;
  if (typeof color === "string" && color.trim() !== "") {
    ref.color = resolvePageIconColor(color.trim());
  }

  return ref;
}

/** Serialize an {@link IconRef} to the stored JSON string. */
export function serializeIconRef(ref: IconRef): string {
  const out: IconRef = { name: ref.name };
  if (ref.color) out.color = ref.color;
  return JSON.stringify(out);
}
