export function isImageFile(file: Pick<File, "type" | "name">): boolean {
  return (
    file.type.startsWith("image/") ||
    ((!file.type || file.type === "application/octet-stream") &&
      /\.gif$/i.test(file.name))
  );
}

function directGifUrl(value: string): string | null {
  const text = value.trim();
  if (!text || /\s/.test(text)) return null;
  try {
    const url = new URL(text);
    return ["http:", "https:"].includes(url.protocol) &&
      /\.gif$/i.test(url.pathname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function gifFromClipboard(
  text: string,
  html: string,
): { src: string; alt?: string } | null {
  if (/<table[\s>]/i.test(html) || /\bdata-attachment-id\s*=/i.test(html))
    return null;
  const src = directGifUrl(text);
  if (src) return { src };
  if (!html || !html.toLowerCase().includes(".gif")) return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const images = doc.body.querySelectorAll("img");
  // Rich fragments keep their layout. A copied GIF often includes a static PNG
  // file alongside its HTML: prefer the original GIF URL to preserve animation.
  if (
    images.length !== 1 ||
    doc.body.textContent?.trim() ||
    doc.querySelector("table")
  )
    return null;
  const image = images[0];
  const original = directGifUrl(image.getAttribute("src") ?? "");
  return original
    ? { src: original, alt: image.getAttribute("alt") ?? undefined }
    : null;
}
