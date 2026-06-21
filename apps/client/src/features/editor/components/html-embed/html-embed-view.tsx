import { NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import clsx from "clsx";
import {
  ActionIcon,
  Button,
  Group,
  Modal,
  NumberInput,
  Text,
  Textarea,
} from "@mantine/core";
import { IconCode, IconEdit } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useAtomValue } from "jotai";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import classes from "./html-embed-view.module.css";
import {
  buildSandboxSrcdoc,
  canEdit as computeCanEdit,
  clampHeight,
  DEFAULT_IFRAME_HEIGHT,
  HTML_EMBED_SANDBOX,
  isTrustedHeightMessage,
  MAX_IFRAME_HEIGHT,
  MIN_IFRAME_HEIGHT,
  shouldRender as computeShouldRender,
} from "./html-embed-sandbox.ts";

export default function HtmlEmbedView(props: NodeViewProps) {
  const { t } = useTranslation();
  const { node, selected, updateAttributes, editor } = props;
  const { source, height } = node.attrs as {
    source: string;
    height: number | null;
  };

  // The HTML embed renders inside a SANDBOXED iframe (no same-origin access), so
  // the workspace toggle is a feature switch, not a security gate. When OFF (the
  // default) we render a neutral placeholder in the editor and nothing else.
  const workspace = useAtomValue(workspaceAtom);
  const htmlEmbedEnabled = workspace?.settings?.htmlEmbed === true;

  const shouldRender = computeShouldRender(
    editor.isEditable,
    htmlEmbedEnabled,
  );

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState<string>(source || "");
  const [draftHeight, setDraftHeight] = useState<number | "">(height ?? "");

  // True when the author pinned an explicit height; otherwise we auto-resize to
  // the iframe's reported content height.
  const hasFixedHeight = typeof height === "number" && Number.isFinite(height);

  // Auto-resize height tracked in state. Seeded to the default and updated from
  // the iframe's postMessage reports (see effect below) regardless of mode, so
  // switching a fixed-height embed back to auto immediately reflects the last
  // reported content height instead of staying pinned to the old fixed value.
  const [autoHeight, setAutoHeight] = useState<number>(DEFAULT_IFRAME_HEIGHT);

  const srcdoc = useMemo(() => buildSandboxSrcdoc(source || ""), [source]);

  // Auto-resize: accept height messages ONLY from this iframe's own content
  // window. The sandboxed srcdoc has an opaque ("null") origin, so we cannot
  // match by event.origin — we match by event.source instead. We track the
  // reported height even while a fixed height is in effect, so toggling back to
  // auto shows the current content height with no iframe reload.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!isTrustedHeightMessage(event, iframeRef.current)) return;
      const next = Number((event.data as { height?: number }).height);
      setAutoHeight(clampHeight(next));
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const effectiveHeight = hasFixedHeight ? clampHeight(height) : autoHeight;

  const openEditor = useCallback(() => {
    setDraft(source || "");
    setDraftHeight(height ?? "");
    setModalOpen(true);
  }, [source, height]);

  const onSave = useCallback(() => {
    if (editor.isEditable) {
      updateAttributes({
        source: draft,
        height: draftHeight === "" ? null : Number(draftHeight),
      });
    }
    setModalOpen(false);
  }, [draft, draftHeight, editor.isEditable, updateAttributes]);

  // The edit affordance is only meaningful in edit mode and is offered only when
  // the workspace master toggle is ON. Any member can edit (sandboxed = safe).
  const canEdit = computeCanEdit(editor.isEditable, htmlEmbedEnabled);

  return (
    <NodeViewWrapper
      data-drag-handle
      className={clsx(classes.htmlEmbedNodeView, {
        [classes.htmlEmbedSelected]: selected,
      })}
    >
      {canEdit && (
        <div className={classes.htmlEmbedToolbar}>
          <ActionIcon
            variant="default"
            size="sm"
            aria-label={t("Edit HTML embed")}
            onClick={openEditor}
          >
            <IconEdit size={16} />
          </ActionIcon>
        </div>
      )}

      {!shouldRender ? (
        // Feature disabled for this workspace AND we're in the editable editor:
        // render a neutral placeholder so an existing embed is visibly inert for
        // the author. Read-only / share viewers never hit this branch
        // (`shouldRender` is always true there) — they render exactly the
        // source the server chose to serve.
        <div className={classes.htmlEmbedPlaceholder}>
          <IconCode size={18} />
          <Text size="sm">
            {t("HTML embed is disabled in this workspace")}
          </Text>
        </div>
      ) : source ? (
        // Raw HTML/CSS/JS rendered inside a sandboxed iframe (no same-origin):
        // scripts run in an opaque origin and cannot touch the viewer's
        // session/cookies/API.
        <iframe
          ref={iframeRef}
          className={classes.htmlEmbedFrame}
          sandbox={HTML_EMBED_SANDBOX}
          srcDoc={srcdoc}
          title={t("HTML embed")}
          referrerPolicy="no-referrer"
          style={{ height: effectiveHeight }}
        />
      ) : canEdit ? (
        <div className={classes.htmlEmbedPlaceholder} onClick={openEditor}>
          <IconCode size={18} />
          <Text size="sm">{t("Click to add HTML / CSS / JS")}</Text>
        </div>
      ) : (
        // Empty source, non-editor: render nothing visible.
        <div className={classes.htmlEmbedContent} />
      )}

      <Modal
        opened={modalOpen}
        onClose={() => setModalOpen(false)}
        title={t("Edit HTML embed")}
        size="lg"
      >
        <Text size="xs" c="dimmed" mb="xs">
          {t(
            "This HTML/CSS/JS runs in a sandboxed frame and cannot access the viewer's session, cookies, or API.",
          )}
        </Text>
        <Textarea
          autosize
          minRows={10}
          maxRows={24}
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          placeholder={t("<script>...</script>")}
          styles={{ input: { fontFamily: "monospace" } }}
          data-autofocus
        />
        <NumberInput
          mt="md"
          label={t("Height (px, blank = auto)")}
          value={draftHeight}
          onChange={(value) =>
            setDraftHeight(
              value === "" || value === null ? "" : Number(value),
            )
          }
          min={MIN_IFRAME_HEIGHT}
          max={MAX_IFRAME_HEIGHT}
          allowDecimal={false}
        />
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={() => setModalOpen(false)}>
            {t("Cancel")}
          </Button>
          <Button onClick={onSave}>{t("Save")}</Button>
        </Group>
      </Modal>
    </NodeViewWrapper>
  );
}
