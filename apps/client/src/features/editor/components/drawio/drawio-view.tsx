import { NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import {
  ActionIcon,
  Card,
  LoadingOverlay,
  Modal,
  Text,
  useComputedColorScheme,
} from "@mantine/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDisclosure } from "@mantine/hooks";
import { getDrawioUrl, isDrawioRasterEnabled } from "@/lib/config.ts";
import {
  DrawIoEmbed,
  DrawIoEmbedRef,
  EventExit,
  EventExport,
  EventSave,
} from "react-drawio";
import clsx from "clsx";
import { IconEdit } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { modals } from "@mantine/modals";
import { useDrawioRasterSave } from "./use-drawio-raster-save.ts";
import {
  markOperationStart,
  measureOperation,
} from "@/lib/telemetry/vitals";

export default function DrawioView(props: NodeViewProps) {
  const { t } = useTranslation();
  const { node, updateAttributes, editor, selected } = props;
  const drawioRef = useRef<DrawIoEmbedRef>(null);
  const [initialXML, setInitialXML] = useState<string>("");
  const [opened, { open, close }] = useDisclosure(false);
  const computedColorScheme = useComputedColorScheme();
  const isDirtyRef = useRef(false);

  const raster = useDrawioRasterSave<void>({
    getDrawio: () => drawioRef.current,
    // @ts-ignore — pageId is stashed on editor.storage by the editor host.
    getPageId: () => editor.storage?.pageId,
    getAttachmentId: () => node.attrs.attachmentId,
    // Autosave MUST NOT write `src`: the drawio.ts nodeview destroys the live
    // editor+iframe the moment `src` appears (see drawio.ts view.update rule).
    updateSrcOnAutoSave: false,
    rasterEnabled: isDrawioRasterEnabled(),
    beginTarget: () => undefined,
    applyAttributes: (attachment, updateSrc) => {
      if (updateSrc) {
        // NodeViewProps.updateAttributes targets THIS node, so it is already
        // position-safe (unlike the bubble-menu's selection-based write).
        updateAttributes({
          src: `/api/files/${attachment.id}/${attachment.fileName}?t=${new Date(attachment.updatedAt).getTime()}`,
          title: attachment.fileName,
          size: attachment.fileSize,
          attachmentId: attachment.id,
        });
      } else {
        updateAttributes({
          attachmentId: attachment.id,
        });
      }
      isDirtyRef.current = false;
    },
    t,
  });

  const handleOpen = async () => {
    if (!editor.isEditable) {
      return;
    }
    // #683 `diagram_drawio` — mark at the double-click that opens the editor;
    // measured at the drawio iframe's onLoad (render readiness). The node-view is
    // a light placeholder card until this open, so this captures the iframe load
    // the user waits for.
    markOperationStart("diagram_drawio");
    isDirtyRef.current = false;
    open();
  };

  const handleClose = useCallback(() => {
    if (!isDirtyRef.current) {
      close();
      return;
    }

    modals.openConfirmModal({
      title: t("Unsaved changes"),
      children: (
        <Text size="sm">
          {t("You have unsaved changes that will be lost.")}
        </Text>
      ),
      centered: true,
      labels: { confirm: t("Discard"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => {
        isDirtyRef.current = false;
        // Cancel any in-flight save so it cannot upload / write attributes
        // after the user discarded (A7).
        raster.cancel();
        close();
      },
    });
  }, [close, t, raster]);

  // Cancel any in-flight save on unmount so it cannot write to a torn-down node.
  useEffect(() => {
    return () => raster.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!opened) return;

    const interval = setInterval(() => {
      raster.autoSaveTick();
    }, 30_000);

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  useEffect(() => {
    if (!opened) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleClose();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [opened, handleClose]);

  return (
    <NodeViewWrapper data-drag-handle>
      <Modal.Root
        opened={opened}
        onClose={handleClose}
        fullScreen
        closeOnEscape={false}
        aria-label={t("Diagram editor")}
      >
        <Modal.Overlay />
        <Modal.Content style={{ overflow: "hidden" }}>
          <Modal.Body pos="relative">
            <LoadingOverlay visible={raster.isSaving} />
            <div style={{ height: "100vh" }}>
              <DrawIoEmbed
                ref={drawioRef}
                xml={initialXML}
                baseUrl={getDrawioUrl()}
                // #683 — the drawio editor iframe finished loading (render
                // readiness); report the open→ready latency (success path;
                // measureOperation consumes the mark set in handleOpen).
                onLoad={() => measureOperation("diagram_drawio")}
                autosave
                urlParameters={{
                  ui: computedColorScheme === "light" ? "kennedy" : "dark",
                  spin: true,
                  libraries: true,
                  saveAndExit: true,
                  noSaveBtn: true,
                }}
                onSave={(data: EventSave) => {
                  if (data.parentEvent !== "save") {
                    return;
                  }
                  raster.saveAndClose(data, close);
                }}
                onClose={(data: EventExit) => {
                  if (data.parentEvent) {
                    return;
                  }
                  handleClose();
                }}
                onAutoSave={() => {
                  isDirtyRef.current = true;
                  raster.markDirty();
                }}
                onExport={(data: EventExport) => {
                  raster.handleExport(data);
                }}
              />
            </div>
          </Modal.Body>
        </Modal.Content>
      </Modal.Root>

      <Card
        radius="md"
        onClick={(e) => e.detail === 2 && handleOpen()}
        p="xs"
        style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
        }}
        withBorder
        className={clsx(selected ? "ProseMirror-selectednode" : "")}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          <ActionIcon
            variant="transparent"
            color="gray"
            aria-label={t("Edit diagram")}
          >
            <IconEdit size={18} />
          </ActionIcon>

          <Text component="span" size="lg" c="dimmed">
            {t("Double-click to edit Draw.io diagram")}
          </Text>
        </div>
      </Card>
    </NodeViewWrapper>
  );
}
