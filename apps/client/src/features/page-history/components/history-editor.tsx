import "@/features/editor/styles/index.css";
import { useEffect } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { mainExtensions } from "@/features/editor/extensions/extensions";
import { Title } from "@mantine/core";
import { DecorationSet } from "@tiptap/pm/view";
import historyClasses from "./css/history.module.css";
import { computeHistoryDiff } from "./history-diff.ts";
import { isVitalsActive, reportOperation } from "@/lib/telemetry/vitals";
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

    // #683 `history_diff` (Pattern B) — time the diff compute + content render.
    // This is pure client CPU (the ProseMirror change-set diff), the "до/после"
    // signal for #343/#342. Local performance.now() (not a shared mark) so a
    // second diff modal can never collide; sub-threshold diffs are dropped.
    const diffStart = isVitalsActive() ? performance.now() : 0;

    // Pure diff computation lives in history-diff.ts; the component keeps the
    // editor side-effects (rendering the new content + wiring decorations).
    const { decorationSet, added, deleted, total, failed } = computeHistoryDiff(
      editor.schema,
      content,
      previousContent,
    );

    editor.commands.setContent(content);

    if (diffStart) reportOperation("history_diff", performance.now() - diffStart);

    // @ts-ignore — jotai setter typing in this build resolves as non-callable
    // (pre-existing); the payload matches DiffCounts.
    setDiffCounts({ added, deleted, total, failed });

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
