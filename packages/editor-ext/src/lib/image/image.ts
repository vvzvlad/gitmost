import Image from "@tiptap/extension-image";
import { ImageOptions as DefaultImageOptions } from "@tiptap/extension-image";
import { ReactNodeViewRenderer } from "@tiptap/react";
import {
  mergeAttributes,
  Range,
} from "@tiptap/core";
import { ResizableNodeView } from "../resizable-nodeview";
import type { ResizableNodeViewDirection } from "../resizable-nodeview";
import { normalizeFileUrl } from "../media-utils";

export type ImageResizeOptions = {
  enabled: boolean;
  directions?: ResizableNodeViewDirection[];
  minWidth?: number;
  minHeight?: number;
  alwaysPreserveAspectRatio?: boolean;
  createCustomHandle?: (direction: ResizableNodeViewDirection) => HTMLElement;
  className?: {
    container?: string;
    wrapper?: string;
    handle?: string;
    resizing?: string;
  };
};

export interface ImageOptions extends DefaultImageOptions {
  view: any;
  resize: ImageResizeOptions | false;
}

export interface ImageAttributes {
  src?: string;
  alt?: string;
  caption?: string;
  align?: string;
  attachmentId?: string;
  size?: number;
  width?: number | string;
  height?: number;
  aspectRatio?: number;
  placeholder?: {
    id: string;
    name: string;
  };
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    imageBlock: {
      setImage: (attributes: ImageAttributes) => ReturnType;
      setImageAt: (
        attributes: ImageAttributes & { pos: number | Range },
      ) => ReturnType;
      setImageAlign: (
        align:
          | "left"
          | "center"
          | "right"
          | "floatLeft"
          | "floatRight"
          | "inline",
      ) => ReturnType;
      setImageWidth: (width: number) => ReturnType;
      setImageSize: (width: number, height: number) => ReturnType;
    };
  }
}

