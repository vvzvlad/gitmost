import { BubbleMenu as BaseBubbleMenu } from "@tiptap/react/menus";
import { posToDOMRect, findParentNode, useEditorState } from "@tiptap/react";
import { Node as PMNode } from "@tiptap/pm/model";
import React, { useCallback } from "react";
import { ActionIcon, Group, Tooltip } from "@mantine/core";
import { IconTrash, IconList, IconSitemap } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Editor } from "@tiptap/core";
import { isEditorReady } from "@docmost/editor-ext";

interface SubpagesMenuProps {
  editor: Editor;
}

interface ShouldShowProps {
  state: any;
  from?: number;
  to?: number;
}

export const SubpagesMenu = React.memo(
  ({ editor }: SubpagesMenuProps): JSX.Element => {
    const { t } = useTranslation();

    const shouldShow = useCallback(
      ({ state }: ShouldShowProps) => {
        if (!state) {
          return false;
        }

        return editor.isActive("subpages");
      },
      [editor]
    );

    const getReferenceClientRect = useCallback(() => {
      if (!isEditorReady(editor)) return new DOMRect();
      const { selection } = editor.state;
      const predicate = (node: PMNode) => node.type.name === "subpages";
      const parent = findParentNode(predicate)(selection);

      if (parent) {
        const dom = editor.view.nodeDOM(parent?.pos) as HTMLElement;
        return dom.getBoundingClientRect();
      }

      return posToDOMRect(editor.view, selection.from, selection.to);
    }, [editor]);

    const toggleRecursive = useCallback(() => {
      const current = editor.getAttributes("subpages")?.recursive ?? false;
      editor.commands.updateAttributes("subpages", {
        recursive: !current,
      });
    }, [editor]);

    const deleteNode = useCallback(() => {
      const { selection } = editor.state;
      editor
        .chain()
        .focus()
        .setNodeSelection(selection.from)
        .deleteSelection()
        .run();
    }, [editor]);

    // Subscribe to the live `recursive` attribute the standard way (as the
    // sibling bubble menus do): useEditorState re-renders only when the selected
    // value actually changes, so the mode icon/tooltip stay current after a
    // toggle without re-rendering on every keystroke.
    const isRecursive = useEditorState({
      editor,
      selector: (ctx) => ctx.editor?.getAttributes("subpages")?.recursive ?? false,
    });

    return (
      <BaseBubbleMenu
        editor={editor}
        pluginKey={`subpages-menu`}
        updateDelay={0}
        shouldShow={shouldShow}
      >
        <Group gap={4} wrap="nowrap">
          <Tooltip
            position="top"
            label={
              isRecursive
                ? t("Switch to flat list")
                : t("Switch to tree")
            }
          >
            <ActionIcon
              onClick={toggleRecursive}
              variant="default"
              size="lg"
              aria-label={t("Toggle subpages display mode")}
            >
              {isRecursive ? (
                <IconList size={18} />
              ) : (
                <IconSitemap size={18} />
              )}
            </ActionIcon>
          </Tooltip>

          <Tooltip position="top" label={t("Delete")}>
            <ActionIcon
              onClick={deleteNode}
              variant="default"
              size="lg"
              color="red"
              aria-label={t("Delete")}
            >
              <IconTrash size={18} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </BaseBubbleMenu>
    );
  }
);

export default SubpagesMenu;
