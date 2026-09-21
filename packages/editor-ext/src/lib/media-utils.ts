import { Editor } from "@tiptap/core";

export function normalizeFileUrl(src: string): string {
  if (src && src.startsWith("/files/")) {
    return "/api" + src;
  }
  return src || "";
}

export type UploadFn = (
  file: File,
  editor: Editor,
  pos: number,
  pageId: string,
  // only applicable to file attachments
  allowMedia?: boolean,
) => void;

export interface MediaPlaceholderOptions {
  /** Node type name (`image`, `video`, `drawio`, `excalidraw`) — for the log. */
  nodeType: string;
  /** Resolved media URL — for the log. */
  src?: string;
  /**
   * Event that means "the media is ready": `load` for `<img>`,
   * `loadedmetadata` for `<video>`.
   */
  readyEvent?: string;
}

/**
 * Show the loading placeholder on a media element and settle it on BOTH
 * outcomes.
 *
 * The placeholder makes the node non-interactive (`pointer-events: none`) and
 * runs the `media-pulse` shimmer. Previously only the success event undid
 * that, so a 404/403, a deleted attachment, or a `<video preload="metadata">`
 * that never reaches `loadedmetadata` left the node pulsing forever AND
 * permanently unclickable. Now the `error` event settles it too, and the
 * failure is logged with enough context to identify the attachment.
 *
 * Call it right after assigning `src`, in the same synchronous task (all four
 * node views do). It is nevertheless safe to call late: an element that is
 * ALREADY loaded would never fire its ready event again, so the
 * already-settled case is checked up front rather than left pulsing forever.
 * Both listeners are `{ once: true }`, so a later `src` swap (see the
 * `onUpdate` paths in image/video/drawio/excalidraw) needs a fresh call if it
 * wants a placeholder for the new source.
 */
export function attachMediaPlaceholder(
  el: HTMLElement & {
    error?: { code: number; message?: string } | null;
    complete?: boolean;
    readyState?: number;
  },
  dom: HTMLElement,
  options: MediaPlaceholderOptions,
): void {
  const { nodeType, src, readyEvent = "load" } = options;

  const settle = () => {
    dom.style.pointerEvents = "";
    el.classList.remove("media-pulse");
  };

  const logFailure = (event?: Event) => {
    const mediaError = el.error;
    console.error(
      `[editor] failed to load ${nodeType} media`,
      {
        nodeType,
        src: src ?? (el as HTMLImageElement).src ?? null,
        mediaErrorCode: mediaError?.code ?? null,
        mediaErrorMessage: mediaError?.message ?? null,
      },
      event,
    );
  };

  // Already settled before we got here? Neither event would fire again, so
  // attaching listeners alone would leave the placeholder on forever.
  //
  // A `<video>` that already failed exposes an attributable `MediaError`, so
  // that one is worth logging. The `<img>` cases are NOT distinguishable
  // cheaply: `complete` is true for a finished load AND for a failed one, and
  // `naturalWidth === 0` is not a failure signal (a valid SVG with only a
  // `viewBox` — what draw.io exports — reports 0 and would produce a false
  // error on every node-view rebuild). The event is in the past and cannot be
  // attributed anyway, so the already-settled fast path just settles quietly;
  // a failure that happens while we are attached is still logged below.
  if (el.error) {
    settle();
    logFailure();
    return;
  }
  const currentSrc = (el as HTMLImageElement).src;
  if (el.complete === true && currentSrc) {
    settle();
    return;
  }
  // `<video>` reports `readyState >= HAVE_METADATA (1)`.
  if (typeof el.readyState === "number" && el.readyState >= 1) {
    settle();
    return;
  }

  dom.style.pointerEvents = "none";
  el.classList.add("media-pulse");

  el.addEventListener(readyEvent, settle, { once: true });
  el.addEventListener(
    "error",
    (event) => {
      settle();
      logFailure(event);
    },
    { once: true },
  );
}

export interface MediaUploadOptions {
  validateFn?: (file: File, allowMedia?: boolean) => void;
  onUpload: (file: File, pageId: string) => Promise<any>;
}
