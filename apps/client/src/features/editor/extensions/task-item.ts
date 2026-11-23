import { TaskItem as BaseTaskItem } from "@tiptap/extension-list";

/**
 * Task item whose checkbox toggles the task without focusing the editor.
 *
 * Tiptap's own checkbox handler runs `focus()` before the toggle. When the
 * editor is not focused, that focuses it with the selection it had before: on a
 * phone the keyboard opens and the browser scrolls to that old caret, away from
 * the checkbox the user tapped. Here the `change` event is caught on the label
 * in the capture phase, before it reaches tiptap's listener on the checkbox,
 * and the toggle is dispatched without touching focus or the selection. In a
 * read-only editor the event passes on to tiptap, which reverts the checkbox.
 */
export const TaskItem = BaseTaskItem.extend({
  addNodeView() {
    const createNodeView = this.parent?.();

    return (props) => {
      const nodeView = createNodeView(props);
      const label = (nodeView.dom as HTMLElement).querySelector(":scope > label");

      label?.addEventListener(
        "change",
        (event) => {
          const { editor, getPos } = props;
          if (!editor.isEditable) return;

          event.stopPropagation();
          const { checked } = event.target as HTMLInputElement;

          editor.commands.command(({ tr }) => {
            const pos = getPos();
            if (typeof pos !== "number") return false;
            tr.setNodeMarkup(pos, undefined, {
              ...tr.doc.nodeAt(pos)?.attrs,
              checked,
            });
            return true;
          });
        },
        { capture: true },
      );

      return nodeView;
    };
  },
});