export const TiptapImage = Image.extend<ImageOptions>({
  name: "image",

  inline: false,
  group: "block",
  isolating: true,
  atom: true,
  defining: true,

  addOptions() {
    return {
      ...this.parent?.(),
      view: null,
      resize: false,
    };
  },

  addAttributes() {
    return {
      src: {
        default: "",
        parseHTML: (element) => element.getAttribute("src"),
        renderHTML: (attributes) => ({
          src: attributes.src,
        }),
      },
      width: {
        default: null,
        parseHTML: (element) => {
          const raw = element.getAttribute("width");
          if (!raw) return null;
          if (raw.endsWith("%")) return raw;
          const num = parseFloat(raw);
          return isNaN(num) ? null : num;
        },
        renderHTML: (attributes: ImageAttributes) => ({
          width: attributes.width,
        }),
      },
      height: {
        default: null,
        parseHTML: (element) => {
          const raw = element.getAttribute("height");
          if (!raw) return null;
          const num = parseFloat(raw);
          return isNaN(num) ? null : num;
        },
        renderHTML: (attributes: ImageAttributes) => ({
          height: attributes.height,
        }),
      },
      align: {
        default: "center",
        parseHTML: (element) => element.getAttribute("data-align"),
        renderHTML: (attributes: ImageAttributes) => ({
          "data-align": attributes.align,
        }),
      },
      alt: {
        default: undefined,
        parseHTML: (element) => element.getAttribute("alt"),
        renderHTML: (attributes: ImageAttributes) => ({
          alt: attributes.alt,
        }),
      },
      caption: {
        default: undefined,
        parseHTML: (element) => element.getAttribute("data-caption") || undefined,
        // Emit data-caption only when set, so caption-less images stay clean.
        renderHTML: (attributes: ImageAttributes) =>
          attributes.caption ? { "data-caption": attributes.caption } : {},
      },
      attachmentId: {
        default: undefined,
        parseHTML: (element) => element.getAttribute("data-attachment-id"),
        renderHTML: (attributes: ImageAttributes) => ({
          "data-attachment-id": attributes.attachmentId,
        }),
      },
      size: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-size"),
        renderHTML: (attributes: ImageAttributes) => ({
          "data-size": attributes.size,
        }),
      },
      aspectRatio: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-aspect-ratio"),
        renderHTML: (attributes: ImageAttributes) => ({
          "data-aspect-ratio": attributes.aspectRatio,
        }),
      },
      placeholder: {
        default: null,
        rendered: false,
      },
    };
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "img",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes),
    ];
  },

  addCommands() {
    return {
      setImage:
        (attrs: ImageAttributes) =>
        ({ commands }) => {
          return commands.insertContent({
            type: "image",
            attrs: attrs,
          });
        },

      setImageAt:
        (attrs) =>
        ({ commands }) => {
          return commands.insertContentAt(attrs.pos, {
            type: "image",
            attrs: attrs,
          });
        },

      setImageAlign:
        (align) =>
        ({ commands }) =>
          commands.updateAttributes("image", { align }),

      setImageWidth:
        (width) =>
        ({ commands }) =>
          commands.updateAttributes("image", { width }),

      setImageSize:
        (width, height) =>
        ({ commands }) =>
          commands.updateAttributes("image", { width, height }),
    };
  },

  addNodeView() {
    const resize = this.options.resize;

    if (!resize || !resize.enabled) {
      // Fallback to React node view (existing behavior)
      this.editor.isInitialized = true;
      return ReactNodeViewRenderer(this.options.view);
    }

    const {
      directions,
      minWidth,
      minHeight,
      alwaysPreserveAspectRatio,
      createCustomHandle,
      className,
    } = resize;

    return (props) => {
      const { node, getPos, HTMLAttributes, editor } = props;

      // If no src yet (placeholder/uploading), use React view for loading UI
      if (!HTMLAttributes.src) {
        editor.isInitialized = true;
        const reactView = ReactNodeViewRenderer(this.options.view);
        const view = reactView(props);

        // When the node gets a src, return false from update to force rebuild
        const originalUpdate = view.update?.bind(view);
        view.update = (updatedNode, decorations, innerDecorations) => {
          if (updatedNode.attrs.src && !node.attrs.src) {
            return false;
          }
          if (originalUpdate) {
            return originalUpdate(updatedNode, decorations, innerDecorations);
          }
          return true;
        };

        return view;
      }

      // Has src — use ResizableNodeView
      const el = document.createElement("img");

      Object.entries(HTMLAttributes).forEach(([key, value]) => {
        if (value != null) {
          switch (key) {
            case "width":
            case "height":
              break;
            default:
              el.setAttribute(key, String(value));
              break;
          }
        }
      });

      el.src = normalizeFileUrl(HTMLAttributes.src);
      el.style.display = "block";
      el.style.maxWidth = "100%";
      el.style.borderRadius = "8px";

      if (typeof node.attrs.width === "number" && node.attrs.width > 0) {
        el.style.width = `${node.attrs.width}px`;
        if (typeof node.attrs.height === "number" && node.attrs.height > 0) {
          el.style.height = `${node.attrs.height}px`;
        }
      }

      let currentNode = node;

      const nodeView = new ResizableNodeView({
        element: el,
        editor,
        node,
        getPos,
        onResize: (w, h) => {
          el.style.width = `${w}px`;
          el.style.height = `${h}px`;
        },
        onCommit: () => {
          const pos = getPos();
          if (pos === undefined) return;

          this.editor
            .chain()
            .setNodeSelection(pos)
            .updateAttributes(this.name, {
              width: Math.round(el.offsetWidth),
              height: Math.round(el.offsetHeight),
            })
            .run();
        },
        onUpdate: (updatedNode, _decorations, _innerDecorations) => {
          if (updatedNode.type !== currentNode.type) {
            return false;
          }

          if (updatedNode.attrs.src !== currentNode.attrs.src) {
            el.src = normalizeFileUrl(updatedNode.attrs.src);
          }

          if (updatedNode.attrs.alt !== currentNode.attrs.alt) {
            el.alt = updatedNode.attrs.alt || "";
          }

          if (updatedNode.attrs.caption !== currentNode.attrs.caption) {
            applyCaption(updatedNode.attrs.caption);
          }

          const w = updatedNode.attrs.width;
          const h = updatedNode.attrs.height;
          if (w != null) {
            el.style.width = `${w}px`;
          }
          if (h != null) {
            el.style.height = `${h}px`;
          }

          // Update alignment on container
          const align = updatedNode.attrs.align || "center";
          const container = nodeView.dom as HTMLElement;
          applyAlignment(container, align);

          currentNode = updatedNode;
          return true;
        },
        options: {
          directions,
          min: {
            width: minWidth,
            height: minHeight,
          },
          preserveAspectRatio: alwaysPreserveAspectRatio === true,
          createCustomHandle,
          className,
        },
      });

      const dom = nodeView.dom as HTMLElement;

      // Re-parent the resizable wrapper into a <figure> so the caption sits BELOW
      // the image, OUTSIDE nodeView.wrapper. onCommit measures the img's
      // offsetHeight for the persisted height/aspectRatio, and the left/right
      // resize handles span the wrapper — both must cover the image only. The
      // <figure> stays the single flex child of the container, so applyAlignment
      // and the float modes keep working. This path also drives read-only/share.
      const figure = document.createElement("figure");
      figure.style.margin = "0";
      figure.style.display = "inline-block"; // shrink-to-fit to image width
      figure.appendChild(nodeView.wrapper);
      dom.appendChild(figure);

      const figcaption = document.createElement("figcaption");
      figcaption.className = "image-caption";
      const applyCaption = (text?: string) => {
        const value = (text || "").trim();
        figcaption.textContent = value;
        figcaption.style.display = value ? "block" : "none";
      };
      applyCaption(node.attrs.caption);
      figure.appendChild(figcaption);

      // Apply initial alignment
      applyAlignment(dom, node.attrs.align || "center");

      // Handle percentage width backward compat
      const widthAttr = node.attrs.width;
      if (typeof widthAttr === "string" && widthAttr.endsWith("%")) {
        // Defer conversion until we can measure the container
        requestAnimationFrame(() => {
          const parentEl = dom.parentElement;
          if (parentEl) {
            const containerWidth = parentEl.clientWidth;
            const pctValue = parseInt(widthAttr, 10);
            if (!isNaN(pctValue) && containerWidth > 0) {
              const pxWidth = Math.round(
                containerWidth * (pctValue / 100),
              );
              el.style.width = `${pxWidth}px`;
              if (node.attrs.aspectRatio) {
                el.style.height = `${Math.round(pxWidth / node.attrs.aspectRatio)}px`;
              }
            }
          }
          dom.style.visibility = "";
          dom.style.pointerEvents = "";
        });
      }

      // Show skeleton background while image loads from server
      dom.style.pointerEvents = "none";
      el.classList.add("media-pulse");

      el.onload = () => {
        dom.style.pointerEvents = "";
        el.classList.remove("media-pulse");
      };

      return nodeView;
    };
  },
});

