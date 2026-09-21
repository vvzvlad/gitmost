// Client-local execCommand copy fallback (previously imported from
// @docmost/editor-ext). It lives here so the ubiquitous useClipboard / CopyButton
// path does not pull in the editor-ext barrel — and with it the whole TipTap
// engine — through the eager startup graph. Behavior is identical to the
// editor-ext helper it replaces.
export function execCommandCopy(text: string): void {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

// Stateless one-shot copy: write `text` to the clipboard without ever storing it
// in React state (unlike useClipboard, which keeps a `copied` flag AND holds the
// last value). Used by the api-key reveal/copy flow, where the secret must touch
// nothing but the clipboard — no component state, no cache, no localStorage.
export async function copyToClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && "clipboard" in navigator) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the execCommand fallback (e.g. insecure context).
    }
  }
  execCommandCopy(text);
}
