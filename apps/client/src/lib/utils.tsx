import { validate as isValidUUID } from "uuid";
import { ReactNode } from "react";
import { TFunction } from "i18next";
import { PageIcon } from "@/components/ui/page-icon.tsx";

export function formatMemberCount(memberCount: number, t: TFunction): string {
  if (memberCount === 1) {
    return `1 ${t("member")}`;
  } else {
    return `${memberCount} ${t("members")}`;
  }
}

export function extractPageSlugId(slug: string): string {
  if (!slug) {
    return undefined;
  }
  if (isValidUUID(slug)) {
    return slug;
  }
  const parts = slug.split("-");
  return parts.length > 1 ? parts[parts.length - 1] : slug;
}

export const computeSpaceSlug = (name: string) => {
  // Slug is validated as alphanumeric-only (@IsAlphanumeric / ^[a-zA-Z0-9]+$),
  // so lowercase the name and strip every non-alphanumeric character (spaces,
  // punctuation, unicode). No hyphens or uppercase initials.
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
};

export const formatBytes = (bytes: number): string => {
  if (bytes === 0) return "0.0 KB";

  const unitSize = 1024;
  const units = ["KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];

  const kilobytes = bytes / unitSize;

  const unitIndex = Math.floor(Math.log(kilobytes) / Math.log(unitSize));
  const adjustedUnitIndex = Math.max(unitIndex, 0);
  const adjustedSize = kilobytes / Math.pow(unitSize, adjustedUnitIndex);

  // Use one decimal for KB and no decimals for MB or higher
  const precision = adjustedUnitIndex === 0 ? 1 : 0;

  return `${adjustedSize.toFixed(precision)} ${units[adjustedUnitIndex]}`;
};

export async function svgStringToFile(
  svgString: string,
  fileName: string,
): Promise<File> {
  const blob = new Blob([svgString], { type: "image/svg+xml" });
  return new File([blob], fileName, { type: "image/svg+xml" });
}

// Convert a string holding Base64 encoded UTF-8 data into a proper UTF-8 encoded string
// as a replacement for `atob`.
// based on: https://developer.mozilla.org/en-US/docs/Glossary/Base64
function decodeBase64(base64: string): string {
  // convert string to bytes
  const bytes = Uint8Array.from(atob(base64), (m) => m.codePointAt(0));
  // properly decode bytes to UTF-8 encoded string
  return new TextDecoder().decode(bytes);
}

export function decodeBase64ToSvgString(base64Data: string): string {
  const base64Prefix = "data:image/svg+xml;base64,";
  if (base64Data.startsWith("data:")) {
    if (base64Data.startsWith(base64Prefix)) {
      base64Data = base64Data.slice(base64Prefix.length);
    } else {
      // #629 (A5) — reject a non-SVG data: URL (e.g. data:image/png;base64,…)
      // outright. A one-line prefix-strip that silently decoded a PNG here would
      // open a path to uploading a PNG under the .svg name (acceptance #7).
      throw new Error(
        "decodeBase64ToSvgString: expected an image/svg+xml data URL",
      );
    }
  }

  const decoded = decodeBase64(base64Data);

  // #629 (A5) — the decoded payload MUST actually be an SVG document. A bare
  // base64 that decodes to PNG (or any non-SVG) bytes must not flow into the
  // .svg upload path. Real SVGs open with `<svg` or an `<?xml …?>` prolog; the
  // #584 UTF-8 behavior above is unchanged for those.
  const head = decoded.replace(/^\uFEFF/, "").trimStart();
  if (!head.startsWith("<svg") && !head.startsWith("<?xml")) {
    throw new Error(
      "decodeBase64ToSvgString: decoded payload is not an SVG document",
    );
  }

  return decoded;
}

export function capitalizeFirstChar(string: string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}

// Renders a page icon from its stored value (IconRef JSON, a legacy emoji, or
// null). Always goes through <PageIcon> so a raw JSON value can never leak into
// the UI; null/legacy/invalid values render the neutral default file glyph.
export function getPageIcon(
  icon: string | null | undefined,
  size = 18,
): ReactNode {
  return <PageIcon value={icon} size={size} />;
}

export const normalizeUrl = (url: string): string => {
  if (!url) return url;
  if (url.startsWith("/") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) return url;
  return `https://${url}`;
};

const _isApple = /mac|iphone|ipad|ipod/i.test(navigator.platform ?? "");

/// Cmd key on Apple devices, Ctrl key everywhere else
export function platformModifierKey(event: KeyboardEvent): boolean {
  return _isApple ? event.metaKey : event.ctrlKey;
}

export const platformModifierLabel = _isApple ? "⌘" : "Ctrl";

export function castToBoolean(value: unknown): boolean {
  if (value == null) {
    return false;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    const trueValues = ["true", "1"];
    const falseValues = ["false", "0"];

    if (trueValues.includes(trimmed)) {
      return true;
    }
    if (falseValues.includes(trimmed)) {
      return false;
    }
    return Boolean(trimmed);
  }

  return Boolean(value);
}
