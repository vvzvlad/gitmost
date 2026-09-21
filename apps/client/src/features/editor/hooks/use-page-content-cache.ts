import type { MutableRefObject } from "react";
import { useDebouncedCallback } from "@mantine/hooks";
import type { Editor } from "@tiptap/react";
import { queryClient } from "@/main.tsx";
import { IPage } from "@/features/page/types/page.types.ts";

/**
 * Off-keystroke local page-cache updater (issue #343, PART 3).
 *
 * The editor's `onUpdate` fires on every keystroke — and, under collaboration,
 * on every REMOTE keystroke too. Serializing the WHOLE document with
 * `editor.getJSON()` on that hot path is expensive, and the previous 3s debounce
 * only guarded the cache WRITE, not the serialization: `getJSON()` still ran per
 * keystroke.
 *
 * This hook moves the serialization INSIDE the debounced callback, so the
 * full-doc traversal happens at most once per `delay`, not per keystroke. Call
 * the returned function from `onUpdate` (it only schedules the debounce); the
 * `getJSON()` snapshot is taken when the debounce fires.
 *
 * On unmount/navigation the pending snapshot is FLUSHED (via `flushOnUnmount`)
 * so the last edits within the debounce window aren't lost from the local cache.
 * The source of truth is collab/Yjs, but the cache must not go stale.
 *
 * IMPORTANT: call this hook BEFORE `useEditor`. React runs effect cleanups in
 * declaration order on unmount, so the debounce's flush cleanup must be declared
 * before `useEditor`'s teardown to run while the editor is still alive; the
 * `isDestroyed` guard keeps a flush that still races teardown safe (it skips).
 */
export function usePageContentCache(
  editorRef: MutableRefObject<Editor | null>,
  slugId: string | undefined,
  delay = 3000,
) {
  return useDebouncedCallback(
    () => {
      const e = editorRef.current;
      if (!e || e.isDestroyed || e.isEmpty) return;
      const pageData = queryClient.getQueryData<IPage>(["pages", slugId]);
      if (pageData) {
        // getJSON() (full-doc serialization) runs HERE, off the keystroke path.
        queryClient.setQueryData(["pages", slugId], {
          ...pageData,
          content: e.getJSON(),
        });
      }
    },
    { delay, flushOnUnmount: true },
  );
}
