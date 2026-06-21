// Fixed Mantine color palette for the new-chat role cards. Cards cycle through
// these names by index; the colors are applied via theme-aware Mantine CSS vars
// (`--mantine-color-<name>-light` etc.) so they are correct in both themes.
// Universal assistant uses neutral `gray` separately (not part of this palette).
export const ROLE_CARD_PALETTE = [
  "blue",
  "grape",
  "teal",
  "orange",
  "pink",
  "cyan",
  "lime",
  "indigo",
  "red",
  "violet",
] as const;

/**
 * Pick a palette color name for a role card by its index. Cycles through the
 * palette and is safe for negative indices.
 */
export function roleCardColor(index: number): string {
  const len = ROLE_CARD_PALETTE.length;
  return ROLE_CARD_PALETTE[((index % len) + len) % len];
}