export function applyAlignment(container: HTMLElement, align: string) {
  // Reset the float-mode styles first so toggling between any two modes is clean
  // (a previous float must not leak into a later left/center/right).
  container.style.cssFloat = "";
  container.style.padding = "";
  // The ResizableNodeView constructor sets an inline `display: flex` on the
  // container; the inline mode overrides it with `inline-block`, so the reset
  // restores the constructor's flex here. This keeps the container's layout
  // independent of any app-level CSS class (which also happens to set flex)
  // and makes non-inline modes carry exactly the same inline styles as before
  // the inline mode existed.
  container.style.display = "flex";
  container.style.verticalAlign = "";
  // Mirror the resolved alignment onto the CONTAINER as a data attribute so the
  // responsive stylesheet can neutralize the float on small screens (an inline
  // `float` can only be overridden by `!important`, which keys off this attr).
  container.dataset.imageAlign = align;

  if (align === "floatLeft") {
    // Real text wrap: the (shrink-to-fit) container floats left, text flows on
    // its right. The inner <img> already carries max-width:100%.
    container.style.cssFloat = "left";
    container.style.padding = "0 10px 0 0";
    container.style.justifyContent = "flex-start";
  } else if (align === "floatRight") {
    container.style.cssFloat = "right";
    container.style.padding = "0 0 0 10px";
    container.style.justifyContent = "flex-end";
  } else if (align === "inline") {
    // Consecutive inline images sit side by side on one line box and wrap to
    // the next line when the viewport is narrow. The right/bottom padding
    // provides the gap between images in a row and between wrapped rows;
    // vertical-align: top keeps rows of different-height images aligned by
    // their top edge.
    container.style.display = "inline-block";
    container.style.verticalAlign = "top";
    container.style.padding = "0 10px 10px 0";
  } else if (align === "left") {
    container.style.justifyContent = "flex-start";
  } else if (align === "right") {
    container.style.justifyContent = "flex-end";
  } else {
    container.style.justifyContent = "center";
  }
}
