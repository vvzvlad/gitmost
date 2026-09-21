import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useParams } from "react-router-dom";
import {
  activeHistoryIdAtom,
  historyAtoms,
} from "@/features/page-history/atoms/history-atoms";
import { usePageHistoryQuery } from "@/features/page-history/queries/page-history-query";
import {
  pageEditorAtom,
  titleEditorAtom,
} from "@/features/editor/atoms/editor-atoms";
import { useBodyWriteBlocked } from "@/features/editor/hooks/use-body-write-blocked";
import {
  markOperationStart,
  measureOperation,
} from "@/lib/telemetry/vitals";
import { useSpaceAbility } from "@/features/space/permissions/use-space-ability";
import { useSpaceQuery } from "@/features/space/queries/space-query";
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from "@/features/space/permissions/permissions.type";

export function useHistoryRestore() {
  const { t } = useTranslation();

  const activeHistoryId = useAtomValue(activeHistoryIdAtom);
  const { data: activeHistoryData } = usePageHistoryQuery(activeHistoryId);

  const mainEditor = useAtomValue(pageEditorAtom);
  const mainEditorTitle = useAtomValue(titleEditorAtom);
  const setHistoryModalOpen = useSetAtom(historyAtoms);
  // #564 — the body's Yjs write guard is rejecting every doc change (local-first
  // read-only window). `setContent` below would be silently dropped, so restoring
  // now would toast "Successfully restored" over an unchanged document.
  const { refuseIfBlocked } = useBodyWriteBlocked();

  const { spaceSlug } = useParams();
  const { data: space } = useSpaceQuery(spaceSlug);
  const spaceAbility = useSpaceAbility(space?.membership?.permissions);

  const canRestore = spaceAbility.can(
    SpaceCaslAction.Manage,
    SpaceCaslSubject.Page,
  );

  const handleRestore = useCallback(() => {
    if (!activeHistoryData) return;

    // Refuse rather than lie: the write would not reach the document (#564).
    // Checked here (not only on the button) so the confirm-modal window — the
    // user can open it before the socket drops and confirm after — is covered.
    if (refuseIfBlocked()) return;

    // #683 `history_restore` — mark at the confirmed restore; measured once the
    // main editor has been rebuilt AND repainted (double-rAF), which is what the
    // user actually waits for. Only runs on the success path (past refuseIfBlocked).
    markOperationStart("history_restore");

    mainEditorTitle
      .chain()
      .clearContent()
      .setContent(activeHistoryData.title, { emitUpdate: true })
      .run();

    mainEditor
      .chain()
      .clearContent()
      .setContent(activeHistoryData.content)
      .run();

    // Measure after the rebuilt document paints (render → paint), not just after
    // setContent returns. best-effort: skip if rAF is unavailable.
    try {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => measureOperation("history_restore")),
      );
    } catch {
      measureOperation("history_restore");
    }

    setHistoryModalOpen(false);
    notifications.show({ message: t("Successfully restored") });
  }, [
    activeHistoryData,
    refuseIfBlocked,
    mainEditor,
    mainEditorTitle,
    setHistoryModalOpen,
    t,
  ]);

  const confirmRestore = useCallback(() => {
    modals.openConfirmModal({
      title: t("Please confirm your action"),
      children: (
        <Text size="sm">
          {t(
            "Are you sure you want to restore this version? Any changes not versioned will be lost.",
          )}
        </Text>
      ),
      labels: { confirm: t("Confirm"), cancel: t("Cancel") },
      onConfirm: handleRestore,
    });
  }, [t, handleRestore]);

  return { canRestore, confirmRestore };
}
