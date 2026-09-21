/**
 * Deterministic avatar backgrounds for agent roles.
 *
 * The palette is generated from scratch at module load in OKLCH (a perceptually
 * uniform color space), so every value below is tunable: change the ring
 * configuration or the partner shifts and the whole palette regenerates.
 *
 * Pipeline: name -> normalize -> cyrb53 hash -> split into independent fields:
 *   - base color index (one of the validated palette colors)
 *   - partner hue shift: analogous 20..45deg (either side), complementary 180deg,
 *     or triadic +/-120deg — classic color-wheel schemes; partner is also darker
 *   - split angle (SPLIT_ANGLE_STEPS directions, soft boundary)
 * The same name always yields the same avatar, on any platform, forever.
 */

// ------------------------- Tunable configuration -------------------------

export interface RingConfig {
  /** OKLCH lightness, 0..1 */
  L: number;
  /** OKLCH chroma target; clamped down per-hue to fit the sRGB gamut */
  C: number;
  /** Hue of the first color in the ring, degrees */
  hueStart: number;
  /** Number of evenly spaced hues in the ring */
  count: number;
}

/**
 * Two lightness rings. 12 light + 8 dark = 20 base colors with a validated
 * min pairwise deltaE-OK of ~0.066 (clearly distinguishable at avatar size).
 * Don't add more hues per ring without re-checking minPairwiseDistance():
 * beyond ~20-24 colors humans stop telling them apart reliably.
 */
const RINGS: readonly RingConfig[] = [
  { L: 0.70, C: 0.14, hueStart: 15, count: 12 }, // light ring
  { L: 0.57, C: 0.13, hueStart: 20, count: 8 },  // darker ring
];

/** Partner color: lightness shifted by this much (negative = darker) */
const PARTNER_L_SHIFT = -0.10;
/** Analogous scheme: hue shift magnitude range, degrees (inclusive, 5-deg steps) */
const ANALOG_MIN_SHIFT = 20;
const ANALOG_SHIFT_STEP = 5;
const ANALOG_SHIFT_STEPS = 6; // 20, 25, 30, 35, 40, 45
/** Complementary scheme: fixed hue shift, degrees */
const COMPLEMENTARY_SHIFT = 180;
/** Triadic scheme: fixed hue shift magnitude, degrees (either side) */
const TRIADIC_SHIFT = 120;
/** Number of split directions (24 -> 15deg per step) */
const SPLIT_ANGLE_STEPS = 24;
/** Position of the color boundary, percent of the gradient axis */
const SPLIT_PERCENT = 50;
/** Width of the soft transition zone around the boundary, percent (0 = hard edge) */
const SPLIT_SOFTNESS = 16;

// ------------------------- OKLCH -> sRGB math -------------------------
// Matrices from Bjorn Ottosson's OKLab reference implementation.

function oklabToLinearSrgb(L: number, a: number, b: number): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

function gammaEncode(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

export function oklchToSrgb(L: number, C: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180;
  const [r, g, b] = oklabToLinearSrgb(L, C * Math.cos(h), C * Math.sin(h));
  return [gammaEncode(r), gammaEncode(g), gammaEncode(b)];
}

export function isInGamut(rgb: readonly number[]): boolean {
  return rgb.every((c) => c >= -1e-6 && c <= 1 + 1e-6);
}

/** Binary-search the max chroma <= C that fits into the sRGB gamut. */
function clampChroma(L: number, C: number, hDeg: number): number {
  if (isInGamut(oklchToSrgb(L, C, hDeg))) return C;
  let lo = 0, hi = C;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (isInGamut(oklchToSrgb(L, mid, hDeg))) lo = mid;
    else hi = mid;
  }
  return lo;
}

function toHex(rgb: readonly number[]): string {
  return (
    "#" +
    rgb
      .map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, "0"))
      .join("")
  );
}

