import TiptapHeading, {
  HeadingOptions as TiptapHeadingOptions,
} from "@tiptap/extension-heading";
import { mergeAttributes } from "@tiptap/react";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, type Transaction } from "@tiptap/pm/state";
import { copyToClipboard } from "../utils";

const copyIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"><!-- Icon from Material Symbols Light by Google - https://github.com/google/material-design-icons/blob/master/LICENSE --><path fill="currentColor" d="M10.616 16.077H7.077q-1.692 0-2.884-1.192T3 12t1.193-2.885t2.884-1.193h3.539v1H7.077q-1.27 0-2.173.904Q4 10.731 4 12t.904 2.173t2.173.904h3.539zM8.5 12.5v-1h7v1zm4.885 3.577v-1h3.538q1.27 0 2.173-.904Q20 13.269 20 12t-.904-2.173t-2.173-.904h-3.538v-1h3.538q1.692 0 2.885 1.192T21 12t-1.193 2.885t-2.884 1.193z"/></svg>`;
const successIcon = `<svg xmlns="http://www.w3.org/2000/svg" style="color: forestgreen;" width="18" height="18" viewBox="0 0 24 24"><!-- Icon from Material Symbols by Google - https://github.com/google/material-design-icons/blob/master/LICENSE --><path fill="currentColor" d="m10.6 16.6l7.05-7.05l-1.4-1.4l-5.65 5.65l-2.85-2.85l-1.4 1.4zM12 22q-2.075 0-3.9-.788t-3.175-2.137T2.788 15.9T2 12t.788-3.9t2.137-3.175T8.1 2.788T12 2t3.9.788t3.175 2.137T21.213 8.1T22 12t-.788 3.9t-2.137 3.175t-3.175 2.138T12 22"/></svg>`;

function headingLinkWidget(node: ProseMirrorNode, pos: number): Decoration {
  return Decoration.widget(
    pos + node.nodeSize - 1,
    () => {
      const icon = document.createElement("span");
      icon.classList.add("link-btn");
      icon.innerHTML = "&nbsp;";
      icon.contentEditable = "false";

      const linkBtnContent = document.createElement("span");
      linkBtnContent.classList.add("link-btn-content");
      linkBtnContent.innerHTML = copyIcon;
      icon.appendChild(linkBtnContent);

      icon.addEventListener("mousedown", (e) => e.preventDefault());
      icon.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        const id = node.attrs.id;
        const baseUrl = window.location.href.split('#')[0];
        const url = `${baseUrl}#${id}`;
        copyToClipboard(url);
        linkBtnContent.innerHTML = successIcon;
        setTimeout(() => (linkBtnContent.innerHTML = copyIcon), 2000);
      });

      return icon;
    },
    {
      side: 1, // render after node content
      // A fresh toDOM closure is built whenever a heading's widget is rebuilt,
      // so without a key ProseMirror never matches the old widget and rebuilds
      // the button's DOM (and forces a relayout). The closure only reads
      // node.attrs.id, so the id is enough to make reuse safe.
      key: `heading-link-${node.attrs.id}`,
    },
  );
}

function headingLinkWidgets(doc: ProseMirrorNode): Decoration[] {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "heading" && node.content.size > 1) {
      decorations.push(headingLinkWidget(node, pos));
    }
  });
  return decorations;
}

// The ranges of `tr.doc` touched by the transaction's steps, each step's range
// mapped forward through the steps after it.
function changedRanges(tr: Transaction): [number, number][] {
  const ranges: [number, number][] = [];
  tr.mapping.maps.forEach((map, i) => {
    const after = tr.mapping.slice(i + 1);
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      ranges.push([after.map(newStart, -1), after.map(newEnd, 1)]);
    });
  });
  return ranges;
}

export const Heading = TiptapHeading.extend<TiptapHeadingOptions>({
  // @ts-ignore
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        // Kept in plugin state rather than rebuilt in props.decorations: that
        // rebuilt every heading's widget on EVERY view update, selection-only
        // ones included, which on a page with ~1000 headings cost ~1 s on open
        // and ~110 ms after each keystroke. Now a transaction that does not
        // change the doc reuses the set as-is, and one that does maps it and
        // rebuilds only the headings its changed ranges touch.
        state: {
          init: (_, { doc }) =>
            DecorationSet.create(doc, headingLinkWidgets(doc)),
          apply: (tr, set) => {
            if (!tr.docChanged) return set;

            const mapped = set.map(tr.mapping, tr.doc);
            const stale: Decoration[] = [];
            const fresh: Decoration[] = [];
            const rebuilt = new Set<number>();

            for (const [from, to] of changedRanges(tr)) {
              // Widen the range to whole textblocks. A widget sits at the end of
              // its block, so it can lie outside the range itself — and after a
              // merge (a heading's tail joined into a paragraph) the block that
              // carries it is no longer a heading at all.
              let start = from;
              let end = to;
              tr.doc.nodesBetween(from, to, (node, pos) => {
                if (!node.isTextblock) return true;
                start = Math.min(start, pos);
                end = Math.max(end, pos + node.nodeSize);
                if (node.type.name === "heading" && !rebuilt.has(pos)) {
                  rebuilt.add(pos);
                  if (node.content.size > 1) {
                    fresh.push(headingLinkWidget(node, pos));
                  }
                }
                return false;
              });
              stale.push(...mapped.find(start, end));
            }

            return mapped.remove(stale).add(tr.doc, fresh);
          },
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
        },
      }),
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    const hasLevel = this.options.levels.includes(node.attrs.level);
    const level = hasLevel ? node.attrs.level : this.options.levels[0];

    return [
      `h${level}`,
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        id: node.attrs.id,
      }),
      0,
    ];
  },
});
