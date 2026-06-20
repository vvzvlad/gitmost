/**
 * Pure helpers for the HTML embed node view. Kept out of the React component so
 * the sandbox srcdoc builder and the execution/edit policy can be unit-tested
 * against a bare environment with no Tiptap/Mantine providers.
 */

/** postMessage type the sandboxed iframe uses to report its content height. */
export const HTML_EMBED_HEIGHT_MESSAGE = "gitmost-html-embed-height";

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
    function reportHeight() {
      var doc = document.documentElement;
      var body = document.body;
      var height = Math.max(
        doc ? doc.scrollHeight : 0,
        body ? body.scrollHeight : 0
      );
      parent.postMessage(
        { type: ${JSON.stringify(HTML_EMBED_HEIGHT_MESSAGE)}, height: height },
        "*"
      );
    }
    window.addEventListener("load", reportHeight);
    // Report immediately too, in case load already fired.
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
 * Execution policy split by editor mode:
 *  - READ-ONLY / public-share view: the SERVER already decided whether to
 *    include the embed (it strips htmlEmbed from shared content when the
 *    workspace master toggle is OFF). An anonymous viewer has no workspace and
 *    thus reads `featureEnabled` as false, so we must NOT gate rendering on it
 *    here — we render exactly the `source` the server chose to serve.
 *  - EDITABLE editor: gate on the per-workspace master toggle so an author sees
 *    the inert placeholder when the feature is OFF.
 */
export function shouldExecute(
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