/** WCAG relative luminance of an sRGB color (components 0..1). */
export function relativeLuminance(rgb: readonly number[]): number {
  const lin = rgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

export function contrastRatio(l1: number, l2: number): number {
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// ------------------------- Palette generation -------------------------

export interface PaletteEntry {
  /** Base background color */
  hex: string;
  /** OKLCH coordinates of the base color (used to derive partner colors) */
  L: number;
  C: number;
  h: number;
  /** Text/icon color with the best WCAG contrast on the base color */
  text: "white" | "black";
  /** OKLab coordinates of the base color (kept for validation) */
  lab: readonly [number, number, number];
}

function buildPalette(): PaletteEntry[] {
  const entries: PaletteEntry[] = [];
  for (const ring of RINGS) {
    const step = 360 / ring.count;
    for (let i = 0; i < ring.count; i++) {
      const h = (ring.hueStart + i * step) % 360;
      const C = clampChroma(ring.L, ring.C, h);
      const rgb = oklchToSrgb(ring.L, C, h);
      const lum = relativeLuminance(rgb);
      entries.push({
        hex: toHex(rgb),
        L: ring.L,
        C,
        h,
        // White text needs >= 3:1 contrast; otherwise fall back to black.
        text: contrastRatio(lum, 1) >= 3 ? "white" : "black",
        lab: [
          ring.L,
          C * Math.cos((h * Math.PI) / 180),
          C * Math.sin((h * Math.PI) / 180),
        ],
      });
    }
  }
  return entries;
}

/** Partner color for the split: base hue shifted by shiftDeg, darker by PARTNER_L_SHIFT. */
function partnerHex(entry: PaletteEntry, shiftDeg: number): string {
  const h2 = (entry.h + shiftDeg + 360) % 360;
  const L2 = entry.L + PARTNER_L_SHIFT;
  return toHex(oklchToSrgb(L2, clampChroma(L2, entry.C, h2), h2));
}

/** Generated once at module load; regenerates on every build from the config above. */
export const PALETTE: readonly PaletteEntry[] = buildPalette();

// ------------------------- Name -> avatar style -------------------------

/** Normalize so that "PM ", "pm" and "Pm" map to the same avatar. */
export function normalizeName(name: string): string {
  return name.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * cyrb53: deterministic 53-bit string hash with good avalanche.
 * Pure JS, cross-platform — never use language built-in hashing here.
 */
function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export interface AvatarStyle {
  /** Index of the base color in PALETTE */
  paletteIndex: number;
  /** Base color hex */
  bg: string;
  /** Second color hex (split partner) */
  bg2: string;
  /** Signed hue shift of the partner, degrees (e.g. -35, +45, 180, -120) */
  hueShift: number;
  /** Direction of the split, degrees */
  angleDeg: number;
  /** Text/icon color for the base color */
  text: "white" | "black";
}

/** Pure function: the same (normalized) name always returns the same style. */
export function avatarStyle(agentName: string): AvatarStyle {
  const h = cyrb53(normalizeName(agentName));
  // Slice the hash into independent fields, like digits of a number:
  const paletteIndex = h % PALETTE.length;
  let rest = Math.floor(h / PALETTE.length);
  const angleDeg = (rest % SPLIT_ANGLE_STEPS) * (360 / SPLIT_ANGLE_STEPS);
  rest = Math.floor(rest / SPLIT_ANGLE_STEPS);
  // Scheme: 0,1 -> analogous (minus/plus); 2 -> complementary; 3 -> triadic
  const scheme = rest % 4;
  rest = Math.floor(rest / 4);
  let hueShift: number;
  if (scheme === 2) {
    hueShift = COMPLEMENTARY_SHIFT;
  } else if (scheme === 3) {
    hueShift = rest % 2 ? TRIADIC_SHIFT : -TRIADIC_SHIFT;
  } else {
    const magnitude = ANALOG_MIN_SHIFT + (rest % ANALOG_SHIFT_STEPS) * ANALOG_SHIFT_STEP;
    hueShift = scheme === 0 ? -magnitude : magnitude;
  }
  const entry = PALETTE[paletteIndex];
  return {
    paletteIndex,
    bg: entry.hex,
    bg2: partnerHex(entry, hueShift),
    hueShift,
    angleDeg,
    text: entry.text,
  };
}

/** CSS background value: two colors with a slightly blurred boundary. */
export function avatarBackgroundCss(style: AvatarStyle): string {
  const from = SPLIT_PERCENT - SPLIT_SOFTNESS / 2;
  const to = SPLIT_PERCENT + SPLIT_SOFTNESS / 2;
  return `linear-gradient(${style.angleDeg}deg, ${style.bg} ${from}%, ${style.bg2} ${to}%)`;
}

// ------------------------- Validation -------------------------

/**
 * Min pairwise deltaE-OK (euclidean distance in OKLab) between base colors.
 * Re-check after tweaking RINGS: keep it >= ~0.06 so no two palette colors
 * look alike. Intended for a unit test or a dev-time assertion.
 */
export function minPairwiseDistance(): { distance: number; pair: [string, string] } {
  let min = Infinity;
  let pair: [string, string] = ["", ""];
  for (let i = 0; i < PALETTE.length; i++) {
    for (let j = i + 1; j < PALETTE.length; j++) {
      const a = PALETTE[i].lab, b = PALETTE[j].lab;
      const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      if (d < min) {
        min = d;
        pair = [PALETTE[i].hex, PALETTE[j].hex];
      }
    }
  }
  return { distance: min, pair };
}
