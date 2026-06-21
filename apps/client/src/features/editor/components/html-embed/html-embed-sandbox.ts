/**
 * Pure helpers for the HTML embed node view. Kept out of the React component so
 * the sandbox srcdoc builder and the render/edit policy can be unit-tested
 * against a bare environment with no Tiptap/Mantine providers.
 */

/** postMessage type the sandboxed iframe uses to report its content height. */
export const HTML_EMBED_HEIGHT_MESSAGE = "gitmost-html-embed-height";

// Sane bounds for the auto-resized iframe so a runaway embed cannot blow up the
// page layout, and a sensible default before the first height message arrives.
export const MIN_IFRAME_HEIGHT = 40;
export const MAX_IFRAME_HEIGHT = 4000;
export const DEFAULT_IFRAME_HEIGHT = 150;

/**
 * Sandbox tokens for the embed iframe. Intentionally does NOT include
 * `allow-same-origin`: the content must run in an opaque ("null") origin so it
 * cannot read the viewer's cookies/session/API.
 */
export const HTML_EMBED_SANDBOX = "allow-scripts allow-popups allow-forms";

/** Clamp a reported/configured height into the sane iframe bounds. */
export function clampHeight(h: number): number {
  return Math.min(MAX_IFRAME_HEIGHT, Math.max(MIN_IFRAME_HEIGHT, h));
}

/**
 * Guard for the auto-resize `message` handler. Returns the clamped numeric
 * height ONLY when the event is a trusted resize report; otherwise null.
 *
 * Trusted means ALL of:
 *  - `event.source` is this iframe's own `contentWindow` (the sandboxed srcdoc
 *    has an opaque "null" origin, so we cannot match by `event.origin` — we
 *    match by source instead). A message from any OTHER window is rejected.
 *  - the payload `type` is exactly our agreed resize message type.
 *  - the reported `height` is a finite number (rejects NaN/Infinity).
 */
export function isTrustedHeightMessage(
  event: Pick<MessageEvent, "source" | "data">,
  iframeEl: { contentWindow: Window | null } | null,
): boolean {
  // Reject when there is no contentWindow to match against; otherwise a `null`
  // event.source would spuriously equal a `null` contentWindow.
  if (!iframeEl?.contentWindow) return false;
  if (event.source !== iframeEl.contentWindow) return false;
  const data = event.data as { type?: string; height?: number } | null;
  if (data?.type !== HTML_EMBED_HEIGHT_MESSAGE) return false;
  return Number.isFinite(Number(data.height));
}

/**
 * Build the `srcdoc` document for the sandboxed embed iframe.
 *
 * The user's `source` is placed verbatim, then a small bootstrap <script> is
 * appended at the end of the body. The iframe is rendered with a sandbox that
 * does NOT include `allow-same-origin`, so this content runs in an opaque
 * ("null") origin and cannot read the viewer's cookies/session/API — it is
 * harmless. The bootstrap measures the document height and reports it to the
 * parent via postMessage on load and whenever the content resizes, so the
 * parent can size the iframe to fit (auto-resize mode).
 */
export function buildSandboxSrcdoc(source: string): string {
  const bootstrap = `
<script>
  (function () {
    var lastSent = -1;
    var scheduled = false;
    function measure() {
      var doc = document.documentElement;
      var body = document.body;
      return Math.max(
        doc ? doc.scrollHeight : 0,
        body ? body.scrollHeight : 0
      );
    }
    function flush() {
      scheduled = false;
      var height = measure();
      // Only report when the height actually changed by more than 1px. This
      // damps the iframe self-measure feedback loop: content sized to the iframe
      // viewport would otherwise oscillate as the parent resizes the frame in
      // response to each report.
      if (Math.abs(height - lastSent) <= 1) return;
      lastSent = height;
      parent.postMessage(
        { type: ${JSON.stringify(HTML_EMBED_HEIGHT_MESSAGE)}, height: height },
        "*"
      );
    }
    function reportHeight() {
      if (scheduled) return;
      scheduled = true;
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(flush);
      } else {
        flush();
      }
    }
    window.addEventListener("load", reportHeight);
    // Report an initial height now (runs during parse, before load/images
    // settle); the load handler and ResizeObserver refine it as content changes.
    reportHeight();
    if (typeof ResizeObserver !== "undefined") {
      try {
        var ro = new ResizeObserver(reportHeight);
        ro.observe(document.documentElement);
      } catch (e) {
        // ResizeObserver unavailable/failed: the load handler still reports once.
      }
    }
  })();
</script>`;
  return `${source || ""}${bootstrap}`;
}

/**
 * Render policy split by editor mode:
 *  - READ-ONLY / public-share view: the SERVER already decided whether to
 *    include the embed (it strips htmlEmbed from shared content when the
 *    workspace master toggle is OFF). An anonymous viewer has no workspace and
 *    thus reads `featureEnabled` as false, so we must NOT gate rendering on it
 *    here — we render exactly the `source` the server chose to serve.
 *  - EDITABLE editor: gate on the per-workspace master toggle so an author sees
 *    the inert placeholder when the feature is OFF.
 */
export function shouldRender(
  isEditable: boolean,
  featureEnabled: boolean,
): boolean {
  return !isEditable || featureEnabled;
}

/**
 * The edit affordance is only meaningful in edit mode and is offered only when
 * the workspace master toggle is ON. The block renders in a sandboxed iframe
 * (no same-origin access), so authoring is allowed to ANY member — there is no
 * admin requirement.
 */
export function canEdit(isEditable: boolean, featureEnabled: boolean): boolean {
  return isEditable && featureEnabled;
}
