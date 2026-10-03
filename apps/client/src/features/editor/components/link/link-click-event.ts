import type { Editor } from "@tiptap/core";

// Kept free of runtime imports: the app-wide LinkClickHost is mounted on every
// route, so anything imported here lands in the startup graph.
export const LINK_CLICK_EVENT = "docmost:link-click";

export type LinkClickDetail = {
  editor: Editor;
  anchor: HTMLAnchorElement;
  href: string;
  internal: boolean;
};
