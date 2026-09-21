import { NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import {
  ActionIcon,
  Button,
  Card,
  Group,
  Text,
  useComputedColorScheme,
} from "@mantine/core";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { uploadFile } from "@/features/page/services/page-service.ts";
import { svgStringToFile } from "@/lib";
import { useDisclosure } from "@mantine/hooks";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { IAttachment } from "@/features/attachments/types/attachment.types";
import ReactClearModal from "react-clear-modal";
import clsx from "clsx";
import { IconEdit } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useHandleLibrary } from "@excalidraw/excalidraw";
import { localStorageLibraryAdapter } from "@/features/editor/components/excalidraw/excalidraw-utils.ts";
import {
  embedRasterIfWithinBudget,
  isValidExcalidrawSvg,
} from "@/features/editor/components/excalidraw/excalidraw-raster.ts";
import { isExcalidrawRasterEnabled } from "@/lib/config.ts";
import { modals } from "@mantine/modals";
import {
  markOperationStart,
  measureOperation,
} from "@/lib/telemetry/vitals";

/**
 * Read a Blob's bytes as a `data:<mime>;base64,<b64>` data-URI (#632, Part A).
 * FileReader.readAsDataURL yields the `data:image/png;base64,…` form the shared
 * raster contract expects directly, so no manual base64 step is needed.
 */
function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = () =>
      reject(reader.error ?? new Error("failed to read PNG blob"));
    reader.readAsDataURL(blob);
  });
}

const ExcalidrawComponent = lazy(() =>
  import("@excalidraw/excalidraw").then((module) => ({
    default: module.Excalidraw,
  })),
);

