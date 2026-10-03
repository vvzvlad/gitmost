import type { Editor } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import {
  LINK_CLICK_EVENT,
  LinkClickDetail,
} from "@/features/editor/components/link/link-click-event.ts";

/**
 * Turns a click on a link mark's plain `<a>` into a single app-wide
 * `LINK_CLICK_EVENT`, handled by the one mounted `LinkClickHost`.
 */
export function createLinkClickPlugin(editor: Editor): Plugin {
  return new Plugin({
    props: {
      handleDOMEvents: {
        click(view, event) {
          const anchor = (event.target as Element).closest("a");
          if (!anchor || !view.dom.contains(anchor)) return false;

          let pos: number;
          try {
            pos = view.posAtDOM(anchor, 0);
          } catch {
            return false;
          }

          const linkType = view.state.schema.marks.link;
          const mark = linkType.isInSet(
            view.state.doc.resolve(pos).nodeAfter?.marks ?? [],
          );
          // No link mark here: the anchor belongs to a node view (e.g. a
          // mention), which keeps its own click handling.
          if (!mark) return false;

          event.preventDefault();
          const detail: LinkClickDetail = {
            editor,
            anchor,
            href: mark.attrs.href,
            internal: !!mark.attrs.internal,
          };
          view.dom.dispatchEvent(
            new CustomEvent(LINK_CLICK_EVENT, { bubbles: true, detail }),
          );
          return true;
        },
      },
    },
  });
}
