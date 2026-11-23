import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { TaskList } from "@tiptap/extension-list";
import { TaskItem } from "./task-item";

const editors: Editor[] = [];

function makeEditor(): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [Document, Paragraph, Text, TaskList, TaskItem],
    content: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "intro" }] },
        {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { checked: false },
              content: [
                { type: "paragraph", content: [{ type: "text", text: "task" }] },
              ],
            },
          ],
        },
      ],
    },
  });
  editors.push(editor);
  return editor;
}

// Tiptap focuses the editor inside requestAnimationFrame; wait past it.
const nextFrames = () =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

function tapCheckbox(editor: Editor) {
  const checkbox = editor.view.dom.querySelector<HTMLInputElement>(
    'li input[type="checkbox"]',
  );
  checkbox.checked = !checkbox.checked;
  checkbox.dispatchEvent(new Event("change", { bubbles: true }));
  return checkbox;
}

const firstTaskChecked = (editor: Editor) => {
  let checked: boolean;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "taskItem" && checked === undefined) {
      checked = node.attrs.checked;
    }
  });
  return checked;
};

afterEach(() => {
  for (const editor of editors.splice(0)) {
    const element = editor.options.element as HTMLElement;
    editor.destroy();
    element.remove();
  }
});

describe("TaskItem checkbox", () => {
  it("toggles the task without focusing a blurred editor", async () => {
    const editor = makeEditor();
    expect(editor.view.hasFocus()).toBe(false);

    tapCheckbox(editor);
    await nextFrames();

    expect(firstTaskChecked(editor)).toBe(true);
    expect(editor.view.hasFocus()).toBe(false);
    expect(document.activeElement).not.toBe(editor.view.dom);
  });

  it("leaves the task unchanged in a read-only editor", async () => {
    const editor = makeEditor();
    editor.setEditable(false);

    const checkbox = tapCheckbox(editor);
    await nextFrames();

    expect(firstTaskChecked(editor)).toBe(false);
    expect(checkbox.checked).toBe(false);
  });
});
