import { useComputedColorScheme } from "@mantine/core";

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
  // Detect the active color scheme and pick the contrasting ink variant.
  // "*-light" = light ink for dark backgrounds, "*-dark" = dark ink for light backgrounds.
  const colorScheme = useComputedColorScheme("light");
  const variant = colorScheme === "dark" ? "light" : "dark";

  const src = markOnly
    ? `/brand/gitmost-mark-${variant}.svg`
    : `/brand/gitmost-logo-${variant}.svg`;

  return (
    <img
      src={src}
      alt="Gitmost"
      className={className}
      style={{ height, width: "auto", display: "block", userSelect: "none" }}
    />
  );
}
