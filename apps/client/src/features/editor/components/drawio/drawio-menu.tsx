import { BubbleMenu as BaseBubbleMenu } from "@tiptap/react/menus";
import { findParentNode, posToDOMRect, useEditorState } from "@tiptap/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Node as PMNode } from "@tiptap/pm/model";
import { isEditorReady } from "@docmost/editor-ext";
import {
  EditorMenuProps,
  ShouldShowProps,
} from "@/features/editor/components/table/types/types.ts";
import {
  ActionIcon,
  LoadingOverlay,
  Modal,
  Text,
  Tooltip,
  useComputedColorScheme,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import clsx from "clsx";
import {
  IconLayoutAlignCenter,
  IconLayoutAlignLeft,
  IconLayoutAlignRight,
  IconDownload,
  IconEdit,
  IconTrash,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { getDrawioUrl, getFileUrl, isDrawioRasterEnabled } from "@/lib/config.ts";
import {
  DrawIoEmbed,
  DrawIoEmbedRef,
  EventExit,
  EventExport,
  EventSave,
} from "react-drawio";
import { decodeBase64ToSvgString } from "@/lib/utils";
import { modals } from "@mantine/modals";
import { useAltTextControl } from "@/features/editor/components/common/use-alt-text-control.tsx";
import { useDrawioRasterSave } from "./use-drawio-raster-save.ts";
import classes from "../common/toolbar-menu.module.css";

// The write target captured at the START of a save so the eventual node write
// is pinned to the right diagram even if the selection moved during the async
// save (A7). `attachmentId` is the identity guard.
type DrawioMenuTarget = { pos: number | null; attachmentId: string | undefined };

export function DrawioMenu({ editor }: EditorMenuProps) {
  const { t } = useTranslation();
  const [opened, { open, close }] = useDisclosure(false);
  const [initialXML, setInitialXML] = useState<string>("");
  const drawioRef = useRef<DrawIoEmbedRef>(null);
  const computedColorScheme = useComputedColorScheme();
  const isDirtyRef = useRef(false);
  const savingTargetRef = useRef<DrawioMenuTarget | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const editorState = useEditorState({
    editor,
    selector: (ctx) => {
      if (!ctx.editor) {
        return null;
      }

      const drawioAttr = ctx.editor.getAttributes("drawio");
      return {
        isDrawio: ctx.editor.isActive("drawio"),
        isAlignLeft: ctx.editor.isActive("drawio", { align: "left" }),
        isAlignCenter: ctx.editor.isActive("drawio", { align: "center" }),
        isAlignRight: ctx.editor.isActive("drawio", { align: "right" }),
        src: drawioAttr?.src || null,
        attachmentId: drawioAttr?.attachmentId || null,
        alt: drawioAttr?.alt || "",
      };
    },
  });

  const shouldShow = useCallback(
    ({ state }: ShouldShowProps) => {
      if (!state) {
        return false;
      }

      return editor.isActive("drawio") && editor.getAttributes("drawio")?.src;
    },
    [editor],
  );

  const getReferencedVirtualElement = useCallback(() => {
    if (!isEditorReady(editor)) return;
    const { selection } = editor.state;
    const predicate = (node: PMNode) => node.type.name === "drawio";
    const parent = findParentNode(predicate)(selection);

    if (parent) {
      const dom = editor.view.nodeDOM(parent?.pos) as HTMLElement;
      const domRect = dom.getBoundingClientRect();
      return {
        getBoundingClientRect: () => domRect,
        getClientRects: () => [domRect],
      };
    }

    const domRect = posToDOMRect(editor.view, selection.from, selection.to);
    return {
      getBoundingClientRect: () => domRect,
      getClientRects: () => [domRect],
    };
  }, [editor]);

  const alignLeft = useCallback(() => {
    editor
      .chain()
      .focus(undefined, { scrollIntoView: false })
      .setDrawioAlign("left")
      .run();
  }, [editor]);

  const alignCenter = useCallback(() => {
    editor
      .chain()
      .focus(undefined, { scrollIntoView: false })
      .setDrawioAlign("center")
      .run();
  }, [editor]);

  const alignRight = useCallback(() => {
    editor
      .chain()
      .focus(undefined, { scrollIntoView: false })
      .setDrawioAlign("right")
      .run();
  }, [editor]);

  const handleDownload = useCallback(() => {
    if (!editorState?.src) return;
    const url = getFileUrl(editorState.src);
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    a.click();
  }, [editorState?.src]);

  const handleDelete = useCallback(() => {
    editor.commands.deleteSelection();
  }, [editor]);

  const {
    button: altTextButton,
    panel: altTextPanel,
    isEditing: isEditingAlt,
  } = useAltTextControl({
    editor,
    nodeName: "drawio",
    currentAlt: editorState?.alt || "",
  });

  const raster = useDrawioRasterSave<DrawioMenuTarget>({
    getDrawio: () => drawioRef.current,
    // @ts-ignore — pageId is stashed on editor.storage by the editor host.
    getPageId: () => editor.storage?.pageId,
    // The attachment being overwritten is the one captured at save-start, not
    // whatever is selected when the async save completes.
    getAttachmentId: () =>
      savingTargetRef.current?.attachmentId ?? editorState?.attachmentId,
    // The bubble menu is NOT the destroyable nodeview (the diagram already has a
    // src), so writing src from autosave is safe here.
    updateSrcOnAutoSave: true,
    rasterEnabled: isDrawioRasterEnabled(),
    beginTarget: () => {
      const target = captureDrawioTarget();
      savingTargetRef.current = target;
      return target;
    },
    applyAttributes: (attachment, _updateSrc, target) => {
      writePinnedAttributes(target, {
        src: `/api/files/${attachment.id}/${attachment.fileName}?t=${new Date(attachment.updatedAt).getTime()}`,
        title: attachment.fileName,
        size: attachment.fileSize,
        attachmentId: attachment.id,
      });
      isDirtyRef.current = false;
    },
    t,
  });

  // Capture the position + attachmentId of the drawio node being edited at the
  // moment a save starts (A7).
  const captureDrawioTarget = useCallback((): DrawioMenuTarget => {
    const { selection } = editor.state;
    let attachmentId = editorState?.attachmentId ?? undefined;
    const nodeAtFrom = editor.state.doc.nodeAt(selection.from);
    if (nodeAtFrom?.type.name === "drawio") {
      return { pos: selection.from, attachmentId: nodeAtFrom.attrs.attachmentId };
    }
    let pos: number | null = null;
    if (attachmentId) {
      editor.state.doc.descendants((n, p) => {
        if (n.type.name === "drawio" && n.attrs.attachmentId === attachmentId) {
          pos = p;
          return false;
        }
        return true;
      });
    }
    return { pos, attachmentId };
  }, [editor, editorState?.attachmentId]);

  // Position-pinned write (A7): resolve the target node by the captured position
  // when it still holds the same node, else by the captured attachmentId
  // (identity guard), and setNodeMarkup there — never against the CURRENT
  // selection, which may have moved during the async save.
  const writePinnedAttributes = useCallback(
    (target: DrawioMenuTarget, attrs: Record<string, unknown>) => {
      const { state } = editor.view;
      const capturedId = target.attachmentId;
      let targetPos: number | null = null;

      const nodeAtPos =
        target.pos != null ? state.doc.nodeAt(target.pos) : null;
      if (
        nodeAtPos?.type.name === "drawio" &&
        nodeAtPos.attrs.attachmentId === capturedId
      ) {
        targetPos = target.pos;
      } else if (capturedId) {
        state.doc.descendants((n, p) => {
          if (n.type.name === "drawio" && n.attrs.attachmentId === capturedId) {
            targetPos = p;
            return false;
          }
          return true;
        });
      }

      if (targetPos == null) return; // node gone — do not write the wrong node
      const existing = state.doc.nodeAt(targetPos);
      if (!existing) return;
      const tr = state.tr.setNodeMarkup(targetPos, undefined, {
        ...existing.attrs,
        ...attrs,
      });
      editor.view.dispatch(tr);
    },
    [editor],
  );

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
        // Cancel any in-flight save so it cannot upload / write after discard (A7).
        raster.cancel();
        close();
      },
    });
  }, [close, t, raster]);

  const handleOpen = useCallback(async () => {
    if (!editorState?.src) return;

    setIsLoading(true);
    try {
      const url = getFileUrl(editorState.src);
      const request = await fetch(url, {
        credentials: "include",
        cache: "no-store",
      });
      const blob = await request.blob();

      const reader = new FileReader();
      reader.readAsDataURL(blob);
      reader.onloadend = () => {
        const base64data = (reader.result || "") as string;
        // draw.io atob-decodes a base64 data: URL as Latin-1, mojibaking every
        // multibyte UTF-8 char (e.g. Cyrillic) inside the SVG content= payload.
        // Hand the editor a proper UTF-8-decoded SVG string instead. This only
        // decodes the OUTER data-URL base64 (the SVG wrapper); a legacy inner
        // base64 content= is left verbatim, so old diagrams still open (#584).
        // onloadend runs after this function's try/catch has returned, so guard
        // the decode here: a non-SVG/empty blob (e.g. a 404 body) would make
        // decodeBase64ToSvgString throw uncaught — fall back to the raw payload.
        try {
          setInitialXML(decodeBase64ToSvgString(base64data));
        } catch (err) {
          console.error(err);
          setInitialXML(base64data);
        }
      };
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
      isDirtyRef.current = false;
      open();
    }
  }, [editorState?.src, open]);

  // Cancel any in-flight save on unmount so it cannot upload / write after the
  // menu tears down (A7).
  useEffect(() => {
    return () => raster.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!opened) return;

    const interval = setInterval(() => {
      raster.autoSaveTick();
    }, 60_000);

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
    <>
      <BaseBubbleMenu
        editor={editor}
        pluginKey={`drawio-menu`}
        updateDelay={0}
        getReferencedVirtualElement={getReferencedVirtualElement}
        options={{
          placement: "top",
          offset: 8,
          flip: false,
        }}
        shouldShow={shouldShow}
      >
        {isEditingAlt ? (
          altTextPanel
        ) : (
          <div className={classes.toolbar}>
          <Tooltip position="top" label={t("Align left")} withinPortal={false}>
            <ActionIcon
              onClick={alignLeft}
              size="lg"
              aria-label={t("Align left")}
              variant="subtle"
              className={clsx({ [classes.active]: editorState?.isAlignLeft })}
            >
              <IconLayoutAlignLeft size={18} />
            </ActionIcon>
          </Tooltip>

          <Tooltip
            position="top"
            label={t("Align center")}
            withinPortal={false}
          >
            <ActionIcon
              onClick={alignCenter}
              size="lg"
              aria-label={t("Align center")}
              variant="subtle"
              className={clsx({ [classes.active]: editorState?.isAlignCenter })}
            >
              <IconLayoutAlignCenter size={18} />
            </ActionIcon>
          </Tooltip>

          <Tooltip position="top" label={t("Align right")}>
            <ActionIcon
              onClick={alignRight}
              size="lg"
              aria-label={t("Align right")}
              variant="subtle"
              className={clsx({ [classes.active]: editorState?.isAlignRight })}
            >
              <IconLayoutAlignRight size={18} />
            </ActionIcon>
          </Tooltip>

          <div className={classes.divider} />

          {altTextButton}

          <div className={classes.divider} />

          <Tooltip position="top" label={t("Edit")} withinPortal={false}>
            <ActionIcon
              onClick={handleOpen}
              size="lg"
              aria-label={t("Edit")}
              variant="subtle"
              loading={isLoading}
            >
              <IconEdit size={18} />
            </ActionIcon>
          </Tooltip>

          <Tooltip position="top" label={t("Download")} withinPortal={false}>
            <ActionIcon
              onClick={handleDownload}
              size="lg"
              aria-label={t("Download")}
              variant="subtle"
            >
              <IconDownload size={18} />
            </ActionIcon>
          </Tooltip>

          <Tooltip position="top" label={t("Delete")} withinPortal={false}>
            <ActionIcon
              onClick={handleDelete}
              size="lg"
              aria-label={t("Delete")}
              variant="subtle"
            >
              <IconTrash size={18} />
            </ActionIcon>
          </Tooltip>
          </div>
        )}
      </BaseBubbleMenu>

      <Modal.Root opened={opened} onClose={handleClose} fullScreen closeOnEscape={false}>
        <Modal.Overlay />
        <Modal.Content style={{ overflow: "hidden" }}>
          <Modal.Body pos="relative">
            <LoadingOverlay visible={raster.isSaving} />
            <div style={{ height: "100vh" }}>
              <DrawIoEmbed
                ref={drawioRef}
                xml={initialXML}
                baseUrl={getDrawioUrl()}
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
    </>
  );
}

export default DrawioMenu;
