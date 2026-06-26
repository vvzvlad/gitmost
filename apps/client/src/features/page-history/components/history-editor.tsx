import "@/features/editor/styles/index.css";
import { useEffect } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { mainExtensions } from "@/features/editor/extensions/extensions";
import { Title } from "@mantine/core";
import { DecorationSet } from "@tiptap/pm/view";
import historyClasses from "./css/history.module.css";
import { computeHistoryDiff } from "./history-diff.ts";
import { useAtom } from "jotai";
import {
  diffCountsAtom,
  highlightChangesAtom,
} from "@/features/page-history/atoms/history-atoms";

export interface HistoryEditorProps {
  title: string;
  content: any;
  previousContent?: any;
}

export function HistoryEditor({
  title,
  content,
  previousContent,
}: HistoryEditorProps) {
  const [highlightChanges] = useAtom(highlightChangesAtom);
  const [, setDiffCounts] = useAtom(diffCountsAtom);

  const editor = useEditor({
    extensions: mainExtensions,
    editable: false,
  });

  useEffect(() => {
    if (!editor || !content) return;

    // Pure diff computation lives in history-diff.ts; the component keeps the
    // editor side-effects (rendering the new content + wiring decorations).
    const { decorationSet, added, deleted, total } = computeHistoryDiff(
      editor.schema,
      content,
      previousContent,
    );

    editor.commands.setContent(content);

    // @ts-ignore
    setDiffCounts({ added, deleted, total });

    editor.setOptions({
      editorProps: {
        ...editor.options.editorProps,
        decorations: () =>
          highlightChanges ? decorationSet : DecorationSet.empty,
      },
    });
  }, [
    title,
    content,
    editor,
    previousContent,
    highlightChanges,
    setDiffCounts,
  ]);

  return (
    <div>
      <Title order={1}>{title}</Title>
      {editor && (
        <EditorContent
          editor={editor}
          className={historyClasses.historyEditor}
        />
      )}
    </div>
  );
}
