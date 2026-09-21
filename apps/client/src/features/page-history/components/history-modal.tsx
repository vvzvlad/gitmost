import { Modal, Text } from "@mantine/core";
import { useAtom } from "jotai";
import { historyAtoms } from "@/features/page-history/atoms/history-atoms";
import HistoryModalDesktop from "@/features/page-history/components/history-modal-desktop";
import HistoryModalMobile from "@/features/page-history/components/history-modal-mobile";
import { useTranslation } from "react-i18next";
import { useMediaQuery } from "@mantine/hooks";

interface Props {
  pageId: string;
  pageTitle?: string;
}

export default function HistoryModal({ pageId, pageTitle }: Props) {
  const { t } = useTranslation();
  const [isModalOpen, setModalOpen] = useAtom(historyAtoms);
  const isMobile = useMediaQuery("(max-width: 800px)");

  if (isMobile) {
    return (
      <Modal.Root
        opened={isModalOpen}
        onClose={() => setModalOpen(false)}
        fullScreen
        aria-label={t("Page history")}
      >
        <Modal.Overlay />
        <Modal.Content style={{ overflow: "hidden" }}>
          <Modal.Header>
            <Modal.Title>
              <Text size="md" fw={500}>
                {t("Page history")}
              </Text>
            </Modal.Title>
            <Modal.CloseButton aria-label={t("Close")} />
          </Modal.Header>
          <Modal.Body
            p={0}
            style={{ height: "calc(100vh - 60px)", overflow: "hidden" }}
          >
            <HistoryModalMobile pageId={pageId} pageTitle={pageTitle} />
          </Modal.Body>
        </Modal.Content>
      </Modal.Root>
    );
  }

  // #568 — the redesigned desktop window carries its OWN single-row header
  // (title + selected label + diff nav + Restore + close), so the Modal chrome is
  // dropped for desktop and the body renders edge-to-edge.
  // #605 Fix B — a centered popup (overlay + rounded corners), NOT fullScreen.
  // Small xOffset/yOffset push it near the viewport edges; Mantine sizes the
  // content to `min(size, 100vw − 2·xOffset)`, so size="100%" makes it fill the
  // area inside the offsets = 100vw − 2·xOffset (a constant fraction of the
  // viewport at every width). xOffset is 1vw (not the wider 2.5vw): content is
  // then 98vw ≈ 1411px at a 1440px viewport and ≈1882px at 1920px — clearly
  // wider than the old 1400px cap at every common desktop width, whereas 2.5vw
  // would collapse to 1368px (< 1400) at 1440px.
  return (
    <Modal.Root
      size="100%"
      xOffset="1vw"
      yOffset="3vh"
      opened={isModalOpen}
      onClose={() => setModalOpen(false)}
      aria-label={t("Page history")}
    >
      <Modal.Overlay />
      <Modal.Content style={{ overflow: "hidden" }}>
        <Modal.Body p={0}>
          <HistoryModalDesktop
            pageId={pageId}
            onClose={() => setModalOpen(false)}
          />
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}