export default function ExcalidrawView(props: NodeViewProps) {
  const { t } = useTranslation();
  const { node, updateAttributes, editor, selected } = props;
  const { attachmentId } = node.attrs;

  const [excalidrawAPI, setExcalidrawAPI] =
    useState<ExcalidrawImperativeAPI>(null);
  useHandleLibrary({
    excalidrawAPI,
    adapter: localStorageLibraryAdapter,
  });
  const [excalidrawData, setExcalidrawData] = useState<any>(null);
  const [opened, { open, close }] = useDisclosure(false);
  const computedColorScheme = useComputedColorScheme();

  const isDirtyRef = useRef(false);
  const isSavingRef = useRef(false);
  const [isSaving, setIsSaving] = useState(false);
  const isInitialLoadRef = useRef(true);
  const lastFingerprintRef = useRef("");

  const handleOpen = async () => {
    if (!editor.isEditable) {
      return;
    }
    // #683 `diagram_excalidraw` — mark at the double-click that opens the editor;
    // measured when the lazily-loaded Excalidraw component mounts and hands back
    // its imperative API (render readiness). The node-view itself is a light
    // placeholder card until this open, so this captures the heavy chunk load +
    // editor mount the user actually waits for.
    markOperationStart("diagram_excalidraw");
    isDirtyRef.current = false;
    isInitialLoadRef.current = true;
    open();
  };

  const saveData = useCallback(async (updateSrc = true) => {
    if (!excalidrawAPI || isSavingRef.current) {
      return;
    }

    isSavingRef.current = true;
    setIsSaving(true);

    try {
      const { exportToSvg } = await import("@excalidraw/excalidraw");

      const svg = await exportToSvg({
        elements: excalidrawAPI?.getSceneElements(),
        appState: {
          exportEmbedScene: true,
          exportWithDarkMode: false,
        },
        files: excalidrawAPI?.getFiles(),
      });

      const serializer = new XMLSerializer();
      let svgString = serializer.serializeToString(svg);

      svgString = svgString.replace(
        /https:\/\/unpkg\.com\/@excalidraw\/excalidraw@undefined/g,
        "https://unpkg.com/@excalidraw/excalidraw@latest",
      );

      // #632, Part A: optionally embed a PNG raster of the SAME scene into the
      // saved .excalidraw.svg (as a root data-raster attribute), so the MCP
      // consumers can hand a real bitmap to habr-mcp instead of dropping the
      // unknown `excalidraw` node. Gated behind EXCALIDRAW_RASTER_ENABLED
      // (default off => today's svg-only save, byte-identical). Any failure here
      // (png export or over-budget) degrades to an svg-only save — the excalidraw
      // SVG is itself valid, so this is never a user-facing hard error.
      if (isExcalidrawRasterEnabled()) {
        try {
          const { exportToBlob } = await import("@excalidraw/excalidraw");
          const pngBlob = await exportToBlob({
            elements: excalidrawAPI.getSceneElements(),
            appState: {
              exportWithDarkMode: false,
              exportBackground: true,
            },
            files: excalidrawAPI.getFiles(),
            mimeType: "image/png",
          });
          const rasterDataUri = await blobToDataUri(pngBlob);
          const { svg: withRaster } = embedRasterIfWithinBudget(
            svgString,
            rasterDataUri,
          );
          svgString = withRaster;
        } catch (err) {
          // Over-budget is handled inside embedRasterIfWithinBudget (returns the
          // svg unchanged); this catch is for a genuine png-export/read failure.
          console.warn(
            "Excalidraw PNG raster export failed; saving without a raster preview.",
            err,
          );
        }
      }

      // Guardrail: never upload anything but a real SVG under the .svg name.
      if (!isValidExcalidrawSvg(svgString)) {
        throw new Error(
          "excalidraw save guardrail: refusing to upload a non-SVG file",
        );
      }

      const fileName = "diagram.excalidraw.svg";
      const excalidrawSvgFile = await svgStringToFile(svgString, fileName);

      // @ts-ignore
      const pageId = editor.storage?.pageId;

      let attachment: IAttachment = null;
      if (attachmentId) {
        attachment = await uploadFile(excalidrawSvgFile, pageId, attachmentId);
      } else {
        attachment = await uploadFile(excalidrawSvgFile, pageId);
      }

      if (updateSrc) {
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
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);
    }
  }, [excalidrawAPI, editor, attachmentId, updateAttributes]);

  const handleSaveAndExit = useCallback(async () => {
    try {
      await saveData();
      close();
    } catch {
      /* empty */
    }
  }, [saveData, close]);

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
        close();
      },
    });
  }, [close, t]);

  useEffect(() => {
    if (!opened) return;

    const interval = setInterval(() => {
      if (isDirtyRef.current && !isSavingRef.current) {
        saveData(false).catch(() => {});
      }
    }, 30_000);

    return () => clearInterval(interval);
  }, [opened, saveData]);

  return (
    <NodeViewWrapper data-drag-handle>
      <ReactClearModal
        style={{
          backgroundColor: "rgba(0, 0, 0, 0.5)",
          padding: 0,
          zIndex: 200,
        }}
        isOpen={opened}
        onRequestClose={handleClose}
        disableCloseOnBgClick={true}
        contentProps={{
          style: {
            padding: 0,
            width: "90vw",
          },
        }}
      >
        <Group
          justify="flex-end"
          wrap="nowrap"
          bg="var(--mantine-color-body)"
          p="xs"
        >
          <Button onClick={handleSaveAndExit} size={"compact-sm"} loading={isSaving}>
            {t("Save & Exit")}
          </Button>
          <Button onClick={handleClose} color="red" size={"compact-sm"}>
            {t("Exit")}
          </Button>
        </Group>
        <div style={{ height: "90vh" }}>
          <Suspense fallback={null}>
            <ExcalidrawComponent
              excalidrawAPI={(api) => {
                setExcalidrawAPI(api);
                // #683 — the editor is mounted and ready; report the open→ready
                // latency (success path; measureOperation consumes the mark).
                measureOperation("diagram_excalidraw");
              }}
              onChange={(elements, _appState, files) => {
                const fingerprint = `${elements.length}:${elements.reduce((s, e) => s + (e.version || 0), 0)}:${Object.keys(files).length}`;
                if (isInitialLoadRef.current) {
                  lastFingerprintRef.current = fingerprint;
                  isInitialLoadRef.current = false;
                  return;
                }
                if (fingerprint !== lastFingerprintRef.current) {
                  lastFingerprintRef.current = fingerprint;
                  isDirtyRef.current = true;
                }
              }}
              initialData={{
                ...excalidrawData,
                scrollToContent: true,
              }}
              theme={computedColorScheme}
            />
          </Suspense>
        </div>
      </ReactClearModal>

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
            aria-label={t("Edit drawing")}
          >
            <IconEdit size={18} />
          </ActionIcon>

          <Text component="span" size="lg" c="dimmed">
            {t("Double-click to edit Excalidraw diagram")}
          </Text>
        </div>
      </Card>
    </NodeViewWrapper>
  );
}
