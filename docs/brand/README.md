# Gitmost brand assets

Canonical home for the Gitmost logo, marks and brand guide.
See [gitmost-brand-guide.html](./gitmost-brand-guide.html) for usage rules
(colors, clear space, don'ts).

## Files

| File | Use |
| --- | --- |
| `gitmost-brand-guide.html` | Brand guide — open in a browser. |
| `gitmost-logo-dark.svg` | Primary horizontal logo (mark + wordmark), dark ink — for light backgrounds. |
| `gitmost-logo-light.svg` | Primary horizontal logo, light ink — for dark backgrounds. |
| `gitmost-icon.svg` | App icon — mark on a dark `#0E1117` tile (256px). |
| `gitmost-favicon.svg` | Favicon — mark on a dark tile, heavier strokes for small sizes. |
| `gitmost-mark-dark.svg` | Bare mark, dark strokes — for light backgrounds. |
| `gitmost-mark-light.svg` | Bare mark, light strokes — for dark backgrounds. |
| `gitmost-mark-mono.svg` | Single-color mark (print, engraving, B/W). |

## Runtime copies

The web client serves the assets it needs from `apps/client/public/brand/`
(logos, marks, favicon) and `apps/client/public/icons/` (PNG favicons and PWA
app icons rasterized from `gitmost-favicon.svg` / `gitmost-icon.svg`). When a
brand asset here changes, refresh those copies.

## Wordmark

The wordmark is "gitmost" set in Space Grotesk SemiBold (600), tracking
-0.04em, all lowercase. In `gitmost-logo-*.svg` the text is converted to
outlines, so no font is required at runtime.
