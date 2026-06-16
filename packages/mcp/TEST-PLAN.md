# Docmost MCP — Test Plan (editing & image tools)

Manual/E2E test plan for every content-mutating tool, with special focus on
images and image replacement. Executed against a live Docmost instance
(`docs.vvzvlad.xyz`) and verified visually in Chrome (public share + authenticated
editor).

## How to run the automated part

```
DOCMOST_API_URL=https://<host>/api \
DOCMOST_EMAIL=<email> \
DOCMOST_PASSWORD=<password> \
node test-e2e.mjs
```

`test-e2e.mjs` creates a throwaway page, exercises every code path (including the
image upload/insert/replace cycle) and deletes the page afterwards. Collab writes
are debounced server-side, so the script waits ~16 s before reading back via REST.

## Test matrix

| # | Tool / path | What is checked | Expected |
|---|-------------|-----------------|----------|
| 1 | `create_page` | title with spaces, slugId returned | page created, title intact |
| 2 | `update_page` (markdown) | headings, **bold**/*italic*/~~strike~~/`code`/link, nested bullet + ordered lists, blockquote, code block, `:::callout:::`, table | all structures survive re-import |
| 3 | `get_page_json` | lossless ProseMirror, block ids, callout/table nodes | present (note: reads the **debounced** REST snapshot — recent collab writes may lag a few seconds) |
| 4 | `edit_page_text` | surgical replace; block ids + marks preserved; ambiguous match rejected; missing match reported | edits applied, ids stable, errors correct |
| 5 | `update_page_json` | full lossless write; custom block ids preserved; existing content (text edits, images, callout, table) not lost | round-trips intact |
| 6 | `upload_image` | uploads attachment, returns node | src is a **clean** `/api/files/<id>/<file>` URL, served `200 image/*` |
| 7 | `insert_image` (append / `replaceText` / `afterText`) | three placements | image lands in the right place, all other block ids preserved |
| 8 | **`replace_image`** | swap an existing figure for new bytes; comments/align/alt preserved; **the new URL must actually serve the image** | new image renders (`200`), old node repointed |

## Image-specific assertions (the recurring bug area)

For every uploaded/inserted/replaced image, assert at the HTTP level that the
`src` actually serves bytes — this is what catches "broken image" regressions:

* `GET <src>` → `200`, `Content-Type: image/*`, body starts with the image magic
  (`89 50 4E 47` for PNG, etc.).
* `src` does **not** contain a `?v=` query (see "Known pitfalls").
* After `replace_image`: the returned `newAttachmentId` **differs** from the old
  one (replacement uses a fresh attachment → fresh URL), and `GET <new src>` → `200`.
* The old image node on the page is repointed to the new attachmentId.

## Browser verification (Chrome)

Open the page (public `/share/<key>/p/<slug>` URL, or the authenticated editor)
and check each `<img>`:

```js
[...document.querySelectorAll('.ProseMirror img')].map(im => ({
  src: im.getAttribute('src'),
  loaded: im.naturalWidth > 0,           // 0 ⇒ broken
}));
```

`loaded === true` (naturalWidth > 0) means the image really rendered; `0` means a
broken/empty figure.

## Known pitfalls (root-caused during testing)

1. **In-place attachment overwrite corrupts the file (HTTP 500).**
   Uploading with an existing `attachmentId` (`POST /files/upload` + `attachmentId`)
   overwrites the bytes in place. On this Docmost the attachment then returns
   **500 for every URL** (clean, `?v=`, any filename) → broken image. Therefore
   `replace_image` must upload a **new** attachment and repoint the nodes; the new
   id yields a new URL that both renders and busts the browser cache. The old
   attachment is left as an unreferenced orphan: Docmost exposes **no HTTP API to
   delete a single content attachment** (verified against the attachment
   controller/service and by probing ~20 route variants live — all 404; an
   attachment unlinked from a page stays reachable with no auto-GC). Attachments
   are removed only by cascade (page/space/user deletion). This matches Docmost's
   own editor, which also orphans attachments on image removal/replacement.

2. **`?v=<hash>` cache-buster is unnecessary and was a red herring.**
   The file endpoint serves `…/file.png?v=<hash>` exactly like the clean URL
   (`200 image/*`) — verified at the HTTP layer, on the public share, and in the
   authenticated editor. The broken images people saw came from pitfall #1, not
   from `?v=`. Image `src` is kept clean (`/api/files/<id>/<file>`); cache-busting
   on replace is achieved by the new attachment id.

3. **REST snapshot lag.** `get_page_json` reads the debounced DB snapshot, so a
   write made moments earlier may not be visible yet. Wait (~16 s) before reading
   back, and never feed a possibly-stale snapshot straight into `update_page_json`.

4. **Callout type narrowing (minor, open).** A `:::warning` callout is imported as
   `type: "info"` — the markdown→callout conversion does not carry non-`info`
   types through. Cosmetic; tracked separately.
