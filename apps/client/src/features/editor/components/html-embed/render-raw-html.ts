/**
 * Pure DOM helpers for the HTML embed node view. Kept out of the React
 * component so the script re-creation/execution mechanism and the execution/
 * edit policy can be unit-tested against a bare jsdom container with no
 * Tiptap/Mantine providers.
 */

/**
 * Inject raw HTML (including <script> tags) into `container`, executing any
 * scripts.
 *
 * Setting `innerHTML` does NOT run inline or external <script> tags the browser
 * parses that way: the HTML spec marks scripts inserted via innerHTML as
 * "already started" so they never execute. To get the tracker/analytics
 * use-case working we walk the freshly-parsed scripts and replace each with a
 * brand-new <script> element copying its attributes and inline code. A
 * programmatically created+inserted <script> DOES execute, so this restores
 * normal script behaviour in the wiki origin (Variant C).
 */
export function renderRawHtml(container: HTMLElement, source: string): void {
  // Clear any previous render (re-render on source change).
  container.innerHTML = "";
  if (!source) return;

  container.innerHTML = source;

  // Use the container's own document so the helper works against any document
  // (the live page or a standalone jsdom instance in tests), not just the
  // ambient global `document`.
  const doc = container.ownerDocument;
  const scripts = Array.from(container.querySelectorAll("script"));
  for (const oldScript of scripts) {
    const newScript = doc.createElement("script");
    // Copy every attribute (src, type, async, defer, data-*, etc.).
    for (const attr of Array.from(oldScript.attributes)) {
      newScript.setAttribute(attr.name, attr.value);
    }
    // Copy inline code.
    newScript.text = oldScript.textContent ?? "";
    // Replacing the node in place triggers execution.
    oldScript.parentNode?.replaceChild(newScript, oldScript);
  }
}

/**
 * Execution policy split by editor mode:
 *  - READ-ONLY / public-share view: the SERVER already decided whether to
 *    include the embed (it strips htmlEmbed from shared content when the
 *    workspace toggle is OFF). An anonymous viewer has no workspace and thus
 *    reads `featureEnabled` as false, so we must NOT gate execution on it here
 *    — we execute exactly the `source` the server chose to serve.
 *  - EDITABLE editor (admin authoring): keep gating on the per-workspace toggle
 *    so an admin sees the inert placeholder when the feature is OFF.
 */
export function shouldExecute(
  isEditable: boolean,
  featureEnabled: boolean,
): boolean {
  return !isEditable || featureEnabled;
}

/**
 * The edit affordance is only meaningful in edit mode, is restricted to admins
 * (the server strips the node for non-admins anyway), and is offered only when
 * the workspace feature toggle is ON.
 */
export function canEdit(
  isEditable: boolean,
  isAdmin: boolean,
  featureEnabled: boolean,
): boolean {
  return isEditable && isAdmin && featureEnabled;
}
