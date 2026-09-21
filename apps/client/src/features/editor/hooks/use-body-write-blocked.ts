import { useAtomValue } from "jotai";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { notifications } from "@mantine/notifications";
import { bodyWriteBlockedAtom } from "@/features/editor/atoms/editor-atoms";

/**
 * Guard for PROGRAMMATIC writes to the page body during the local-first
 * read-only window (#564, guard 2).
 *
 * In that window the body's Yjs write guard rejects every doc-changing
 * transaction, and `filterTransaction` gives the caller no feedback — so a
 * command like `editor.commands.setContent(...)` or `unsetComment(...)` returns
 * as if it worked while the document never changed. Typing is not affected (the
 * editor simply isn't editable), but every non-typing writer must call
 * `refuseIfBlocked()` FIRST and bail out when it returns true, rather than
 * proceeding to report success — or, worse, commit a server-side change (a
 * resolved/deleted comment) whose in-document mark never lands.
 *
 * @returns `refuseIfBlocked()` — true when the write must NOT proceed (a toast
 *   telling the user to wait for sync has been shown), false when it may.
 */
export function useBodyWriteBlocked(): {
  bodyWriteBlocked: boolean;
  refuseIfBlocked: () => boolean;
} {
  const { t } = useTranslation();
  const bodyWriteBlocked = useAtomValue(bodyWriteBlockedAtom);

  const refuseIfBlocked = useCallback(() => {
    if (!bodyWriteBlocked) return false;
    notifications.show({
      message: t(
        "Still syncing with the server — please wait for the connection and try again.",
      ),
      color: "red",
    });
    return true;
  }, [bodyWriteBlocked, t]);

  return { bodyWriteBlocked, refuseIfBlocked };
}
