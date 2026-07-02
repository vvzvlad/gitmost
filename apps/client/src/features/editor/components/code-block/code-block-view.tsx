import { NodeViewContent, NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import { ActionIcon, Group, Select, Tooltip } from "@mantine/core";
import { CopyButton } from "@/components/common/copy-button";
import { useEffect, useState } from "react";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import classes from "./code-block.module.css";
import React from "react";
import { Suspense } from "react";
import { useTranslation } from "react-i18next";

const MermaidView = React.lazy(
  () => import("@/features/editor/components/code-block/mermaid-view.tsx"),
);

export default function CodeBlockView(props: NodeViewProps) {
  const { t } = useTranslation();
  const { node, updateAttributes, extension, editor, getPos } = props;
  const { language } = node.attrs;
  const [languageValue, setLanguageValue] = useState<string | null>(
    language || null,
  );
  const [isSelected, setIsSelected] = useState(false);

  useEffect(() => {
    const updateSelection = () => {
      const { state } = editor;
      const { from, to } = state.selection;
      // Check if the selection intersects with the node's range
      const isNodeSelected =
        (from >= getPos() && from < getPos() + node.nodeSize) ||
        (to > getPos() && to <= getPos() + node.nodeSize);
      setIsSelected(isNodeSelected);
    };

    editor.on("selectionUpdate", updateSelection);
    return () => {
      editor.off("selectionUpdate", updateSelection);
    };
  }, [editor, getPos(), node.nodeSize]);

  function changeLanguage(language: string) {
    setLanguageValue(language);
    updateAttributes({
      language: language,
    });
  }

  return (
    <NodeViewWrapper className="codeBlock">
      {/* #146: the editable <pre><code> (contentDOM) MUST come first in the DOM.
          With the non-editable menu rendered before it, the browser's click
          hit-testing snapped the caret up one line. Render content first; the
          menu is rendered after it and floated into the top-right corner as an
          absolute overlay (see `.menuGroup` in code-block.module.css, anchored
          to the `position: relative` `.codeBlock` wrapper in code.css). It no
          longer takes a full-width row above the code. The second #146
          mitigation lives in editor-paste-handler.tsx (reflowAfterPaste). */}
      <pre
        spellCheck="false"
        hidden={
          ((language === "mermaid" && !editor.isEditable) ||
            (language === "mermaid" && !isSelected)) &&
          node.textContent.length > 0
        }
      >
        {/* @ts-ignore */}
        <NodeViewContent as="code" className={`language-${language}`} />
      </pre>

      <Group contentEditable={false} className={classes.menuGroup}>
        {/* In read-only (published) there is no language selector at all —
            only the copy button. When editable the selector is hidden until
            the block is hovered/focused (or its dropdown is open) via the
            `.languageSelect` class (see code-block.module.css). */}
        {editor.isEditable && (
          <Select
            placeholder="auto"
            checkIconPosition="right"
            data={extension.options.lowlight.listLanguages().sort()}
            value={languageValue}
            onChange={changeLanguage}
            searchable
            style={{ maxWidth: "130px" }}
            classNames={{ root: classes.languageSelect, input: classes.selectInput }}
          />
        )}

        <CopyButton value={node?.textContent} timeout={2000}>
          {({ copied, copy }) => (
            <Tooltip
              label={copied ? t("Copied") : t("Copy")}
              withArrow
              position="right"
            >
              <ActionIcon
                color={copied ? "teal" : "gray"}
                variant="subtle"
                onClick={copy}
              >
                {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
              </ActionIcon>
            </Tooltip>
          )}
        </CopyButton>
      </Group>

      {language === "mermaid" && (
        <Suspense fallback={null}>
          <MermaidView props={props} />
        </Suspense>
      )}
    </NodeViewWrapper>
  );
}
