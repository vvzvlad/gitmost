import { type ReactNode } from "react";
import {
  DynamicIcon,
  dynamicIconImports,
  type IconName,
} from "lucide-react/dynamic";

// The set of valid icon names is exactly the keys of `dynamicIconImports` (the
// same names lucide.dev/icons lists). Built once at module load.
const VALID_ICON_NAMES = new Set<string>(Object.keys(dynamicIconImports));

/** Whether `name` is a renderable Lucide icon (a key of `dynamicIconImports`). */
export function isValidIconName(name: string | null | undefined): name is string {
  return typeof name === "string" && VALID_ICON_NAMES.has(name);
}

export interface LucideGlyphProps {
  /** Kebab-case Lucide icon name. Invalid/empty → the `fallback` node. */
  name: string | null | undefined;
  size?: number;
  /** Stroke color (any CSS color / Mantine var). Defaults to `currentColor`. */
  color?: string;
  strokeWidth?: number;
  /** Rendered when `name` is missing or not a known Lucide icon. */
  fallback?: ReactNode;
  "aria-label"?: string;
}

/**
 * Renders a Lucide icon by name via `DynamicIcon` (lazy per-icon module), or the
 * `fallback` node when the name is missing/invalid. It NEVER throws and NEVER
 * renders a raw stored value: only a validated icon name is ever handed to
 * `DynamicIcon`, and everything else short-circuits to `fallback`.
 *
 * While the icon module loads, a fixed-size placeholder holds the layout so
 * there is no shift when the glyph resolves.
 */
export function LucideGlyph({
  name,
  size = 18,
  color,
  strokeWidth,
  fallback = null,
  "aria-label": ariaLabel,
}: LucideGlyphProps) {
  if (!isValidIconName(name)) {
    return <>{fallback}</>;
  }

  return (
    <DynamicIcon
      name={name as IconName}
      size={size}
      color={color}
      strokeWidth={strokeWidth}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
      // Loading placeholder: a same-size empty inline box (no layout shift). The
      // `fallback` prop is a RENDER FUNCTION, not a node.
      fallback={() => (
        <span
          aria-hidden
          style={{ display: "inline-block", width: size, height: size }}
        />
      )}
    />
  );
}

export default LucideGlyph;
