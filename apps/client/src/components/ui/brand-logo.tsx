import { useComputedColorScheme } from "@mantine/core";
import { getAppName } from "@/lib/config";

type BrandLogoProps = {
  // When true, render the mark only; otherwise render the full lockup (mark + wordmark).
  markOnly?: boolean;
  // Logo height in pixels; width scales automatically to preserve aspect ratio.
  height?: number;
  className?: string;
};

export function BrandLogo({
  markOnly = false,
  height = 28,
  className,
}: BrandLogoProps) {
  const colorScheme = useComputedColorScheme("light");
  const variant = colorScheme === "dark" ? "white" : "black";
  const artwork = markOnly ? "mark" : "logo";

  return (
    <img
      src={`/brand/dozor-${artwork}-${variant}.svg`}
      alt={getAppName()}
      className={className}
      draggable={false}
      style={{ height, width: "auto", display: "block", userSelect: "none" }}
    />
  );
}
